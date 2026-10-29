import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(text).toContain(
      'stroq attack: 36 scenarios against policy default (26 from public reports, 10 synthetic)',
    );
    expect(text).toContain(
      '36 scenarios: 15 blocked, 21 asked, 0 passed through — each was blocked or put to you as a question.',
    );
    expect(text.match(/^✔ /gm)).toHaveLength(36);
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
    expect(report.version).toBe(2);
    expect(report.ok).toBe(true);
    expect(report.scenarios).toHaveLength(36);
    expect(report.totals).toEqual({
      blocked: 15,
      asked: 21,
      askedByLimit: 0,
      passed: 0,
      timeout: 0,
      error: 0,
      inconclusive: 0,
    });
  }, 60_000);

  it('filters by host with --host and reports unsupported steps', async () => {
    const out = capture();
    const code = await runAttackCommand(['--host', 'windsurf', '--json', '--only', '05']);
    out.restore();
    expect(code).toBe(1);
    const report = JSON.parse(out.lines.join('')) as {
      version: number;
      ok: boolean;
      host: string;
      totals: { unsupported?: number; unsupportedSteps?: number };
      unsupportedSteps?: unknown[];
    };
    expect(report.ok).toBe(false);
    expect(report.host).toBe('windsurf');
    expect(report.totals.unsupportedSteps).toBeGreaterThan(0);
    expect(report.unsupportedSteps).toBeDefined();
    expect(report.unsupportedSteps!.length).toBeGreaterThan(0);
  }, 60_000);

  it('rejects an unknown --host with exit 2', async () => {
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const code = await runAttackCommand(['--host', 'nonexistent-host']);
    spy.mockRestore();
    expect(code).toBe(2);
    expect(err.join('')).toContain('unknown --host "nonexistent-host"');
  });

  it('refuses --host combined with --fuzz with exit 2', async () => {
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const code = await runAttackCommand(['--host', 'cursor', '--fuzz']);
    spy.mockRestore();
    expect(code).toBe(2);
    expect(err.join('')).toContain('--host cannot be combined with --fuzz');
  });

  // The exit code is what CI reads. A run that could not judge a scenario is not a run that
  // passed, and an attack that got through is not either: both are 1, whatever else came out right.
  describe('exit code', () => {
    const saved: Record<string, string | undefined> = {};
    const setEnv = (key: string, value: string): void => {
      if (!(key in saved)) saved[key] = process.env[key];
      process.env[key] = value;
    };
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        delete saved[key];
      }
    });

    it('is 1 when a scan runs out of its budget, and the report says what could not be judged', async () => {
      setEnv('STROQ_SCAN_BUDGET_MS', '0.000001');
      const out = capture();
      const code = await runAttackCommand(['--json']);
      out.restore();
      expect(code).toBe(1);
      const report = JSON.parse(out.lines.join('')) as {
        ok: boolean;
        totals: { passed: number; timeout: number; inconclusive: number };
      };
      expect(report.ok).toBe(false);
      expect(report.totals.passed).toBe(0);
      expect(report.totals.timeout).toBeGreaterThan(0);
      expect(report.totals.inconclusive).toBe(report.totals.timeout);
    }, 60_000);

    it('prints the inconclusive scenarios as such', async () => {
      setEnv('STROQ_SCAN_BUDGET_MS', '0.000001');
      const out = capture();
      const code = await runAttackCommand(['--only', '01']);
      out.restore();
      expect(code).toBe(1);
      const text = out.lines.join('');
      expect(text).toMatch(/\? 01-readme-pipe-to-shell\s+timeout/);
      expect(text).toContain('1 scenario could not be judged');
      expect(text).not.toContain('each was blocked or put to you as a question');
    });

    it('is 1 when an attack passes through, and 0 for the same scenario under the default policy', async () => {
      const home = mkdtempSync(join(tmpdir(), 'stroq-attack-open-home-'));
      try {
        writeFileSync(join(home, 'policy.yaml'), 'version: 1\nrules: []\n');
        setEnv('STROQ_HOME', home);
        let out = capture();
        const open = await runAttackCommand(['--only', '08', '--json']);
        out.restore();
        expect(open).toBe(1);
        const report = JSON.parse(out.lines.join('')) as { totals: { passed: number } };
        expect(report.totals.passed).toBe(1);

        rmSync(join(home, 'policy.yaml'));
        out = capture();
        const standard = await runAttackCommand(['--only', '08']);
        out.restore();
        expect(standard).toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

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
      version: 2,
      meta: {
        stroq: '0.0.0-test',
        policy: { source: 'default', sha256: '0'.repeat(64) },
        host: { id: 'claude-code', version: null, mode: 'in-process' },
        tools: [],
        sandbox: null,
        corpus: { id: 'attack-scenarios', sha256: '0'.repeat(64), count: 1 },
        budget: { variants: 1, seed: null },
      },
      policy: 'default',
      scenarios: 1,
      mutations: 1,
      variants: 1,
      survived: 0,
      survivedByLimit: 0,
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
      inconclusive: [],
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
