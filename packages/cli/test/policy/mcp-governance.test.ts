import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { DEFAULT_POLICY, PolicyV2Schema, stableStringify } from '@stroq/core';
import { buildMeta } from '../../src/attack/report.js';
import { policySha256 as liveDigest } from '../../src/live/policy-digest.js';
import { captureMcpPolicy } from '../../src/mcp/policy-continuity.js';
import { checkReport } from '../../src/policy/check.js';
import { formatCheck } from '../../src/policy/check-format.js';
import { policySha256 } from '../../src/policy/digest.js';
import { droppedProtections } from '../../src/policy/lint-dropped.js';
import { readPolicyFile } from '../../src/policy/load.js';
import { unknownFieldPaths } from '../../src/policy/unknown-fields.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const entry = { channel: 'claude-code', name: 'docs' };
const v2 = (allowed = [entry]) =>
  PolicyV2Schema.parse({
    ...DEFAULT_POLICY,
    version: 2,
    mcpGovernance: { allowed },
  });
function fixture(value: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'stroq-governance-policy-'));
  directories.push(home);
  const path = join(home, 'policy.yaml');
  const write = (next: unknown) => writeFileSync(path, stringify(next));
  write(value);
  return { home, path, write };
}

describe('MCP governance policy compatibility', () => {
  it('loads known v2 security fields and refuses unknown fields throughout the strict shape', () => {
    const f = fixture(v2());
    const read = readPolicyFile(f.path);
    expect(read).toMatchObject({ ok: true, unknownFields: [], policy: v2() });
    const bad = { ...v2(), mcpGovernance: { allowed: [{ ...entry, tool: '*' }], observe: true } };
    expect(unknownFieldPaths(bad)).toEqual([
      'mcpGovernance.observe',
      'mcpGovernance.allowed.0.tool',
    ]);
    f.write(bad);
    const refused = readPolicyFile(f.path);
    expect(refused).toMatchObject({ ok: false, problem: 'schema' });
    if (refused.ok || refused.problem === 'unreadable') throw new Error('expected schema refusal');
    const report = checkReport({ source: 'file', file: null }, refused);
    expect(report.loaded).toBe(false);
    expect(report.faults.length).toBeGreaterThan(0);
    expect(report.findings.every((finding) => !finding.message.includes('ignored'))).toBe(true);
  });

  it('does not let version1 silently ignore the security control', () => {
    const f = fixture({ ...v2(), version: 1 });
    expect(readPolicyFile(f.path)).toMatchObject({ ok: false, problem: 'schema' });
  });

  it('reports that static class checking did not replay reported server identity', () => {
    const f = fixture(v2());
    const read = readPolicyFile(f.path);
    if (!read.ok) throw new Error('expected v2');
    const report = checkReport({ source: 'file', file: null }, read);
    expect(report.policy?.mcpGovernance).toEqual({
      mode: 'enforce',
      allowedServers: 1,
      identityReplay: 'not-performed',
    });
    expect(formatCheck(report, 'fixture')).toContain('Reported MCP identities were not replayed');
    const legacy = checkReport(
      { source: 'default', file: null },
      { ok: true, policy: DEFAULT_POLICY, unknownFields: [] },
    );
    expect(legacy.policy).not.toHaveProperty('mcpGovernance');
  });

  it('does not credit a missing-identity refusal as preservation of existing allowed-server checks', () => {
    const dropped = {
      ...v2(),
      rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== 'ask-mcp-side-effect-when-tainted'),
    };
    expect(droppedProtections(dropped)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dropped-protection', class: 'mcp.side_effect' }),
      ]),
    );
    expect(droppedProtections(v2())).toEqual([]);
  });
});

describe('MCP governance canonical identity and proxy continuity', () => {
  it('includes every governance pair while all digest producers retain legacy semantics', () => {
    const variants = [
      DEFAULT_POLICY,
      v2(),
      v2([]),
      v2([{ ...entry, name: 'Docs' }]),
      v2([{ ...entry, channel: 'codex' }]),
    ];
    expect(new Set(variants.map(policySha256)).size).toBe(variants.length);
    for (const policy of variants) {
      expect(policySha256(policy)).toBe(liveDigest(policy));
      expect(
        buildMeta({ policy, policySource: 'fixture', corpusId: 'fixture', scenarios: [] }).policy
          .sha256,
      ).toBe(policySha256(policy));
      expect(policySha256(policy)).toBe(
        createHash('sha256').update(stableStringify(policy)).digest('hex'),
      );
    }
    const { mcpGovernance, ...rest } = v2();
    const reordered = PolicyV2Schema.parse({
      mcpGovernance: {
        allowed: mcpGovernance.allowed.map(({ name, channel }) => ({ name, channel })),
      },
      ...rest,
    });
    expect(policySha256(reordered)).toBe(policySha256(v2()));
  });

  it('latches changed governance until proxy restart and ignores harmless YAML formatting', () => {
    const f = fixture(v2());
    const captured = captureMcpPolicy(f.home);
    expect(captured.continuity.check()).toBe('current');
    writeFileSync(f.path, `# owned comment\n${stringify(v2())}`);
    expect(captured.continuity.check()).toBe('current');
    f.write(v2([]));
    expect(captured.continuity.check()).toBe('changed');
    f.write(v2());
    expect(captured.continuity.check()).toBe('changed');
    expect(captureMcpPolicy(f.home).continuity.check()).toBe('current');
  });

  it('latches unavailable on a new unknown security field instead of dropping it', () => {
    const f = fixture(v2());
    const captured = captureMcpPolicy(f.home);
    f.write({ ...v2(), mcpGovernance: { allowed: [entry], observe: true } });
    expect(captured.continuity.check()).toBe('unavailable');
    f.write(v2());
    expect(captured.continuity.check()).toBe('unavailable');
  });
});
