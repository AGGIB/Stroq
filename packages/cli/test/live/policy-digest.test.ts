import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, loadPolicyFile, parsePolicy, type Policy } from '@stroq/core';
import { policySha256, writePolicy } from '../../src/live/policy-digest.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../src/live/throwaway.js';

/**
 * A stored check is only as good as the policy it was run under, so the policy gets a name that changes
 * when it does; and the hook that the host runs has to judge under the very policy the check expects,
 * so the policy is written where that hook will read it.
 */
let root: string;
let home: string;

beforeEach(() => {
  ({ root, stroqHome: home } = createThrowawayRoot('stroq-live-policy-'));
});
afterEach(() => {
  removeThrowawayRoot(root);
});

const without = (id: string): Policy => ({
  ...DEFAULT_POLICY,
  rules: DEFAULT_POLICY.rules.filter((rule) => rule.id !== id),
});

describe('policySha256', () => {
  it('is a sha256 in hex', () => {
    expect(policySha256(DEFAULT_POLICY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for the same policy, and for one that says the same in another key order', () => {
    const reordered: Policy = {
      rules: DEFAULT_POLICY.rules.map((rule) => ({
        when: { taint: rule.when.taint, classes: rule.when.classes },
        reason: rule.reason,
        effect: rule.effect,
        id: rule.id,
      })),
      default: DEFAULT_POLICY.default,
      threshold: DEFAULT_POLICY.threshold,
      version: 1,
    };
    expect(policySha256(reordered)).toBe(policySha256(DEFAULT_POLICY));
  });

  it('changes when a rule is taken out, an effect is changed or the order of the rules is', () => {
    const digests = new Set([
      policySha256(DEFAULT_POLICY),
      policySha256(without('deny-git-exec')),
      policySha256({ ...DEFAULT_POLICY, default: 'deny' }),
      policySha256({ ...DEFAULT_POLICY, threshold: 0.5 }),
      policySha256({ ...DEFAULT_POLICY, rules: [...DEFAULT_POLICY.rules].reverse() }),
      policySha256({
        ...DEFAULT_POLICY,
        rules: DEFAULT_POLICY.rules.map((rule) =>
          rule.id === 'deny-git-exec' ? { ...rule, effect: 'ask' as const } : rule,
        ),
      }),
    ]);
    expect(digests.size).toBe(6);
  });

  it('does not change by being written as a file and read again', () => {
    writePolicy(home, DEFAULT_POLICY);
    expect(policySha256(loadPolicyFile(join(home, 'policy.yaml')))).toBe(
      policySha256(DEFAULT_POLICY),
    );
  });
});

describe('writePolicy', () => {
  it('writes policy.yaml where the hook of that home reads it, and the hook reads the same policy', () => {
    for (const policy of [
      DEFAULT_POLICY,
      without('deny-git-exec'),
      { ...DEFAULT_POLICY, default: 'ask' as const },
    ]) {
      writePolicy(home, policy);
      expect(loadPolicyFile(join(home, 'policy.yaml'))).toEqual(policy);
    }
  });

  it('writes plain YAML a person could read', () => {
    writePolicy(home, DEFAULT_POLICY);
    const text = readFileSync(join(home, 'policy.yaml'), 'utf8');
    expect(parsePolicy(text)).toEqual(DEFAULT_POLICY);
    expect(text).toContain('deny-git-exec');
    expect(text).toBe(stringify(DEFAULT_POLICY));
  });

  it('replaces a policy that was there', () => {
    writePolicy(home, without('deny-git-exec'));
    writePolicy(home, DEFAULT_POLICY);
    expect(loadPolicyFile(join(home, 'policy.yaml'))).toEqual(DEFAULT_POLICY);
  });

  it.skipIf(process.platform === 'win32')('keeps the file to its owner', () => {
    writePolicy(home, DEFAULT_POLICY);
    expect(statSync(join(home, 'policy.yaml')).mode & 0o777).toBe(0o600);
  });
});
