import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, stableStringify, type Policy } from '@stroq/core';
import { runFuzz } from '../../src/attack/fuzz.js';
import { MUTATIONS } from '../../src/attack/mutate.js';
import { buildMeta } from '../../src/attack/report.js';
import { runAttack } from '../../src/attack/run.js';
import { SESSION_ID, type Scenario } from '../../src/attack/scenario.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';
import { runActionsBench, type ActionScenario } from '../../src/bench/actions.js';
import { stroqVersion } from '../../src/version.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const EMPTY_POLICY: Policy = { version: 1, threshold: 0.6, default: 'allow', rules: [] };

const AXES = {
  incident: null,
  class: 'meta probe',
  origin: 'direct-user',
  encoding: 'plain',
  effect: 'exec',
  atlas: ['AML.T0050'],
  asi: [],
} as const;

/** Two scenarios that use two tools between them, one of them twice. */
const SCENARIOS_2: readonly Scenario[] = [
  {
    id: '99-a',
    title: 'a',
    ...AXES,
    steps: [
      {
        event: {
          session_id: SESSION_ID,
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '__CWD__/README.md' },
          cwd: '__CWD__',
          tool_response: {
            type: 'text',
            file: { filePath: '__CWD__/README.md', content: 'hello' },
          },
        },
        expect: 'clean',
      },
      {
        event: {
          session_id: SESSION_ID,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'bash -c "$PROGRAM"' },
          cwd: '__CWD__',
        },
        expect: 'ask',
      },
    ],
  },
  {
    id: '99-b',
    title: 'b',
    ...AXES,
    steps: [
      {
        event: {
          session_id: SESSION_ID,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'bash -c "$PROGRAM"' },
          cwd: '__CWD__',
        },
        expect: 'ask',
      },
    ],
  },
];

describe('buildMeta', () => {
  it('names the host: the engine in this process, which is no host at all', () => {
    const meta = buildMeta({
      policy: EMPTY_POLICY,
      policySource: 'default',
      corpusId: 'probe',
      scenarios: [],
    });
    expect(meta.host).toEqual({ id: 'claude-code', version: null, mode: 'in-process' });
    expect(meta.sandbox).toBeNull();
    expect(meta.stroq).toBe(stroqVersion());
  });

  // The values here are `sha256` of the canonical JSON (keys sorted), worked out apart from the
  // code under test with `shasum`, so that the choice of what is hashed cannot drift unseen.
  it('hashes the policy as parsed, and the corpus as given, in canonical JSON', () => {
    const meta = buildMeta({
      policy: EMPTY_POLICY,
      policySource: '~/.stroq/policy.yaml',
      corpusId: 'probe',
      scenarios: [],
    });
    expect(meta.policy).toEqual({
      source: '~/.stroq/policy.yaml',
      sha256: '59c4f9c97224d80af3ff2d03b32ea0d281c76e2f856ab922edf6aa5cf693516e',
    });
    expect(meta.corpus).toEqual({
      id: 'probe',
      sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      count: 0,
    });
  });

  it('does not depend on the order of keys, nor on how a file spelled the same policy', () => {
    const reordered = {
      rules: [],
      version: 1,
      default: 'allow',
      threshold: 0.6,
    } as unknown as Policy;
    const a = buildMeta({ policy: EMPTY_POLICY, policySource: 'a', corpusId: 'c', scenarios: [] });
    const b = buildMeta({ policy: reordered, policySource: 'b', corpusId: 'c', scenarios: [] });
    expect(b.policy.sha256).toBe(a.policy.sha256);
  });

  it('changes when the policy changes, and when the corpus does', () => {
    const base = buildMeta({
      policy: DEFAULT_POLICY,
      policySource: 'default',
      corpusId: 'c',
      scenarios: SCENARIOS_2,
    });
    const weaker = buildMeta({
      policy: { ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.slice(1) },
      policySource: 'default',
      corpusId: 'c',
      scenarios: SCENARIOS_2,
    });
    const fewer = buildMeta({
      policy: DEFAULT_POLICY,
      policySource: 'default',
      corpusId: 'c',
      scenarios: SCENARIOS_2.slice(0, 1),
    });
    expect(weaker.policy.sha256).not.toBe(base.policy.sha256);
    expect(weaker.corpus.sha256).toBe(base.corpus.sha256);
    expect(fewer.corpus.sha256).not.toBe(base.corpus.sha256);
    expect(fewer.policy.sha256).toBe(base.policy.sha256);
  });

  it('lists each tool the scenarios use once, in order', () => {
    const meta = buildMeta({
      policy: EMPTY_POLICY,
      policySource: 'default',
      corpusId: 'c',
      scenarios: SCENARIOS_2,
    });
    expect(meta.tools).toEqual(['Bash', 'Read']);
    expect(meta.corpus.count).toBe(2);
  });
});

describe('the reports are version 2, with the meta block', () => {
  const POLICY_SHA = sha256(stableStringify(DEFAULT_POLICY));

  it('attack: the deterministic fields are exact', async () => {
    const report = await runAttack(SCENARIOS_2, DEFAULT_POLICY, 'default');
    expect(report.version).toBe(2);
    expect(report.meta).toEqual({
      stroq: stroqVersion(),
      policy: { source: 'default', sha256: POLICY_SHA },
      host: { id: 'claude-code', version: null, mode: 'in-process' },
      tools: ['Bash', 'Read'],
      sandbox: null,
      corpus: { id: 'attack-scenarios', sha256: sha256(stableStringify(SCENARIOS_2)), count: 2 },
    });
    // The v1 fields are where they were, and mean what they meant.
    expect(report.policy).toBe('default');
    expect(report.scenarios).toHaveLength(2);
    expect(report.totals.asked).toBe(2);
    expect(report.ok).toBe(true);
  });

  it('attack: describes the scenarios that were selected, not the whole suite', async () => {
    const report = await runAttack(SCENARIOS.slice(0, 3), DEFAULT_POLICY, 'default');
    expect(report.meta.corpus.count).toBe(3);
    expect(report.meta.corpus.sha256).toBe(sha256(stableStringify(SCENARIOS.slice(0, 3))));
  });

  it('fuzz: the same block, and the budget of the run', async () => {
    const mutations = MUTATIONS.slice(0, 2);
    const report = await runFuzz(SCENARIOS_2, mutations, DEFAULT_POLICY, 'default');
    expect(report.version).toBe(2);
    expect(report.meta).toEqual({
      stroq: stroqVersion(),
      policy: { source: 'default', sha256: POLICY_SHA },
      host: { id: 'claude-code', version: null, mode: 'in-process' },
      tools: ['Bash', 'Read'],
      sandbox: null,
      corpus: { id: 'attack-scenarios', sha256: sha256(stableStringify(SCENARIOS_2)), count: 2 },
      // Every scenario crossed with every mutation, in a fixed order: there is nothing to seed.
      budget: { variants: 4, seed: null },
    });
  });

  it('bench --actions: the same block, for its own corpus', async () => {
    const work: ActionScenario[] = [
      {
        id: '01-list',
        title: 'list',
        steps: [
          {
            event: {
              session_id: 'actions-test',
              hook_event_name: 'PreToolUse',
              tool_name: 'Bash',
              tool_input: { command: 'ls' },
              cwd: '__CWD__',
            },
          },
        ],
      },
    ];
    const report = await runActionsBench(work, DEFAULT_POLICY, 'default');
    expect(report.version).toBe(2);
    expect(report.meta).toEqual({
      stroq: stroqVersion(),
      policy: { source: 'default', sha256: POLICY_SHA },
      host: { id: 'claude-code', version: null, mode: 'in-process' },
      tools: ['Bash'],
      sandbox: null,
      corpus: { id: 'actions-scenarios', sha256: sha256(stableStringify(work)), count: 1 },
    });
  });

  it('serialises to JSON with the meta block and without undefined holes', async () => {
    const report = await runAttack(SCENARIOS_2, DEFAULT_POLICY, 'default');
    const parsed = JSON.parse(JSON.stringify(report)) as { meta: Record<string, unknown> };
    expect(Object.keys(parsed.meta).sort()).toEqual([
      'corpus',
      'host',
      'policy',
      'sandbox',
      'stroq',
      'tools',
    ]);
    expect(parsed.meta['sandbox']).toBeNull();
  });
});
