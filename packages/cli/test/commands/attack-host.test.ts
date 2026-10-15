import { describe, expect, it, vi } from 'vitest';
import { runAttackCommand } from '../../src/commands/attack.js';

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('stroq attack --host', () => {
  it('refuses combining host visibility with a fuzzer that cannot account for it', async () => {
    const out = capture();
    const code = await runAttackCommand(['--only', '01', '--host', 'mcp', '--fuzz']);
    out.restore();
    expect(code).toBe(2);
    expect(out.lines.join('')).toContain('--host cannot be combined with --fuzz');
    expect(out.lines.join('')).not.toContain('no escapes');
  });

  it.each([
    ['codex', '01'],
    ['windsurf', '04'],
    ['antigravity', '04'],
  ])('does not scan invisible precursors or count them as protection on %s', async (host, only) => {
    const out = capture();
    const code = await runAttackCommand(['--only', only, '--host', host, '--json']);
    out.restore();
    const report = JSON.parse(out.lines.join(''));
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.totals).toMatchObject({ blocked: 0, asked: 0, unsupportedScenarios: 1 });
    expect(report.scenarios[0]).toMatchObject({
      outcome: 'unsupported',
      unsupportedSteps: [1],
      steps: [
        expect.objectContaining({ actual: null, ruleId: null, supported: false }),
        expect.anything(),
      ],
    });
  });

  it('does not run or count an invisible final attack step', async () => {
    const out = capture();
    const code = await runAttackCommand(['--only', '05', '--host', 'mcp', '--json']);
    out.restore();
    const report = JSON.parse(out.lines.join(''));
    expect(code).toBe(1);
    expect(report.totals).toMatchObject({ blocked: 0, asked: 0, unsupportedScenarios: 1 });
    expect(report.scenarios[0].outcome).toBe('unsupported');
    expect(report.scenarios[0].steps[0].actual).toBeNull();
  });

  it('rejects an empty host instead of silently running without visibility checks', async () => {
    const out = capture();
    const code = await runAttackCommand(['--only', '01', '--host=']);
    out.restore();
    expect(code).toBe(1);
    expect(out.lines.join('')).toContain('unknown host ""');
  });

  it('preserves exact baseline numbers when --host is omitted', async () => {
    const out = capture();
    const code = await runAttackCommand(['--only', '01']);
    out.restore();
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).not.toContain('unsupported');
    expect(text).toContain('1 scenario: 1 blocked, 0 asked, 0 passed through');
  });

  it('runs cleanly on claude-code with 0 unsupported steps', async () => {
    const out = capture();
    const code = await runAttackCommand(['--only', '01', '--host', 'claude-code']);
    out.restore();
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('1 scenario: 1 blocked, 0 asked, 0 passed through');
    expect(text).not.toContain('unsupported');
  });

  it('reports unsupported steps and exits 1 when evaluated against a host that cannot see them', async () => {
    // Scenario 05 (roguepilot) step 1 is WebFetch, which codex cannot see
    const out = capture();
    const code = await runAttackCommand(['--only', '05', '--host', 'codex']);
    out.restore();
    expect(code).toBe(1);
    const text = out.lines.join('');
    expect(text).toContain('unsupported');
    expect(text).toContain('host codex');
    expect(text).toContain('unsupported on host: step 1 (web fetch)');
  });

  it('detects unsupported shell commands on mcp proxy host', async () => {
    // Scenario 01 step 2 is Bash, which mcp proxy cannot see
    const out = capture();
    const code = await runAttackCommand(['--only', '01', '--host', 'mcp']);
    out.restore();
    expect(code).toBe(1);
    const text = out.lines.join('');
    expect(text).toContain('unsupported on host: step 1 (tool result), step 2 (shell command)');
    expect(text).toContain('host mcp');
  });

  it('includes host and unsupported accounting in --json output', async () => {
    const out = capture();
    const code = await runAttackCommand(['--only', '05', '--host', 'codex', '--json']);
    out.restore();
    expect(code).toBe(1);
    const report = JSON.parse(out.lines.join('')) as {
      host: string;
      ok: boolean;
      totals: {
        unsupportedSteps?: number;
        unsupportedScenarios?: number;
      };
      scenarios: Array<{
        id: string;
        ok: boolean;
        host?: string;
        unsupportedSteps?: number[];
        steps: Array<{
          channel?: string;
          supported?: boolean;
          supportStatus?: string;
        }>;
      }>;
    };
    expect(report.host).toBe('codex');
    expect(report.ok).toBe(false);
    expect(report.totals.unsupportedSteps).toBe(1);
    expect(report.totals.unsupportedScenarios).toBe(1);
    expect(report.scenarios[0]?.unsupportedSteps).toEqual([1]);
    expect(report.scenarios[0]?.steps[0]?.channel).toBe('web fetch');
    expect(report.scenarios[0]?.steps[0]?.supported).toBe(false);
    expect(report.scenarios[0]?.steps[0]?.supportStatus).toBe('not seen');
  });

  it('rejects an unknown host with a helpful message listing known hosts', async () => {
    const out = capture();
    const code = await runAttackCommand(['--host', 'invalid-agent']);
    out.restore();
    expect(code).toBe(1);
    const text = out.lines.join('');
    expect(text).toContain('unknown host "invalid-agent"');
    expect(text).toContain('claude-code');
    expect(text).toContain('cursor');
    expect(text).toContain('codex');
    expect(text).toContain('antigravity');
  });
});
