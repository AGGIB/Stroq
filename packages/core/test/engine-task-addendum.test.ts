import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit-log.js';
import { StroqEngine } from '../src/engine.js';
import { DEFAULT_POLICY } from '../src/policy/default-policy.js';
import { loadBundledRules } from '../src/rules/bundle.js';
import { FileSessionStore } from '../src/taint/session-store.js';

/**
 * An indirect prompt injection arrives inside a record an MCP server returns, and the call it asks for
 * is an MCP call: `mcp__<domain>__<tool>` with the tool's own arguments. Stroq reads the record, and
 * asks about the call that follows it. The fixture is a 40-record sample of the NVIDIA data
 * (Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1, NVIDIA, CC BY 4.0) with the record that holds the
 * injection, the call the attacker wanted and, to prove the rule leaves a clean record alone, the same
 * record with the injection taken out.
 */
interface Sample {
  readonly id: number;
  readonly half: 'dev' | 'held';
  readonly template: 'priority' | 'urgent';
  readonly domain: string;
  readonly readTool: string;
  readonly targetTool: string;
  readonly targetArgs: Record<string, unknown>;
  readonly injectionText: string;
  readonly environment: unknown;
}
const fixture = JSON.parse(
  readFileSync(new URL('./rules/fixtures/nemotron-ipi-sample.json', import.meta.url), 'utf8'),
) as { source: string; records: Sample[] };

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function session() {
  const home = mkdtempSync(join(tmpdir(), 'stroq-ipi-'));
  directories.push(home);
  return new StroqEngine({
    rules: loadBundledRules(),
    policy: DEFAULT_POLICY,
    sessions: new FileSessionStore(join(home, 'sessions')),
    audit: new AuditLog(join(home, 'audit.jsonl')),
  });
}
const cwd = '/work/clinic';
const strip = (value: unknown, text: string): unknown =>
  JSON.parse(JSON.stringify(value).split(JSON.stringify(text).slice(1, -1)).join(''));

describe('an instruction smuggled into an MCP record', () => {
  it('names its source', () => {
    expect(fixture.source).toBe(
      'Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1, NVIDIA, CC BY 4.0',
    );
    expect(fixture.records).toHaveLength(40);
  });

  for (const r of fixture.records) {
    it(`${r.template} #${r.id} (${r.half}): the record taints the session and ${r.targetTool} is asked about`, async () => {
      const engine = session();
      const readInput = { id: String(r.id) };
      const readName = `mcp__${r.domain}__${r.readTool}`;
      await engine.pre({ sessionId: 's', toolName: readName, toolInput: readInput, cwd });
      const read = await engine.post({
        sessionId: 's',
        toolName: readName,
        toolInput: readInput,
        toolResultText: JSON.stringify(r.environment),
        cwd,
      });
      expect(read.scan.verdict).toBe('suspect');
      expect(read.scan.matches.map((m) => m.ruleId)).toContain('STROQ-2026-00014');
      const act = await engine.pre({
        sessionId: 's',
        toolName: `mcp__${r.domain}__${r.targetTool}`,
        toolInput: r.targetArgs,
        cwd,
      });
      expect(act.classes).toContain('mcp.side_effect');
      expect(act.decision).toMatchObject({
        effect: 'ask',
        ruleId: 'ask-mcp-side-effect-when-tainted',
      });
    });

    it(`${r.template} #${r.id} (${r.half}): the same record without the injection is clean and the call is allowed`, async () => {
      const engine = session();
      const readName = `mcp__${r.domain}__${r.readTool}`;
      const clean = strip(r.environment, r.injectionText);
      const read = await engine.post({
        sessionId: 's',
        toolName: readName,
        toolInput: { id: String(r.id) },
        toolResultText: JSON.stringify(clean),
        cwd,
      });
      expect(read.scan.verdict).toBe('clean');
      const act = await engine.pre({
        sessionId: 's',
        toolName: `mcp__${r.domain}__${r.targetTool}`,
        toolInput: r.targetArgs,
        cwd,
      });
      expect(act.decision.effect).toBe('allow');
    });
  }
});
