import { describe, expect, it } from 'vitest';
import { loadBundledRules, parseBundle } from '../../src/rules/bundle.js';
import { parseRule } from '../../src/rules/atr-loader.js';

const good = `
id: STROQ-2026-00001
title: Good rule
severity: high
detection:
  conditions:
    - operator: contains
      value: "do not tell the user"
`;

describe('parseBundle', () => {
  it('parses a hand-built bundle object into typed rules and disabled ids', () => {
    const { rule } = parseRule(good, 'good.yaml');
    const bundle = parseBundle({
      version: 1,
      generatedAt: '2026-09-03T00:00:00.000Z',
      rules: [rule],
      disabled: ['X'],
    });
    expect(bundle.rules).toHaveLength(1);
    expect(bundle.rules[0]?.id).toBe('STROQ-2026-00001');
    expect(bundle.disabled).toEqual(['X']);
  });

  it('throws when a rule in the bundle has a bad id', () => {
    const { rule } = parseRule(good, 'good.yaml');
    const badRule = { ...rule, id: 'nope' };
    expect(() =>
      parseBundle({
        version: 1,
        generatedAt: '2026-09-03T00:00:00.000Z',
        rules: [badRule],
        disabled: [],
      }),
    ).toThrow();
  });
});

describe('loadBundledRules', () => {
  it('returns an array and caches the result across calls', () => {
    const first = loadBundledRules();
    const second = loadBundledRules();
    expect(Array.isArray(first)).toBe(true);
    expect(second).toBe(first);
  });
});
