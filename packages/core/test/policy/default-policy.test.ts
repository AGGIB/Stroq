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

  it('tells the user how to clear a false positive in the origin-suspect reason', () => {
    const rule = DEFAULT_POLICY.rules.find((r) => r.id === 'deny-origin-suspect');
    expect(rule?.reason).toContain('stroq untaint --session <id>');
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
});
