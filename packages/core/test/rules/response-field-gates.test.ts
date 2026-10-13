import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compileRules,
  loadFieldFixtures,
  loadRuleSources,
  RulesBuildError,
  runBenignGate,
  runOwnExampleGate,
} from '../../../../scripts/lib/rules-pipeline.js';

/**
 * The rules that read a tool's response or a tool's description are read in production now, and the
 * gates that decide which rules ship have to read them the way production does:
 *
 * - a benign fixture is the text, and also the response and the description;
 * - a fixture in `benign-field/<field>/` is that field alone, so a page that quotes an attack as an
 *   example does not disable the rules on `content` that are right to match the quotation;
 * - a rule that can fire only through such a field must match one of its own examples through it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-field-gates-'));
  dirs.push(dir);
  return dir;
};

const rule = (id: string, conditions: string, extra = ''): string =>
  `id: ${id}\ntitle: t\nseverity: high\n${extra}detection:\n  condition: any\n  conditions:\n${conditions}`;
const cond = (field: string, value: string): string =>
  `    - field: ${field}\n      operator: contains\n      value: ${JSON.stringify(value)}\n`;
const withExamples = (...examples: string[]): string =>
  `test_cases:\n  true_positives:\n${examples.map((e) => `    - ${e}\n      expected: detected\n`).join('')}`;

const compiledFrom = (files: Record<string, string>) => {
  const dir = temp();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const { rules } = loadRuleSources([dir]);
  return { rules, compiled: compileRules(rules).compiled };
};

describe('the benign gate, for a rule that reads a response', () => {
  it('disables a rule whose response condition fires on a benign fixture', () => {
    const { compiled } = compiledFrom({
      'a.yaml': rule('ATR-2099-10001', cond('tool_response', 'needle')),
    });
    const result = runBenignGate(compiled, [
      { name: 'page.md', text: 'a page with a needle in it' },
    ]);
    expect(result.disabled.get('ATR-2099-10001')).toBe('page.md');
  });

  it('does the same for a description condition', () => {
    const { compiled } = compiledFrom({
      'a.yaml': rule('ATR-2099-10002', cond('tool_description', 'needle')),
    });
    expect(
      runBenignGate(compiled, [{ name: 'page.md', text: 'needle' }]).disabled.has('ATR-2099-10002'),
    ).toBe(true);
  });

  it('leaves alone a rule that reads a field nobody supplies', () => {
    const { compiled } = compiledFrom({
      'a.yaml': rule('ATR-2099-10003', cond('user_input', 'needle')),
    });
    expect(runBenignGate(compiled, [{ name: 'page.md', text: 'needle' }]).disabled.size).toBe(0);
  });

  it('throws for a Stroq rule that fires on a response fixture', () => {
    const { compiled } = compiledFrom({
      'a.yaml': rule('STROQ-2099-10004', cond('tool_response', 'needle')),
    });
    expect(() => runBenignGate(compiled, [{ name: 'page.md', text: 'needle' }])).toThrow(
      RulesBuildError,
    );
  });
});

describe('a fixture that is one field and nothing else', () => {
  const both = {
    'content.yaml': rule('ATR-2099-20001', cond('content', 'needle')),
    'response.yaml': rule('ATR-2099-20002', cond('tool_response', 'needle')),
    'description.yaml': rule('ATR-2099-20003', cond('tool_description', 'needle')),
  };

  it('is read by the rules that read that field, and by no rule on `content`', () => {
    const { compiled } = compiledFrom(both);
    const result = runBenignGate(compiled, [
      { name: 'tool_response/page.txt', text: 'needle', field: 'tool_response' },
    ]);
    expect([...result.disabled.keys()]).toEqual(['ATR-2099-20002']);
  });

  it('is not read by a rule on the other field', () => {
    const { compiled } = compiledFrom(both);
    const result = runBenignGate(compiled, [
      { name: 'tool_description/page.txt', text: 'needle', field: 'tool_description' },
    ]);
    expect([...result.disabled.keys()]).toEqual(['ATR-2099-20003']);
  });

  it('as a plain fixture, is read by all three', () => {
    const { compiled } = compiledFrom(both);
    const result = runBenignGate(compiled, [{ name: 'page.md', text: 'needle' }]);
    expect([...result.disabled.keys()].sort()).toEqual([
      'ATR-2099-20001',
      'ATR-2099-20002',
      'ATR-2099-20003',
    ]);
  });
});

describe('loading the fixtures of a field', () => {
  it('reads <field>/<file> as that field', () => {
    const root = temp();
    mkdirSync(join(root, 'tool_response'));
    mkdirSync(join(root, 'tool_description'));
    writeFileSync(join(root, 'tool_response', 'a.txt'), 'one');
    writeFileSync(join(root, 'tool_description', 'b.txt'), 'two');
    const loaded = [...loadFieldFixtures(root)].sort((x, y) => x.name.localeCompare(y.name));
    expect(loaded).toEqual([
      { name: 'tool_description/b.txt', text: 'two', field: 'tool_description' },
      { name: 'tool_response/a.txt', text: 'one', field: 'tool_response' },
    ]);
  });

  it('has none where there is no directory', () => {
    expect(loadFieldFixtures(join(temp(), 'missing'))).toEqual([]);
  });

  it('refuses a directory named for a field nobody supplies, which nothing would read', () => {
    const root = temp();
    mkdirSync(join(root, 'user_input'));
    writeFileSync(join(root, 'user_input', 'a.txt'), 'x');
    expect(() => loadFieldFixtures(root)).toThrow(RulesBuildError);
  });
});

describe('the own-example gate', () => {
  it('keeps a rule that matches one of its own examples through the field', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule(
        'ATR-2099-30001',
        cond('tool_response', 'needle'),
        withExamples('tool_response: "no match here"', 'tool_response: "a needle"'),
      ),
    });
    expect(runOwnExampleGate(compiled, rules).disabled.size).toBe(0);
  });

  it('reads an example under whichever key the corpus put it', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule(
        'ATR-2099-30002',
        cond('tool_response', 'needle'),
        withExamples('input: "a needle"'),
      ),
    });
    expect(runOwnExampleGate(compiled, rules).disabled.size).toBe(0);
  });

  it('disables a rule that matches none of its own examples, and says how many', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule(
        'ATR-2099-30003',
        cond('tool_response', 'needle'),
        withExamples('tool_response: "one"', 'tool_response: "two"'),
      ),
    });
    expect(runOwnExampleGate(compiled, rules).disabled.get('ATR-2099-30003')).toBe(
      'reads tool_response and matches none of its 2 own examples',
    );
  });

  it('disables a rule with no example, which has nothing to show', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule('ATR-2099-30004', cond('tool_description', 'needle')),
    });
    expect(runOwnExampleGate(compiled, rules).disabled.get('ATR-2099-30004')).toBe(
      'reads tool_description and has no example of its own to show it matches',
    );
  });

  it('is not asked of a rule on `content`, which has been matching real text all along', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule('ATR-2099-30005', cond('content', 'needle')),
    });
    expect(runOwnExampleGate(compiled, rules).disabled.size).toBe(0);
  });

  it('is not asked of a rule that waits for a field nobody supplies', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule('ATR-2099-30006', cond('user_input', 'needle')),
    });
    expect(runOwnExampleGate(compiled, rules).disabled.size).toBe(0);
  });

  it('is asked of the response condition of a rule that has others, if it has no content one', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule(
        'ATR-2099-30007',
        cond('tool_response', 'needle') + cond('user_input', 'other'),
        withExamples('user_input: "other"'),
      ),
    });
    // The example matches the `user_input` condition, which nobody supplies: it shows nothing.
    expect(runOwnExampleGate(compiled, rules).disabled.has('ATR-2099-30007')).toBe(true);
  });

  it('fails the build for a Stroq rule that cannot show it matches', () => {
    const { compiled, rules } = compiledFrom({
      'a.yaml': rule('STROQ-2099-30008', cond('tool_response', 'needle')),
    });
    expect(() => runOwnExampleGate(compiled, rules)).toThrow(RulesBuildError);
  });
});
