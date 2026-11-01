import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBundle } from '../../src/rules/bundle.js';
import { compileRules, type CompiledRule } from '../../src/rules/compile.js';
import { runtimeBundle, runtimeRule } from '../../src/rules/runtime-rule.js';

/**
 * The CLI ships the rule bundle cut down to what the engine reads (`runtime-rule.ts`). These hold
 * that the cut changes no rule: the shipped corpus compiles to the same rules either way, down to
 * each regex's source and flags, and a malformed rule is still refused.
 */
const whole = JSON.parse(
  readFileSync(new URL('../../src/rules.bundle.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, unknown>>; disabled: string[] };

/** A compiled rule with each RegExp spelled out, since two RegExps never compare equal. */
const plain = (rules: readonly CompiledRule[]) =>
  rules.map((rule) => ({
    ...rule,
    tests: rule.tests.map((test) => ({
      ...test,
      regex: test.regex === undefined ? undefined : `/${test.regex.source}/${test.regex.flags}`,
    })),
  }));

const compiled = (bundle: unknown) => {
  const parsed = parseBundle(bundle);
  const disabled = new Set(parsed.disabled);
  return compileRules(parsed.rules.filter((rule) => !disabled.has(rule.id)));
};

describe('the rules as the engine reads them', () => {
  it('compile to exactly the rules the whole bundle compiles to', () => {
    const fromWhole = compiled(whole);
    const fromRuntime = compiled(runtimeBundle(whole));
    expect(fromRuntime.errors).toEqual(fromWhole.errors);
    expect(fromRuntime.compiled.length).toBe(fromWhole.compiled.length);
    expect(plain(fromRuntime.compiled)).toEqual(plain(fromWhole.compiled));
  });

  it('keep the disabled list and the bundle header as they are', () => {
    const runtime = runtimeBundle(whole) as typeof whole;
    expect(runtime.disabled).toEqual(whole.disabled);
    expect(Object.keys(runtime)).toEqual(Object.keys(whole));
  });

  it('hold nothing the engine does not read', () => {
    const runtime = runtimeBundle(whole) as typeof whole;
    const text = JSON.stringify(runtime.rules);
    for (const unread of ['test_cases', 'compliance', 'description', 'references', 'evasion_tests'])
      expect(text).not.toContain(`"${unread}"`);
    expect(text.length).toBeLessThan(JSON.stringify(whole.rules).length / 2);
  });

  it('change nothing when cut a second time', () => {
    const once = runtimeBundle(whole);
    expect(runtimeBundle(once)).toEqual(once);
  });

  it('keep the values of what they keep, absent where it was absent', () => {
    expect(
      runtimeRule({
        id: 'STROQ-2026-99999',
        title: 't',
        severity: 'low',
        status: 'experimental',
        detection: { conditions: [{ operator: 'contains', value: 'x', description: 'd' }] },
        test_cases: { true_positives: [{ input: 'x', expected: 'triggered' }] },
      }),
    ).toEqual({
      id: 'STROQ-2026-99999',
      title: 't',
      severity: 'low',
      detection: { conditions: [{ operator: 'contains', value: 'x' }] },
    });
  });

  it('pass a malformed rule through, so that it is refused as before', () => {
    const rule = whole.rules[0] as Record<string, unknown>;
    for (const broken of [
      { ...rule, detection: 'any' },
      { ...rule, detection: { conditions: 'regex' } },
      { ...rule, detection: { conditions: ['regex'] } },
      { ...rule, tags: ['prompt-injection'] },
      { ...rule, id: 'nope' },
    ]) {
      const bundle = { ...whole, rules: [broken] };
      expect(() => parseBundle(bundle)).toThrow();
      expect(() => parseBundle(runtimeBundle(bundle))).toThrow();
    }
    expect(runtimeBundle('not a bundle')).toBe('not a bundle');
    expect(runtimeRule(null)).toBeNull();
  });
});

describe('the surfaces a rule is scoped to', () => {
  it('survive the cut the CLI ships', () => {
    const projected = runtimeRule({
      id: 'ATR-2099-00003',
      title: 'scoped',
      severity: 'high',
      tags: { category: 'tool-poisoning', stroq_surfaces: ['tool_result'], confidence: 'high' },
      detection: { condition: 'any', conditions: [{ operator: 'regex', value: 'x' }] },
    }) as { tags: Record<string, unknown> };
    expect(projected.tags).toEqual({ category: 'tool-poisoning', stroq_surfaces: ['tool_result'] });
  });

  it('survive on a condition too', () => {
    const projected = runtimeRule({
      id: 'ATR-2099-00004',
      title: 'two-way',
      severity: 'high',
      detection: {
        condition: 'any',
        conditions: [
          {
            operator: 'regex',
            value: 'x',
            stroq_surfaces: ['web_content'],
            description: 'dropped',
          },
        ],
      },
    }) as { detection: { conditions: Record<string, unknown>[] } };
    expect(projected.detection.conditions[0]).toEqual({
      operator: 'regex',
      value: 'x',
      stroq_surfaces: ['web_content'],
    });
  });
});
