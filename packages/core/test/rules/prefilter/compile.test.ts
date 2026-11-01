import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRulesFromDir } from '../../../src/rules/atr-loader.js';
import { parseBundle } from '../../../src/rules/bundle.js';
import {
  compileRule,
  compileRules,
  withoutPrefilters,
  type CompiledRule,
} from '../../../src/rules/compile.js';
import { prefilterTable } from '../../../src/rules/prefilter/embed.js';
import { runtimeBundle } from '../../../src/rules/runtime-rule.js';
import { evaluateTest, ruleMatches } from '../../../src/scan/matcher.js';
import { scanContent } from '../../../src/scan/scanner.js';
import { BUNDLE_JSON } from './fixtures.js';
import { measureRuleTimings } from '../../../../../scripts/lib/rules-pipeline.js';

const rule = (id: string, ...values: string[]) => ({
  id,
  title: id,
  severity: 'high' as const,
  detection: {
    condition: 'any' as const,
    conditions: values.map((value) => ({ field: 'content', operator: 'regex' as const, value })),
  },
});

describe('compileRule', () => {
  it('gives a regex condition a prefilter when its pattern requires something', () => {
    const { compiled } = compileRule(
      rule('X-2026-00001', '(?i)ignore\\s+previous\\s+instructions'),
    );
    expect(compiled?.tests[0]?.prefilter).toEqual({ fold: 'i', literals: ['instructions'] });
  });

  it('gives none to a pattern that requires nothing worth looking for', () => {
    const { compiled } = compileRule(rule('X-2026-00002', '[a-z]+', 'a.b'));
    expect(compiled?.tests.map((test) => test.prefilter)).toEqual([undefined, undefined]);
    expect(compiled?.tests[0]).not.toHaveProperty('prefilter');
  });

  it('reads the literals it is given instead of reading the pattern', () => {
    const given = compileRule(rule('X-2026-00003', 'real_pattern'), [['given_literal']]);
    expect(given.compiled?.tests[0]?.prefilter?.literals).toEqual(['given_literal']);
    const none = compileRule(rule('X-2026-00004', 'real_pattern'), [null]);
    expect(none.compiled?.tests[0]?.prefilter).toBeUndefined();
  });

  it('does not read literals given for another number of conditions', () => {
    const { compiled } = compileRule(rule('X-2026-00005', 'real_pattern'), [['a'], ['b']]);
    expect(compiled?.tests[0]?.prefilter?.literals).toEqual(['real_pattern']);
  });

  it('leaves the operators that are not regexes alone', () => {
    const { compiled } = compileRule({
      id: 'X-2026-00006',
      title: 'x',
      severity: 'low',
      detection: {
        condition: 'any',
        conditions: [{ field: 'content', operator: 'contains', value: 'danger' }],
      },
    });
    expect(compiled?.tests[0]).toEqual({ field: 'content', kind: 'contains', value: 'danger' });
  });
});

describe('compileRules with a table', () => {
  it('uses the entry of each rule by id, and reads the patterns of the rest', () => {
    const rules = [rule('X-2026-00010', 'alpha_pattern'), rule('X-2026-00011', 'beta_pattern')];
    const { compiled } = compileRules(rules, { 'X-2026-00010': [['from_table']] });
    expect(compiled.map((r) => r.tests[0]?.prefilter?.literals)).toEqual([
      ['from_table'],
      ['beta_pattern'],
    ]);
  });

  it('does not take an id such as __proto__ for an entry', () => {
    const { compiled } = compileRules([rule('X-2026-00012', 'gamma_pattern')], {});
    expect(compiled[0]?.tests[0]?.prefilter?.literals).toEqual(['gamma_pattern']);
  });
});

describe('the table the bundle carries', () => {
  const whole = JSON.parse(readFileSync(BUNDLE_JSON, 'utf8')) as {
    rules: unknown[];
    disabled: string[];
  };
  const shipped = JSON.parse(JSON.stringify(runtimeBundle(whole)));
  const compile = (withTable: boolean): CompiledRule[] => {
    const parsed = parseBundle(shipped);
    const disabled = new Set(parsed.disabled);
    return compileRules(
      parsed.rules.filter((r) => !disabled.has(r.id)),
      withTable ? parsed.prefilters : {},
    ).compiled;
  };

  it('describes every enabled rule and none that is disabled', () => {
    const ids = Object.keys(shipped.prefilters);
    expect(ids.length).toBe(whole.rules.length - whole.disabled.length);
    for (const id of whole.disabled) expect(ids).not.toContain(id);
  });

  it('gives exactly the prefilters that reading the patterns gives', () => {
    expect(compile(true).map((r) => r.tests.map((t) => t.prefilter))).toEqual(
      compile(false).map((r) => r.tests.map((t) => t.prefilter)),
    );
  });

  it('is left as it is when the bundle is cut again', () => {
    expect(runtimeBundle(shipped)).toEqual(shipped);
  });

  it('is not trusted when it does not read as a table', () => {
    const parsed = parseBundle({ ...shipped, prefilters: { 'X-1': 'nonsense' } });
    expect(parsed.prefilters).toEqual({});
    expect(parseBundle({ ...shipped, prefilters: [1, 2] }).prefilters).toEqual({});
    expect(parseBundle({ ...shipped, prefilters: undefined }).prefilters).toEqual({});
  });

  it('is made again by the cut when the bundle has none, or a bad one', () => {
    const { prefilters: _dropped, ...bare } = shipped;
    expect(runtimeBundle(bare)).toEqual(shipped);
    expect(runtimeBundle({ ...shipped, prefilters: 'bad' })).toEqual(shipped);
  });
});

describe('prefilterTable', () => {
  it('lists the literals of each condition, null for what requires none or is not a regex', () => {
    const table = prefilterTable([
      {
        id: 'X-2026-00020',
        detection: {
          conditions: [
            { operator: 'regex', value: 'alpha_literal\\d+' },
            { operator: 'regex', value: '[a-z]+' },
            { operator: 'contains', value: 'text' },
            { operator: 'regex', value: '(' },
          ],
        },
      },
      { id: 'X-2026-00021', detection: { conditions: [] } },
      { id: 'X-2026-00022' },
      'not a rule',
    ]);
    expect(table).toEqual({
      'X-2026-00020': [['alpha_literal'], null, null, null],
      'X-2026-00021': [],
      'X-2026-00022': [],
    });
  });

  it('leaves out the rules it is told to', () => {
    const table = prefilterTable(
      [{ id: 'X-2026-00023', detection: { conditions: [] } }],
      new Set(['X-2026-00023']),
    );
    expect(table).toEqual({});
  });
});

describe('what the matcher does with a prefilter', () => {
  const compiled = compileRule(rule('X-2026-00030', '(?i)needle\\s+in\\s+haystack')).compiled;
  if (compiled === undefined) throw new Error('did not compile');
  const test = compiled.tests[0];
  if (test === undefined) throw new Error('no test');

  it('answers as the regex does for a text that holds the literal or not', () => {
    expect(evaluateTest(test, 'a NEEDLE in haystack', {})).toBe(true);
    expect(evaluateTest(test, 'a needle in a haystack', {})).toBe(false);
    expect(evaluateTest(test, 'nothing', {})).toBe(false);
  });

  it('does not run the regex for a text that holds no literal, and does for one that does', () => {
    let runs = 0;
    const counting = {
      ...test,
      regex: { test: (s: string) => ((runs += 1), test.regex?.test(s)) } as unknown as RegExp,
    };
    evaluateTest(counting, 'nothing here', {});
    expect(runs).toBe(0);
    evaluateTest(counting, 'a needle in haystack', {});
    expect(runs).toBe(1);
  });

  it('asks the prefilter about exactly the field the regex reads', () => {
    const onResponse = { ...test, field: 'tool_response' };
    expect(
      evaluateTest(onResponse, 'needle in haystack', { tool_response: 'needle in haystack' }),
    ).toBe(true);
    expect(evaluateTest(onResponse, 'needle in haystack', { tool_response: 'nothing' })).toBe(
      false,
    );
    expect(evaluateTest(onResponse, 'needle in haystack', {})).toBe(false);
  });

  it('decides a rule as it did without prefilters', () => {
    for (const text of ['NEEDLE   IN   HAYSTACK', 'needle', 'x'.repeat(5000), '']) {
      expect(ruleMatches(compiled, text, {})).toBe(
        ruleMatches(withoutPrefilters(compiled), text, {}),
      );
    }
  });
});

describe('withoutPrefilters', () => {
  it('takes the prefilter off every condition and changes nothing else', () => {
    const compiled = compileRule(rule('X-2026-00031', 'alpha_literal', '[a-z]+')).compiled;
    if (compiled === undefined) throw new Error('did not compile');
    const bare = withoutPrefilters(compiled);
    expect(bare.tests.every((test) => test.prefilter === undefined)).toBe(true);
    expect(bare.tests.map((test) => test.regex)).toEqual(compiled.tests.map((test) => test.regex));
    expect(compiled.tests[0]?.prefilter).toBeDefined();
  });
});

describe('the performance gate', () => {
  it('runs the regexes even where the prefilter would rule the blob out', () => {
    const compiled = compileRule(rule('X-2026-00032', 'neverpresent_literal\\d')).compiled;
    if (compiled === undefined) throw new Error('did not compile');
    let runs = 0;
    const counting: CompiledRule = {
      ...compiled,
      tests: compiled.tests.map((test) => ({
        ...test,
        regex: { test: () => ((runs += 1), false) } as unknown as RegExp,
      })),
    };
    expect(counting.tests[0]?.prefilter).toBeDefined();
    measureRuleTimings([counting], 1_000_000);
    expect(runs).toBeGreaterThan(0);
  });
});

describe('rules loaded from a directory', () => {
  const yaml = `id: USER-2026-00001
title: A rule of the user's own
severity: critical
detection:
  condition: any
  conditions:
    - field: content
      operator: regex
      value: "(?i)rotate\\\\s+the\\\\s+launch\\\\s+codes"
`;

  it('are given a prefilter the same way, and still match what they match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-user-rules-'));
    try {
      writeFileSync(join(dir, 'rule.yaml'), yaml);
      const loaded = loadRulesFromDir(dir);
      expect(loaded.skipped).toEqual([]);
      const { compiled } = compileRules(loaded.rules);
      expect(compiled[0]?.tests[0]?.prefilter?.literals).toEqual(['rotate']);
      expect(scanContent(compiled, 'Please ROTATE the  launch codes now').verdict).toBe('suspect');
      expect(scanContent(compiled, 'rotate the logs').verdict).toBe('clean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
