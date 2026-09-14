import { describe, expect, it, vi } from 'vitest';
import { displayPath, runAttackCommand } from '../../src/commands/attack.js';

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
    expect(text).toContain('stroq attack: 20 recorded incidents against policy default');
    expect(text).toContain(
      '20 scenarios: 15 blocked, 5 asked, 0 passed through — every attack was stopped.',
    );
    expect(text.match(/^✔ /gm)).toHaveLength(20);
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
    expect(report.scenarios).toHaveLength(20);
    expect(report.totals).toEqual({ blocked: 15, asked: 5, passed: 0 });
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

  // Runs the real mutation fuzzer (350 variants) through the actual engine, so it is
  // slow — but this is the exact path CI's fuzz-gate step depends on, and a renamed
  // flag or a flipped condition here would silently turn that gate into a no-op with
  // no other test catching it.
  it('--fuzz exits 1 on the real corpus, which is known to still have escapes', async () => {
    const out = capture();
    const code = await runAttackCommand(['--fuzz']);
    out.restore();
    expect(code).toBe(1);
    expect(out.lines.join('')).toContain('stroq attack --fuzz:');
  }, 120_000);

  it('--fuzz --allow-escapes exits 0 despite those same known escapes', async () => {
    const out = capture();
    const code = await runAttackCommand(['--fuzz', '--allow-escapes']);
    out.restore();
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('stroq attack --fuzz:');
  }, 120_000);
});

describe('displayPath', () => {
  it('shortens a path under a fake HOME to ~/..., for the JSON report to avoid leaking it', () => {
    const previousHome = process.env['HOME'];
    process.env['HOME'] = '/Users/fakeuser';
    try {
      expect(displayPath('/Users/fakeuser/.stroq/policy.yaml')).toBe('~/.stroq/policy.yaml');
      expect(displayPath('/Users/fakeuser')).toBe('~');
    } finally {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
    }
  });

  it('leaves non-home paths and the "default" sentinel untouched', () => {
    const previousHome = process.env['HOME'];
    process.env['HOME'] = '/Users/fakeuser';
    try {
      expect(displayPath('default')).toBe('default');
      expect(displayPath('/etc/stroq/policy.yaml')).toBe('/etc/stroq/policy.yaml');
      expect(displayPath('/Users/fakeuser2/policy.yaml')).toBe('/Users/fakeuser2/policy.yaml');
    } finally {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
    }
  });
});
