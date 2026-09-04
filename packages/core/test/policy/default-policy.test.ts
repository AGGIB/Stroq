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
});
