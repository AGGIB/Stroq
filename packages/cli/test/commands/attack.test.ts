import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { displayPath, runAttackCommand } from '../../src/commands/attack.js';
import type { FuzzReport } from '../../src/attack/fuzz.js';

// A mutable hoisted handle the mocked `runFuzz` below can read on every call. Left
// null, the mock is a transparent pass-through to the real fuzzer — every existing
// test still runs the real 350-variant corpus. Only the escape/exit-code test sets
// it, and only for the duration of that one test.
const fuzzState = vi.hoisted(() => ({ forcedReport: null as FuzzReport | null }));

// `runAttackCommand`'s --fuzz path has no seam for injecting a report: it always
// builds one from the real corpus and the real policy. Mocking `runFuzz` at the
// module boundary — rather than adding an export, parameter, or DI hook to
// production code just to make this testable — lets this test construct a report
// with a known escape and drive it straight through the exit-code branch the
// comment below is guarding, without touching attack.ts or fuzz.ts.
vi.mock('../../src/attack/fuzz.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/attack/fuzz.js')>();
  return {
    ...actual,
    runFuzz: async (...args: Parameters<typeof actual.runFuzz>) =>
      fuzzState.forcedReport ?? actual.runFuzz(...args),
  };
});

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
  it('--fuzz exits 0 on the real corpus, which has zero escapes', async () => {
    const out = capture();
    const code = await runAttackCommand(['--fuzz']);
    out.restore();
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('stroq attack --fuzz:');
  }, 120_000);

  // The corpus test above no longer contrasts with anything: it exits 0 because the
  // real corpus has no escapes left, so nothing here proves the exit-1 branch in
  // runAttackCommand (`report.ok ? 0 : 1`) still works — a flipped condition would
  // pass unnoticed. This test restores that contrast by forcing `runFuzz` (mocked
  // above) to return a report with a genuine escape, independent of what the corpus
  // currently finds, so a broken exit-code branch is still caught even after every
  // real escape is closed. It is also, now that `--allow-escapes` is gone, the only
  // thing proving the gate can fail at all.
  it('--fuzz exits 1 when the report carries an escape', async () => {
    fuzzState.forcedReport = {
      version: 1,
      policy: 'default',
      scenarios: 1,
      mutations: 1,
      variants: 1,
      survived: 0,
      escaped: [
        {
          scenarioId: 'fixture-scenario',
          mutationId: 'fixture-mutation',
          preserving: true,
          outcome: 'passed',
          ruleId: null,
          error: null,
        },
      ],
      recorded: [],
      errored: [],
      notApplicable: 0,
      textless: [],
      ok: false,
    };
    try {
      const out = capture();
      const code = await runAttackCommand(['--fuzz']);
      out.restore();
      expect(code).toBe(1);
      expect(out.lines.join('')).toContain('fixture-scenario');
    } finally {
      fuzzState.forcedReport = null;
    }
  });
});

describe('displayPath', () => {
  it('shortens a path under a fake HOME to ~/..., for the JSON report to avoid leaking it', () => {
    // `homedir()` reads HOME on POSIX and USERPROFILE on Windows, so both are set,
    // to a path that is absolute on this platform.
    const previous = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
    const fake = resolve('/Users/fakeuser');
    process.env['HOME'] = fake;
    process.env['USERPROFILE'] = fake;
    try {
      expect(displayPath(join(fake, '.stroq', 'policy.yaml'))).toBe('~/.stroq/policy.yaml');
      expect(displayPath(fake)).toBe('~');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
