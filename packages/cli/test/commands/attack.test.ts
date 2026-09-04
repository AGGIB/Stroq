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

describe('stroq attack', () => {
  it('runs the suite against the default policy and exits 0', async () => {
    const out = capture();
    const code = await runAttackCommand([]);
    out.restore();
    expect(code).toBe(0);
    const text = out.lines.join('');
    expect(text).toContain('stroq attack: 12 recorded incidents against policy default');
    expect(text).toContain(
      '12 scenarios: 8 blocked, 4 asked, 0 passed through — every attack was stopped.',
    );
    expect(text.match(/^✔ /gm)).toHaveLength(12);
  }, 60_000);

  it('prints a JSON document with --json', async () => {
    const out = capture();
    const code = await runAttackCommand(['--json']);
    out.restore();
    expect(code).toBe(0);
    const report = JSON.parse(out.lines.join('')) as {
      version: number;
      ok: boolean;
      scenarios: unknown[];
      totals: unknown;
    };
    expect(report.version).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.scenarios).toHaveLength(12);
    expect(report.totals).toEqual({ blocked: 8, asked: 4, passed: 0 });
  }, 60_000);

  it('runs a single scenario with --only, by id or number', async () => {
    let out = capture();
    expect(await runAttackCommand(['--only', '05-roguepilot-schema-url'])).toBe(0);
    out.restore();
    expect(out.lines.join('')).toContain('1 scenario: 1 blocked, 0 asked, 0 passed through');
    out = capture();
    expect(await runAttackCommand(['--only', '08'])).toBe(0);
    out.restore();
    expect(out.lines.join('')).toContain('08-rm-rf-home');
  });

  it('fails with the list of ids when --only matches nothing', async () => {
    const out = capture();
    expect(await runAttackCommand(['--only', 'nope'])).toBe(1);
    out.restore();
    expect(out.lines.join('')).toContain('no scenario matches "nope"');
    expect(out.lines.join('')).toContain('01-readme-pipe-to-shell');
  });
});
