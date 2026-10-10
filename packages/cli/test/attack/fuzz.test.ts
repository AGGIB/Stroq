import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@stroq/core';
import { formatFuzz, runFuzz, type FuzzReport } from '../../src/attack/fuzz.js';
import { MUTATIONS, type Mutation } from '../../src/attack/mutate.js';
import type { Scenario } from '../../src/attack/scenario.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

const report = (over: Partial<FuzzReport> = {}): FuzzReport => ({
  version: 1,
  policy: 'default',
  scenarios: 13,
  mutations: 25,
  variants: 300,
  survived: 298,
  survivedByLimit: 0,
  escaped: [
    {
      scenarioId: '02-sentry-agentjacking',
      mutationId: 'synonym-rephrase',
      preserving: true,
      outcome: 'passed',
      ruleId: null,
      error: null,
    },
  ],
  recorded: [],
  errored: [],
  inconclusive: [],
  notApplicable: 25,
  textless: ['08-rm-rf-home'],
  ok: false,
  ...over,
});

/** A mutation whose `apply` always throws, to prove one bad mutation cannot crash the run. */
const THROWING_MUTATION: Mutation = {
  id: 'throws-fixture',
  preserving: true,
  why: 'fixture for the fuzz runner: proves a mutation that throws does not crash the suite',
  apply: () => {
    throw new URIError('fixture: unpaired surrogate, cannot encode');
  },
};

/**
 * A scenario whose attack step (`echo hello world`) is always allowed by the default
 * policy, regardless of any mutation applied to the unrelated `Read` text above it.
 * That determinism is what lets this fixture exercise `runFuzz`'s escaped/recorded
 * split without depending on which real attacks the current policy happens to stop.
 */
const ALWAYS_ALLOWED_SCENARIO: Scenario = {
  id: '99-fixture-benign-tail',
  title: 'fixture: benign attack step, mutatable text upstream',
  incident: null,
  class: 'fixture',
  origin: 'repo-file',
  encoding: 'plain',
  effect: 'exec',
  atlas: ['AML.T0051.001'],
  asi: [],
  steps: [
    {
      event: {
        session_id: 'stroq-attack',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '__CWD__/README.md' },
        cwd: '__CWD__',
        tool_response: {
          type: 'text',
          file: { filePath: '__CWD__/README.md', content: 'This is a totally harmless readme.' },
        },
      },
      expect: 'clean',
    },
    {
      event: {
        session_id: 'stroq-attack',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello world' },
        cwd: '__CWD__',
      },
      expect: 'deny',
    },
  ],
};

describe('runFuzz', () => {
  it('crosses every scenario with every mutation and stops the mutated attacks', async () => {
    const out = await runFuzz(
      SCENARIOS.slice(0, 2),
      MUTATIONS.slice(0, 3),
      DEFAULT_POLICY,
      'default',
    );
    expect(out.scenarios).toBe(2);
    expect(out.mutations).toBe(3);
    expect(out.variants).toBe(out.survived + out.escaped.length + out.recorded.length);
    for (const v of out.escaped) expect(v.outcome).toBe('passed');
  }, 120_000);

  it('names the textless scenarios instead of counting them as survivors', async () => {
    const bare = SCENARIOS.filter((s) => s.id === '08-rm-rf-home');
    const out = await runFuzz(bare, MUTATIONS.slice(0, 3), DEFAULT_POLICY, 'default');
    expect(out.textless).toEqual(['08-rm-rf-home']);
    expect(out.variants).toBe(0);
    expect(out.notApplicable).toBe(3);
    expect(out.survived).toBe(0);
  }, 60_000);

  it('is ok only when no semantics-preserving variant escaped', async () => {
    const out = await runFuzz(
      SCENARIOS.slice(0, 1),
      MUTATIONS.slice(0, 1),
      DEFAULT_POLICY,
      'default',
    );
    expect(out.ok).toBe(out.escaped.length === 0);
  }, 60_000);

  it('reports progress as it goes', async () => {
    const seen: number[] = [];
    await runFuzz(SCENARIOS.slice(0, 1), MUTATIONS.slice(0, 2), DEFAULT_POLICY, 'default', (n) =>
      seen.push(n),
    );
    expect(seen.length).toBeGreaterThan(0);
  }, 60_000);

  it('keeps running when a mutation throws, recording it as errored rather than a survivor or escape', async () => {
    const scenario = SCENARIOS.filter((s) => s.id === '01-readme-pipe-to-shell');
    const identity = MUTATIONS.find((m) => m.id === 'identity')!;
    const out = await runFuzz(scenario, [identity, THROWING_MUTATION], DEFAULT_POLICY, 'default');
    expect(out.errored).toHaveLength(1);
    expect(out.errored[0]?.scenarioId).toBe('01-readme-pipe-to-shell');
    expect(out.errored[0]?.mutationId).toBe('throws-fixture');
    expect(out.errored[0]?.error).toContain('unpaired surrogate');
    expect(out.escaped.find((v) => v.mutationId === 'throws-fixture')).toBeUndefined();
    expect(out.recorded.find((v) => v.mutationId === 'throws-fixture')).toBeUndefined();
    // The one working mutation in the pair still ran and is reflected in variants/ok.
    expect(out.variants).toBe(out.survived + out.escaped.length + out.recorded.length);
    expect(out.ok).toBe(out.escaped.length === 0);
  }, 60_000);

  it('sorts a passed-through variant into escaped when preserving, recorded when not', async () => {
    const identity = MUTATIONS.find((m) => m.id === 'identity')!;
    const rot13 = MUTATIONS.find((m) => m.id === 'rot13')!;
    expect(identity.preserving).toBe(true);
    expect(rot13.preserving).toBe(false);

    const out = await runFuzz(
      [ALWAYS_ALLOWED_SCENARIO],
      [identity, rot13],
      DEFAULT_POLICY,
      'default',
    );
    expect(out.escaped).toHaveLength(1);
    expect(out.escaped[0]?.mutationId).toBe('identity');
    expect(out.escaped[0]?.outcome).toBe('passed');
    expect(out.recorded).toHaveLength(1);
    expect(out.recorded[0]?.mutationId).toBe('rot13');
    expect(out.recorded[0]?.outcome).toBe('passed');
    expect(out.ok).toBe(false);
  }, 60_000);
});

/** A scenario whose attack step is a malformed event, so that every variant of it throws when run. */
const THROWING_STEP_SCENARIO: Scenario = {
  ...ALWAYS_ALLOWED_SCENARIO,
  id: '99-fixture-throwing-step',
  title: 'fixture: the attack step is a malformed event',
  steps: [
    ALWAYS_ALLOWED_SCENARIO.steps[0],
    {
      event: {
        session_id: 'stroq-attack',
        hook_event_name: 'PreToolUse',
        tool_name: '',
        tool_input: { command: 'echo hello world' },
        cwd: '__CWD__',
      },
      expect: 'deny',
    },
  ],
};

/** A scan budget no scan can meet. */
const TINY_BUDGET = '0.000001';

describe('runFuzz with a variant that could not be judged', () => {
  const saved = process.env['STROQ_SCAN_BUDGET_MS'];
  afterEach(() => {
    if (saved === undefined) delete process.env['STROQ_SCAN_BUDGET_MS'];
    else process.env['STROQ_SCAN_BUDGET_MS'] = saved;
  });

  const identity = MUTATIONS.find((m) => m.id === 'identity')!;
  const readme = SCENARIOS.filter((s) => s.id === '01-readme-pipe-to-shell');

  it('counts the variant as survived when the scan is in time (the control)', async () => {
    const out = await runFuzz(readme, [identity], DEFAULT_POLICY, 'default');
    expect(out.variants).toBe(1);
    expect(out.survived).toBe(1);
    expect(out.inconclusive).toEqual([]);
    expect(out.ok).toBe(true);
  }, 60_000);

  it('files a variant whose scan ran out of its budget as inconclusive: not survived, not escaped', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = TINY_BUDGET;
    const out = await runFuzz(readme, [identity], DEFAULT_POLICY, 'default');
    expect(out.variants).toBe(1);
    expect(out.survived).toBe(0);
    expect(out.escaped).toEqual([]);
    expect(out.recorded).toEqual([]);
    expect(out.inconclusive).toHaveLength(1);
    expect(out.inconclusive[0]).toMatchObject({
      scenarioId: '01-readme-pipe-to-shell',
      mutationId: 'identity',
      outcome: 'timeout',
    });
    expect(out.inconclusive[0]?.error).toContain('time budget');
    expect(out.ok).toBe(false);
  }, 60_000);

  it('files a variant whose step threw as inconclusive, and goes on to the next', async () => {
    const out = await runFuzz(
      [THROWING_STEP_SCENARIO],
      [identity, MUTATIONS.find((m) => m.id === 'rot13')!],
      DEFAULT_POLICY,
      'default',
    );
    expect(out.variants).toBe(2);
    expect(out.inconclusive.map((v) => [v.mutationId, v.outcome])).toEqual([
      ['identity', 'error'],
      ['rot13', 'error'],
    ]);
    expect(out.inconclusive[0]?.error).toContain('scenario 99-fixture-throwing-step step 2');
    expect(out.survived).toBe(0);
    expect(out.escaped).toEqual([]);
    expect(out.errored).toEqual([]);
    expect(out.ok).toBe(false);
  }, 60_000);

  it('accounts for every variant: survived, escaped, recorded and inconclusive add up to variants', async () => {
    process.env['STROQ_SCAN_BUDGET_MS'] = TINY_BUDGET;
    const out = await runFuzz(
      [...readme, ALWAYS_ALLOWED_SCENARIO, THROWING_STEP_SCENARIO],
      [identity, MUTATIONS.find((m) => m.id === 'rot13')!],
      DEFAULT_POLICY,
      'default',
    );
    expect(out.variants).toBe(6);
    expect(out.survived + out.escaped.length + out.recorded.length + out.inconclusive.length).toBe(
      out.variants,
    );
    // Every variant of these three is inconclusive: the scan runs out in the first two, and the
    // third throws. The one that got through (the always-allowed attack) is among them, shown
    // with the outcome it had, and not hidden in `escaped` or lost.
    expect(out.inconclusive).toHaveLength(6);
    expect(
      out.inconclusive
        .filter((v) => v.scenarioId === '99-fixture-benign-tail')
        .map((v) => v.outcome),
    ).toEqual(['passed', 'passed']);
  }, 60_000);

  it('counts a variant asked at a limit as survived, and says how many', async () => {
    const tooLarge: Scenario = {
      ...ALWAYS_ALLOWED_SCENARIO,
      id: '99-fixture-too-large',
      steps: [
        ALWAYS_ALLOWED_SCENARIO.steps[0],
        {
          event: {
            session_id: 'stroq-attack',
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'echo x;'.repeat(100_000) },
            cwd: '__CWD__',
          },
          expect: 'ask',
        },
      ],
    };
    const out = await runFuzz([tooLarge], [identity], DEFAULT_POLICY, 'default');
    expect(out.survived).toBe(1);
    expect(out.survivedByLimit).toBe(1);
    expect(out.inconclusive).toEqual([]);
    expect(out.ok).toBe(true);
  }, 60_000);

  it('keeps the two fields the CI gate reads: escaped and variants', async () => {
    const out = await runFuzz([ALWAYS_ALLOWED_SCENARIO], [identity], DEFAULT_POLICY, 'default');
    expect(Array.isArray(out.escaped)).toBe(true);
    expect(out.escaped).toHaveLength(1);
    expect(typeof out.variants).toBe('number');
    expect(out.variants).toBe(1);
    expect(Array.isArray(out.inconclusive)).toBe(true);
  }, 60_000);
});

describe('formatFuzz', () => {
  it('states the variants that could not be judged, with their reason, and fails them', () => {
    const out = formatFuzz(
      report({
        escaped: [],
        ok: false,
        inconclusive: [
          {
            scenarioId: '01-readme-pipe-to-shell',
            mutationId: 'rot13',
            preserving: false,
            outcome: 'timeout',
            ruleId: 'deny-encoded-exec',
            error: 'step 1 (post Read): the scan ran out of its time budget',
          },
        ],
      }),
    );
    expect(out).toMatch(/inconclusive:\s+1/);
    expect(out).toContain('01-readme-pipe-to-shell');
    expect(out).toContain('the scan ran out of its time budget');
    // Not a clean bill of health: the run cannot say that nothing escaped.
    expect(out).not.toMatch(/no escapes/i);
  });

  it('says nothing about inconclusive variants when there are none', () => {
    expect(formatFuzz(report({ escaped: [], ok: true }))).not.toMatch(/inconclusive/i);
  });

  it('says how many of the survivors were asked at a limit, when any were', () => {
    const out = formatFuzz(report({ survivedByLimit: 3 }));
    expect(out).toMatch(/3 of them were asked because Stroq could not read them/);
    expect(formatFuzz(report())).not.toMatch(/could not read them/);
  });

  it('leads with the variant count and the survival ratio', () => {
    const out = formatFuzz(report());
    expect(out).toContain(
      '12 scenarios x 25 mutations = 300 variants (1 of 13 scenarios carry no untrusted text and are not mutated)',
    );
    expect(out).toMatch(/survived:\s+298 \/ 300/);
  });

  it('lists every escape with its scenario, mutation and rule', () => {
    const out = formatFuzz(report());
    expect(out).toContain('02-sentry-agentjacking');
    expect(out).toContain('synonym-rephrase');
    expect(out).toContain('no rule');
  });

  it('states what it could not test rather than leaving it out', () => {
    const out = formatFuzz(report());
    expect(out).toMatch(/not applicable:\s+25/);
    expect(out).toContain('08-rm-rf-home');
  });

  it('separates recorded non-preserving variants from the gate', () => {
    const out = formatFuzz(
      report({
        escaped: [],
        ok: true,
        recorded: [
          {
            scenarioId: '01-readme-pipe-to-shell',
            mutationId: 'rot13',
            preserving: false,
            outcome: 'passed',
            ruleId: null,
            error: null,
          },
        ],
      }),
    );
    expect(out).toMatch(/recorded, not asserted:\s+1/);
    expect(out).toMatch(/no escapes/i);
  });

  it('reports errored variants separately, not as escapes or survivors', () => {
    const out = formatFuzz(
      report({
        errored: [
          {
            scenarioId: '01-readme-pipe-to-shell',
            mutationId: 'url-encoded',
            preserving: true,
            outcome: null,
            ruleId: null,
            error: 'URIError: URI malformed',
          },
        ],
      }),
    );
    expect(out).toMatch(/errored:\s+1/);
    expect(out).toContain('URIError: URI malformed');
  });
});
