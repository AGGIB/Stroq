import { describe, expect, it } from 'vitest';
import { compileRule, compileRules, translatePcre } from '../../src/rules/compile.js';
import { parseRule } from '../../src/rules/atr-loader.js';

const yamlRule = `
id: ATR-2026-00120
title: "Instruction override"
status: experimental
severity: critical
tags:
  category: prompt-injection
detection:
  condition: any
  conditions:
    - field: content
      operator: regex
      value: "(?i)ignore\\\\s+(all\\\\s+)?previous\\\\s+instructions"
`;

describe('translatePcre', () => {
  it('moves a leading (?i) into RegExp flags', () => {
    expect(translatePcre('(?i)abc')).toEqual({ source: 'abc', flags: 'i' });
  });
  it('handles combined inline flags and PCRE anchors', () => {
    expect(translatePcre('(?is)\\Afoo\\Z')).toEqual({ source: '^foo$', flags: 'is' });
  });
  it('drops possessive quantifiers', () => {
    expect(translatePcre('a++b*+')).toEqual({ source: 'a+b*', flags: '' });
  });
});

describe('compileRule', () => {
  it('compiles a valid ATR rule into a RegExp-backed test', () => {
    const { rule } = parseRule(yamlRule, 'test.yaml');
    const { compiled, error } = compileRule(rule!);
    expect(error).toBeUndefined();
    expect(compiled?.id).toBe('ATR-2026-00120');
    expect(compiled?.tests[0]?.regex?.test('Please IGNORE previous instructions')).toBe(true);
  });

  it('reports an error instead of throwing on an uncompilable pattern', () => {
    const { rule } = parseRule(yamlRule.replace('(?i)ignore', '(?<=a'), 'bad.yaml');
    const { compiled, error } = compileRule(rule!);
    expect(compiled).toBeUndefined();
    expect(error).toMatch(/ATR-2026-00120/);
  });

  it('compileRules separates compiled rules from errors', () => {
    const ok = parseRule(yamlRule, 'a.yaml').rule!;
    const bad = parseRule(yamlRule.replace('(?i)ignore', '(?<=a'), 'b.yaml').rule!;
    const result = compileRules([ok, bad]);
    expect(result.compiled).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });
});
