import { describe, expect, it } from 'vitest';
import { parsePolicy } from '../../src/policy/load-policy.js';
import { cpuNow } from '../cpu-time.js';

/**
 * The loader the hook uses reads a file somebody else may have written (a policy copied from a
 * forum, a file a cloned repository shipped). A YAML document can name a value and refer to it again
 * and again, so that a few hundred bytes expand to billions of nodes: it has to be refused, not built.
 * `yaml` caps the aliases it will resolve; this holds the loader to that, in processor time, so that a
 * change of the package or of its options that lets a bomb through fails here and not on a user's machine.
 */

/** Anchors that each name a list of ten references to the one before: ten to the power of twelve nodes. */
function aliasBomb(levels: number): string {
  const lines = ['l0: &l0 [x, x, x, x, x, x, x, x, x, x]'];
  for (let i = 1; i < levels; i += 1) {
    const refs = Array.from({ length: 10 }, () => `*l${i - 1}`).join(', ');
    lines.push(`l${i}: &l${i} [${refs}]`);
  }
  return `version: 1\nrules: []\n${lines.join('\n')}\n`;
}

describe('parsePolicy: a hostile document', () => {
  it('refuses an alias bomb quickly', () => {
    const started = cpuNow();
    expect(() => parsePolicy(aliasBomb(13))).toThrow();
    expect(cpuNow() - started).toBeLessThan(2_000);
  });

  it('refuses a flow collection nested far deeper than any policy, without crashing the process', () => {
    const started = cpuNow();
    expect(() => parsePolicy(`version: 1\nrules: ${'['.repeat(100_000)}`)).toThrow();
    expect(cpuNow() - started).toBeLessThan(5_000);
  });

  it('refuses two documents in one file and a key written twice', () => {
    expect(() => parsePolicy('version: 1\nrules: []\n---\nversion: 1\nrules: []\n')).toThrow();
    expect(() => parsePolicy('version: 1\nversion: 1\nrules: []\n')).toThrow();
  });
});
