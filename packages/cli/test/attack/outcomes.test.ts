import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@stroq/core';
import {
  runAttack,
  runScenario,
  totalsOf,
  type Outcome,
  type ScenarioResult,
} from '../../src/attack/run.js';
import { SESSION_ID, type Scenario, type ScenarioStep } from '../../src/attack/scenario.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

// When `expired` is set, every engine this file's runs build reads each command under a reading
// deadline that has already passed: the only way to have the clock stop a reading in a test, since
// waiting out eight seconds is not one. Left unset, the factory is the real one.
const clock = vi.hoisted(() => ({ expired: false }));
vi.mock('../../src/engine-factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine-factory.js')>();
  const { withDeadline } = await import('../../../core/src/actions/deadline.js');
  return {
    ...actual,
    createEngineAt: (...args: Parameters<typeof actual.createEngineAt>) => {
      const real = actual.createEngineAt(...args);
      if (!clock.expired) return real;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'pre') {
            return (event: Parameters<typeof real.pre>[0]) =>
              withDeadline(
                -1,
                () => target.pre(event),
                () => Promise.reject(new Error('the deadline passed outside the classifier')),
              );
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

const AXES = {
  incident: null,
  class: 'outcome probe',
  origin: 'direct-user',
  encoding: 'plain',
  effect: 'exec',
  atlas: ['AML.T0050'],
  asi: [],
} as const;

const probe = (id: string, steps: readonly [ScenarioStep, ...ScenarioStep[]]): Scenario => ({
  id,
  title: `probe: ${id}`,
  ...AXES,
  steps,
});

const bash = (command: string, expect: ScenarioStep['expect']): ScenarioStep => ({
  event: {
    session_id: SESSION_ID,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '__CWD__',
  },
  expect,
});

const readOf = (content: string, expect: ScenarioStep['expect']): ScenarioStep => ({
  event: {
    session_id: SESSION_ID,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '__CWD__/README.md' },
    cwd: '__CWD__',
    tool_response: { type: 'text', file: { filePath: '__CWD__/README.md', content } },
  },
  expect,
});

const byId = (id: string): Scenario => {
  const found = SCENARIOS.find((s) => s.id.startsWith(id));
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
};

/** A scan budget no scan can meet; `Number('0.000001')` is a valid, positive, one-nanosecond budget. */
const TINY_BUDGET = '0.000001';
const LONG_COMMAND = Array.from({ length: 200 }, (_, i) => `echo ${i} | cat; ls ${i}`).join('\n');
const TOO_LARGE_COMMAND = 'echo x;'.repeat(100_000);

const ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP', 'STROQ_SCAN_BUDGET_MS'];
const savedEnv: Record<string, string | undefined> = {};
let testTmpDir: string;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  testTmpDir = mkdtempSync(join(tmpdir(), 'stroq-outcomes-'));
  process.env['TMPDIR'] = testTmpDir;
  process.env['TMP'] = testTmpDir;
  process.env['TEMP'] = testTmpDir;
  clock.expired = false;
});

afterEach(() => {
  clock.expired = false;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testTmpDir, { recursive: true, force: true });
});

describe('a scan that runs out of its budget', () => {
  it('is blocked when it is in time (the control)', async () => {
    const r = await runScenario(byId('01'), DEFAULT_POLICY);
    expect(r.outcome).toBe('blocked');
    expect(r.inconclusive).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.ok).toBe(true);
  });

  it('is a timeout, not a block, although the fail-closed answer is the one the scenario expects', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = TINY_BUDGET;
    const r = await runScenario(byId('01'), DEFAULT_POLICY);
    const [read, attack] = r.steps;
    // What used to pass for a defence: the budget's `suspect` is the verdict the scenario expects
    // of the README, the session is tainted by it, and the later attack is denied for that.
    expect(read).toMatchObject({
      phase: 'post',
      expect: 'suspect',
      actual: 'suspect',
      timedOut: true,
    });
    expect(attack).toMatchObject({ phase: 'pre', expect: 'deny', actual: 'deny' });
    expect(r.outcome).toBe('timeout');
    expect(r.inconclusive).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('step 1 (post Read)');
    expect(r.reason).toContain('time budget');
    expect(readdirSync(testTmpDir)).toEqual([]);
  });

  it('is counted as a timeout and fails the report', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = TINY_BUDGET;
    const report = await runAttack([byId('01')], DEFAULT_POLICY, 'default');
    expect(report.totals).toMatchObject({ blocked: 0, timeout: 1, inconclusive: 1, passed: 0 });
    expect(report.ok).toBe(false);
  });

  it('keeps an attack that got through as passed, however the earlier step went', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = TINY_BUDGET;
    const scenario = probe('99-timeout-then-pass', [
      readOf('An ordinary paragraph of documentation.', 'clean'),
      bash('ls', 'deny'),
    ]);
    const r = await runScenario(scenario, DEFAULT_POLICY);
    expect(r.outcome).toBe('passed');
    expect(r.inconclusive).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('time budget');
  });
});

describe('a reading that runs past its deadline', () => {
  const asked = probe('99-reading-deadline', [bash(LONG_COMMAND, 'ask')]);

  it('is not asked about when it is read in time (the control)', async () => {
    const r = await runScenario(asked, DEFAULT_POLICY);
    expect(r.outcome).toBe('passed');
  });

  it('is a timeout, not an ask, although an ask is what the scenario expects', async () => {
    clock.expired = true;
    const r = await runScenario(asked, DEFAULT_POLICY);
    expect(r.steps[0]).toMatchObject({
      expect: 'ask',
      actual: 'ask',
      ruleId: 'ask-shell-unparsed',
    });
    expect(r.steps[0]?.signals).toEqual(['reading-took-too-long']);
    expect(r.outcome).toBe('timeout');
    expect(r.inconclusive).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('step 1 (pre Bash)');
    expect(r.reason).toContain('deadline');
  });
});

describe('a command too large to read', () => {
  const tooLarge = probe('99-too-large', [bash(TOO_LARGE_COMMAND, 'ask')]);

  it('is asked at a limit: a result the policy gives for the same input on every machine', async () => {
    const r = await runScenario(tooLarge, DEFAULT_POLICY);
    expect(r.steps[0]?.signals).toEqual(['command-too-large']);
    expect(r.outcome).toBe('asked-by-limit');
    expect(r.ruleId).toBe('ask-shell-unparsed');
    expect(r.inconclusive).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.ok).toBe(true);
  });

  it('is counted as askedByLimit, and not as asked', async () => {
    const report = await runAttack([tooLarge, byId('08')], DEFAULT_POLICY, 'default');
    expect(report.totals).toMatchObject({ asked: 1, askedByLimit: 1, passed: 0, inconclusive: 0 });
    expect(report.ok).toBe(true);
  });

  it('is still wrong when the scenario expected a deny: a limit asks, it does not deny', async () => {
    const r = await runScenario(
      probe('99-too-large-deny', [bash(TOO_LARGE_COMMAND, 'deny')]),
      DEFAULT_POLICY,
    );
    expect(r.outcome).toBe('asked-by-limit');
    expect(r.ok).toBe(false);
    expect(r.inconclusive).toBe(false);
  });
});

describe('a step that throws', () => {
  const malformed = probe('99-malformed', [
    { ...bash('ls', 'ask'), event: { ...bash('ls', 'ask').event, tool_name: '' } },
    bash('ls', 'deny'),
  ]);

  it('is the error of its scenario, with the context, and the later steps are not run', async () => {
    const r = await runScenario(malformed, DEFAULT_POLICY);
    expect(r.outcome).toBe('error');
    expect(r.inconclusive).toBe(true);
    expect(r.ok).toBe(false);
    // The tool name is the empty string that makes the event malformed, so the label shows none.
    expect(r.reason).toMatch(/^scenario 99-malformed step 1 \(PreToolUse \): /);
    expect(r.reason).toContain('tool_name');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.error).toBe(r.reason);
    expect(readdirSync(testTmpDir)).toEqual([]);
  });

  it('does not stop the run: the other scenarios are run and the report is not ok', async () => {
    const report = await runAttack([malformed, byId('01'), byId('08')], DEFAULT_POLICY, 'default');
    expect(report.scenarios.map((r) => [r.id.slice(0, 2), r.outcome])).toEqual([
      ['99', 'error'],
      ['01', 'blocked'],
      ['08', 'asked'],
    ]);
    expect(report.totals).toMatchObject({ blocked: 1, asked: 1, error: 1, inconclusive: 1 });
    expect(report.ok).toBe(false);
  });

  it('still refuses a scenario that is wrong in how it is written (a mistake in the corpus)', async () => {
    const noAttack = probe('99-no-attack', [readOf('x', 'clean')]);
    await expect(runScenario(noAttack, DEFAULT_POLICY)).rejects.toThrow('99-no-attack');
    const allowed = probe('99-allow', [bash('ls', 'allow')]);
    await expect(runScenario(allowed, DEFAULT_POLICY)).rejects.toThrow(
      'the attack step must be expected to be denied or asked',
    );
    expect(readdirSync(testTmpDir)).toEqual([]);
  });
});

describe('the totals', () => {
  const OUTCOMES: readonly Outcome[] = [
    'blocked',
    'asked',
    'asked-by-limit',
    'passed',
    'timeout',
    'error',
  ];

  it('count each scenario once, in the bucket of its outcome, in a run that has all six', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = TINY_BUDGET;
    const scenarios = [
      byId('03'), // blocked: a call, no scan to run out of
      byId('08'), // asked
      probe('99-too-large', [bash(TOO_LARGE_COMMAND, 'ask')]), // asked at a limit
      probe('99-allowed', [bash('ls', 'deny')]), // passed
      byId('01'), // the scan runs out: timeout
      probe('99-malformed', [
        { ...bash('ls', 'ask'), event: { ...bash('ls', 'ask').event, tool_name: '' } },
      ]), // error
    ];
    const report = await runAttack(scenarios, DEFAULT_POLICY, 'default');
    // The scenarios above are listed in the order of OUTCOMES, one for each.
    expect(report.scenarios.map((r) => r.outcome)).toEqual(OUTCOMES);
    expect(report.totals).toEqual({
      blocked: 1,
      asked: 1,
      askedByLimit: 1,
      passed: 1,
      timeout: 1,
      error: 1,
      inconclusive: 2,
    });
    const { blocked, asked, askedByLimit, passed, timeout, error } = report.totals;
    expect(blocked + asked + askedByLimit + passed + timeout + error).toBe(scenarios.length);
    expect(report.ok).toBe(false);
  });

  const result = (outcome: Outcome, inconclusive = false): ScenarioResult => ({
    id: `00-${outcome}`,
    title: outcome,
    incident: null,
    class: 'probe',
    outcome,
    inconclusive,
    reason: inconclusive ? 'because' : null,
    ok: !inconclusive,
    ruleId: null,
    steps: [],
  });

  it.each([
    [[]],
    [['blocked']],
    [['blocked', 'blocked', 'asked', 'asked-by-limit']],
    [['timeout', 'error', 'timeout']],
    [['blocked', 'asked', 'asked-by-limit', 'passed', 'timeout', 'error']],
  ] as const)('add up to the number of scenarios: %j', (outcomes) => {
    const totals = totalsOf(outcomes.map((o) => result(o, o === 'timeout' || o === 'error')));
    const sum =
      totals.blocked +
      totals.asked +
      totals.askedByLimit +
      totals.passed +
      totals.timeout +
      totals.error;
    expect(sum).toBe(outcomes.length);
    expect(totals.inconclusive).toBe(totals.timeout + totals.error);
  });

  it('count an inconclusive scenario that also passed in both places', () => {
    const totals = totalsOf([result('passed', true)]);
    expect(totals).toMatchObject({ passed: 1, inconclusive: 1, timeout: 0, error: 0 });
  });
});

describe('ok', () => {
  it('is true when every scenario was decided or asked at a limit, as expected', async () => {
    const report = await runAttack(
      [byId('01'), probe('99-too-large', [bash(TOO_LARGE_COMMAND, 'ask')])],
      DEFAULT_POLICY,
      'default',
    );
    expect(report.ok).toBe(true);
  });

  it('is false for a pass alone', async () => {
    const report = await runAttack(
      [probe('99-allowed', [bash('ls', 'deny')])],
      DEFAULT_POLICY,
      'default',
    );
    expect(report.totals).toMatchObject({ passed: 1, inconclusive: 0 });
    expect(report.ok).toBe(false);
  });

  it('is false for an inconclusive scenario alone, though every scenario that was decided is right', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = TINY_BUDGET;
    const report = await runAttack([byId('01'), byId('08')], DEFAULT_POLICY, 'default');
    expect(report.totals).toMatchObject({ passed: 0, inconclusive: 1 });
    expect(report.scenarios.filter((r) => r.ok && !r.inconclusive)).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it('is false for a scenario that was decided otherwise than expected, though none passed', async () => {
    const report = await runAttack(
      [probe('99-expects-deny', [bash('bash -c "$X"', 'deny')])],
      DEFAULT_POLICY,
      'default',
    );
    expect(report.scenarios[0]).toMatchObject({ outcome: 'asked', ok: false, inconclusive: false });
    expect(report.totals).toMatchObject({ passed: 0, inconclusive: 0 });
    expect(report.ok).toBe(false);
  });
});
