import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '@stroq/core';
import { expectedDecision } from '../../src/live/expectation.js';
import { buildProbes, prepareProject } from '../../src/live/probes.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../src/live/throwaway.js';
import { FAKE, NONCE } from './helpers.js';
import { probe } from './probe-helpers.js';

/**
 * Before a request is made, the policy that is in force is asked, in process, what it would say to the
 * command. That answer is the expectation the hook's own audit entry is held to afterwards. It is asked
 * of the real engine, so it cannot drift from what the hook does, and in a scratch home of its own, so
 * that it can never leave an audit entry that would be taken for the hook's.
 */
let root: string;
let project: string;
let home: string;

beforeEach(() => {
  ({ root, project, home } = createThrowawayRoot('stroq-live-expect-test-'));
  prepareProject(project, FAKE);
});
afterEach(() => {
  removeThrowawayRoot(root);
});

const without = (id: string): Policy => ({
  ...DEFAULT_POLICY,
  rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== id),
});

describe('expectedDecision', () => {
  it.each([
    ['allow', { effect: 'allow', ruleId: null }],
    ['deny', { effect: 'deny', ruleId: 'deny-git-exec' }],
    ['secret-egress', { effect: 'deny', ruleId: 'deny-secret-egress' }],
  ] as const)('gives what the default policy says of the %s probe', async (kind, expected) => {
    expect(await expectedDecision(probe(kind), { project, home }, DEFAULT_POLICY)).toEqual(
      expected,
    );
  });

  it('gives what the policy in force says, not the default', async () => {
    expect(
      await expectedDecision(probe('deny'), { project, home }, without('deny-git-exec')),
    ).toEqual({ effect: 'allow', ruleId: null });
    expect(
      await expectedDecision(
        probe('deny'),
        { project, home },
        {
          ...DEFAULT_POLICY,
          rules: DEFAULT_POLICY.rules.map((rule) =>
            rule.id === 'deny-git-exec' ? { ...rule, effect: 'ask' as const } : rule,
          ),
        },
      ),
    ).toEqual({ effect: 'ask', ruleId: 'deny-git-exec' });
  });

  it('gives the rule by its id when the user has called it something else', async () => {
    const renamed: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.map((rule) =>
        rule.id === 'deny-secret-egress' ? { ...rule, id: 'my-egress-rule' } : rule,
      ),
    };
    expect(await expectedDecision(probe('secret-egress'), { project, home }, renamed)).toEqual({
      effect: 'deny',
      ruleId: 'my-egress-rule',
    });
  });

  it('is the same whichever nonce the command carries', async () => {
    for (const kind of ['allow', 'deny', 'secret-egress'] as const) {
      const one = await expectedDecision(probe(kind, NONCE), { project, home }, DEFAULT_POLICY);
      const other = await expectedDecision(
        probe(kind, 'stroq-live-fedcba9876543210'),
        { project, home },
        DEFAULT_POLICY,
      );
      expect(other).toEqual(one);
    }
  });

  it('finds the fake secret in the project and does not need the real home for it', async () => {
    // Without the .env of the project the same command is a plain network call.
    const bare = join(root, 'bare');
    mkdirSync(bare);
    const [, , egress] = buildProbes(NONCE, FAKE, project);
    expect(await expectedDecision(egress!, { project: bare, home }, DEFAULT_POLICY)).toEqual({
      effect: 'allow',
      ruleId: null,
    });
    expect(await expectedDecision(egress!, { project, home }, DEFAULT_POLICY)).toMatchObject({
      effect: 'deny',
    });
  });

  // The hook's evidence is the audit log of the throwaway home. Anything this wrote there would be
  // taken for the hook having run. The scratch home is made in a root of the test's own, so that what
  // other tests put in the shared temporary directory at the same time cannot be mistaken for it; the
  // policy below is asked for its rules while the question is being decided, and says what it saw.
  const watching = (scratch: string, during: number[], fail = false): Policy => ({
    ...DEFAULT_POLICY,
    get rules() {
      during.push(readdirSync(scratch).length);
      if (fail) throw new Error('the engine broke');
      return DEFAULT_POLICY.rules;
    },
  });

  it('writes nothing into the project or the home it is given, and its scratch home is gone afterwards', async () => {
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const during: number[] = [];
    const before = { project: readdirSync(project).sort(), home: readdirSync(home).sort() };
    await expectedDecision(probe('deny'), { project, home }, watching(scratch, during), scratch);
    await expectedDecision(
      probe('secret-egress'),
      { project, home },
      watching(scratch, during),
      scratch,
    );
    // While the question was being decided there was one scratch home in the root it was given.
    expect(during.length).toBeGreaterThan(1);
    expect(Math.min(...during)).toBe(1);
    expect(readdirSync(project).sort()).toEqual(before.project);
    expect(readdirSync(home).sort()).toEqual(before.home);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('removes its scratch home when the engine throws', async () => {
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const during: number[] = [];
    await expect(
      expectedDecision(probe('deny'), { project, home }, watching(scratch, during, true), scratch),
    ).rejects.toThrow('the engine broke');
    expect(during).toEqual([1]);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
