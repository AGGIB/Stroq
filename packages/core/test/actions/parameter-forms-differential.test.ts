import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateForm, newFormBudget } from '../../src/actions/parameter-forms.js';

/**
 * A form of a parameter that is worked out (`${1%.*}`, `${1##*.}`, `${1/a/b}`, `${1:2:3}`) is worked out as
 * the shell works it: a detector reads what is put in place of it, so a value that differs from what a shell
 * makes of it is a command read wrongly (`${1#x}` of `x/` is `/`). Each form is tried on a set of values
 * and patterns in each real shell that is installed, and what the shell prints must be what is worked out.
 * Forms that a shell does not have (`${1^^}` is not in bash 3 or zsh) are not compared in it.
 */

const SHELLS = ['/bin/bash', '/bin/zsh'].filter(
  (shell) => process.platform !== 'win32' && existsSync(shell),
);

const VALUES = [
  'a.b.c',
  'dir/file.txt',
  'x',
  '',
  'a b c',
  'A-b_C',
  '/a/b/',
  'file.tar.gz',
  '100%',
  'a:b:c',
  'aaa',
  'abcabc',
  '-rf',
  'x-rf',
  '..',
  'a//b',
];
const PATTERNS = [
  '.*',
  '*.',
  '*/',
  '/*',
  'a',
  'a*',
  '*a',
  '?',
  '??',
  '*.*',
  'b*c',
  '',
  '/',
  'x',
  '.',
  '*/*',
  'a?c',
  'abc',
  '*.gz',
  'x*',
  '-*',
  '*-',
];
const REPLACEMENTS = ['', 'X', '-', '/', 'yy'];
const OFFSETS = ['0', '1', '2', '5', '-1', '-3', '-9'];
const LENGTHS = ['0', '1', '2', '4', '-1', '-2'];

interface Case {
  readonly value: string;
  readonly form: string;
}

const cases: Case[] = [];
for (const value of VALUES) {
  for (const pattern of PATTERNS) {
    for (const operator of ['#', '##', '%', '%%'])
      cases.push({ value, form: `\${1${operator}${pattern}}` });
    for (const operator of ['/', '//']) {
      cases.push({ value, form: `\${1${operator}${pattern}}` });
      for (const by of REPLACEMENTS)
        cases.push({ value, form: `\${1${operator}${pattern}/${by}}` });
    }
  }
  for (const offset of OFFSETS) {
    // A negative offset is written with a space before it, as the shell needs it to tell it from `:-`.
    const written = offset.startsWith('-') ? ` ${offset}` : offset;
    cases.push({ value, form: `\${1:${written}}` });
    for (const length of LENGTHS) cases.push({ value, form: `\${1:${written}:${length}}` });
  }
  for (const form of ['^^', ',,', '^', ',']) cases.push({ value, form: `\${1${form}}` });
  cases.push({ value, form: '${#1}' });
}

const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** What a shell prints for each case: one line each, `ok:` and the value, or `error`. */
function inShell(shell: string, batch: readonly Case[]): string[] {
  const script = batch
    .map(
      (each) =>
        `(set -- ${quoted(each.value)}; printf 'ok:%s\\n' "${each.form}") 2>/dev/null || echo error`,
    )
    .join('\n');
  const out = execFileSync(shell, ['-c', script], { encoding: 'utf8', timeout: 60_000 });
  return out.split('\n').slice(0, batch.length);
}

describe.each(SHELLS)('the forms of a parameter that are worked out, against %s', (shell) => {
  const results = (): Map<Case, string> => {
    const found = new Map<Case, string>();
    const size = 400;
    for (let from = 0; from < cases.length; from += size) {
      const batch = cases.slice(from, from + size);
      const lines = inShell(shell, batch);
      batch.forEach((each, i) => found.set(each, lines[i] ?? 'error'));
    }
    return found;
  };

  it('are what the shell makes of them, where they are worked out', () => {
    const shellResults = results();
    const differences: string[] = [];
    let compared = 0;
    for (const each of cases) {
      const worked = evaluateForm(each.form, each.value, newFormBudget());
      const printed = shellResults.get(each) as string;
      if (worked === null || printed === 'error') continue;
      compared += 1;
      if (printed !== `ok:${worked}`)
        differences.push(
          `${each.form} of ${JSON.stringify(each.value)}: shell ${JSON.stringify(printed)}, worked out ${JSON.stringify(worked)}`,
        );
    }

    expect(differences.slice(0, 20)).toEqual([]);
    // The test is not an empty one: most of the cases are worked out.
    expect(compared).toBeGreaterThan(1500);
  }, 120_000);
});

describe('the forms of a parameter that are not worked out', () => {
  it.each([
    ['a value with an expansion', '${1#*/}', '$HOME/x'],
    ['a value with a glob', '${1%.*}', '*.txt'],
    ['a value with a quote', '${1%.*}', "it's.txt"],
    ['a value with a backslash', '${1%.*}', 'a\\b.c'],
    ['a pattern with a class', '${1#[a-z]}', 'abc'],
    ['a pattern with a quote', '${1#"a"}', 'abc'],
    ['a pattern with an expansion', '${1#$x}', 'abc'],
    ['an anchored replacement', '${1/#a/b}', 'abc'],
    ['a replacement that can be empty', '${1//*/b}', 'abc'],
    ['an indirection', '${!1}', 'abc'],
    ['a second digit', '${10}', 'abc'],
    ['a negative length that ends before it starts', '${1:3:-5}', 'abcdef'],
    ['a case form with a pattern', '${1^^a}', 'abc'],
    ['a replacement with an ampersand', '${1/a/&&}', 'abc'],
  ])('is %s', (_name, form, value) => {
    expect(evaluateForm(form, value, newFormBudget())).toBeNull();
  });

  it('is not worked out for a value past what it may cost to try every cut of', () => {
    expect(evaluateForm('${1##*a}', 'a'.repeat(200), newFormBudget())).toBeNull();
  });

  it('gives up where the work it may spend is spent', () => {
    const budget = { steps: 10 };

    expect(evaluateForm('${1//a/b}', 'aaaaaaaaaaaaaaaa', budget)).toBeNull();
  });
});
