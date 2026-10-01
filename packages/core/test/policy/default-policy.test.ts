import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/policy/default-policy.js';
import { parsePolicy } from '../../src/policy/load-policy.js';

describe('policies/default.yaml', () => {
  it('is identical to DEFAULT_POLICY', () => {
    const yamlText = readFileSync(
      join(import.meta.dirname, '../../../../policies/default.yaml'),
      'utf8',
    );
    expect(parsePolicy(yamlText)).toEqual(DEFAULT_POLICY);
  });

  // The engine writes the way out, with the real session id (policy/way-out.ts); a
  // placeholder here would print a literal `<id>` next to it.
  it('leaves the untaint command to the engine, which knows the session id', () => {
    const rule = DEFAULT_POLICY.rules.find((r) => r.id === 'deny-origin-suspect');
    expect(rule?.reason).not.toContain('<id>');
  });

  it('denies an unscannable egress immediately after the secret-egress rule', () => {
    const ids = DEFAULT_POLICY.rules.map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual(['deny-secret-egress', 'deny-secret-unscannable']);
    const rule = DEFAULT_POLICY.rules[1];
    expect(rule).toEqual({
      id: 'deny-secret-unscannable',
      effect: 'deny',
      reason:
        'Arguments are larger than the secret scan window (2 MiB), so Stroq cannot check them for secret values; outbound use is blocked',
      when: { classes: ['secret.unscannable'], taint: 'any' },
    });
  });

  it('denies installing something a trusted process runs later when the session is tainted, and asks otherwise', () => {
    const ids = DEFAULT_POLICY.rules.map((r) => r.id);
    const deny = DEFAULT_POLICY.rules.find((r) => r.id === 'deny-persistence-when-tainted');
    const ask = DEFAULT_POLICY.rules.find((r) => r.id === 'ask-persistence');
    expect(deny).toMatchObject({
      effect: 'deny',
      when: { classes: ['config.persistence'], taint: 'suspect' },
    });
    expect(ask).toMatchObject({
      effect: 'ask',
      when: { classes: ['config.persistence'], taint: 'any' },
    });
    // A tainted session is denied before the ask rules could answer it, and before a push
    // rule that would otherwise name the same command first.
    expect(ids.indexOf('deny-persistence-when-tainted')).toBeLessThan(
      ids.indexOf('ask-persistence'),
    );
    expect(ids.indexOf('ask-persistence')).toBeLessThan(ids.indexOf('ask-instructions-payload'));
    expect(ids.indexOf('deny-persistence-when-tainted')).toBeLessThan(
      ids.indexOf('deny-push-external-when-tainted'),
    );
  });
});
