import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_PATTERN_PATHS,
  filesNamedBy,
  isPattern,
  matchesPattern,
  newPatternBudget,
} from '../../src/actions/file-glob.js';
import { cpuNow } from '../cpu-time.js';

let dir = '';
const named = (pattern: string): string[] =>
  [...filesNamedBy(pattern, dir, newPatternBudget()).paths].sort();

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-file-glob-')));
  for (const file of ['x.sh', 'y.sh', 'xx.sh', '.hidden.sh', 'a.bash', 'Z.SH', 'file[1].sh', 'q']) {
    writeFileSync(join(dir, file), '');
  }
  mkdirSync(join(dir, 'd'));
  mkdirSync(join(dir, 'e'));
  for (const file of ['d/z.sh', 'd/.q.sh', 'e/z.sh', 'e/w.txt']) writeFileSync(join(dir, file), '');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('matchesPattern: a name against a pattern as a shell reads one', () => {
  it.each<[string, string, boolean]>([
    ['*', 'abc', true],
    ['*', '', true],
    ['a*c', 'abc', true],
    ['a*c', 'ac', true],
    ['a*c', 'ab', false],
    ['a**c', 'axc', true],
    ['a?c', 'abc', true],
    ['a?c', 'ac', false],
    ['*.sh', 'x.sh', true],
    ['*.sh', 'x.bash', false],
    ['[a-c]x', 'bx', true],
    ['[a-c]x', 'dx', false],
    ['[!a-c]x', 'dx', true],
    ['[!a-c]x', 'bx', false],
    ['[^a-c]x', 'dx', true],
    ['[]]', ']', true],
    ['[^]]', 'a', true],
    ['[a-]', '-', true],
    ['[[:digit:]]*', '9a', true],
    ['[[:digit:]]', 'a', false],
    ['[[:alpha:][:digit:]]', '7', true],
    ['[[:nonsense:]]', 'a', true],
    ['a\\*', 'a*', true],
    ['a\\*', 'ab', false],
    ['[a', '[a', true],
    ['[a', 'a', false],
    ['x.s[h]', 'x.sh', true],
    ['*a*a*a*b', 'aaaaaaaaaa', false],
    ['*a*b*c', 'xaybzc', true],
  ])('%j against %j is %s', (pattern, name, expected) => {
    expect(matchesPattern(pattern, name)).toBe(expected);
  });
});

describe('isPattern', () => {
  it.each(['x.s?', '*.sh', 'x.s[h]', '{x,y}.sh', 'a/*/b'])(
    '%s may stand for more than itself',
    (name) => {
      expect(isPattern(name)).toBe(true);
    },
  );
  it.each(['x.sh', './scripts/run.sh', '~/x.sh'])('%s stands for itself', (name) => {
    expect(isPattern(name)).toBe(false);
  });
});

describe('filesNamedBy: the files a name stands for', () => {
  it.each<[string, string[]]>([
    ['*.sh', ['file[1].sh', 'x.sh', 'xx.sh', 'y.sh']],
    ['?.sh', ['x.sh', 'y.sh']],
    ['x.s?', ['x.sh']],
    ['x.s[h]', ['x.sh']],
    ['x.s[!a]', ['x.sh']],
    ['x.s[a-z]', ['x.sh']],
    ['x.[[:alpha:]]h', ['x.sh']],
    ['./x.*', ['./x.sh']],
    ['{x,y}.sh', ['x.sh', 'y.sh']],
    ['x{.sh,.bash}', ['x.bash', 'x.sh']],
    ['x{x,}.sh', ['x.sh', 'xx.sh']],
    ['*/z.sh', ['d/z.sh', 'e/z.sh']],
    ['?/z.sh', ['d/z.sh', 'e/z.sh']],
    ['d/*.sh', ['d/z.sh']],
    ['d/.*.sh', ['d/.q.sh']],
    ['.*/x.sh', ['./x.sh']],
    ['d/**', ['d/z.sh']],
    ['.*.sh', ['.hidden.sh']],
    ['./*/z.sh', ['./d/z.sh', './e/z.sh']],
    ['file[[]1].sh', ['file[1].sh']],
    ['nothing*', []],
    ['nodir/*.sh', []],
    ['x.s\\?', []],
    ['x.s?(.)', ['x.sh']],
    ['x.s*(.)', ['x.sh']],
    // A group is a `*`, which matches what it would and more: a file may be read that it would not name.
    ['@(x|y).sh', ['file[1].sh', 'x.sh', 'xx.sh', 'y.sh']],
    ['x.+(sh)', ['x.sh']],
  ])('%s', (pattern, expected) => {
    expect(named(pattern)).toEqual(expected);
  });

  it('does not match a name that begins with a dot by a wildcard', () => {
    expect(named('*')).not.toContain('.hidden.sh');
    expect(named('*')).toContain('x.sh');
  });

  it('is given absolute patterns as it is given them', () => {
    expect(named(`${dir}/x.s?`)).toEqual([`${dir}/x.sh`]);
    expect(named(`${dir}/*/z.sh`)).toEqual([`${dir}/d/z.sh`, `${dir}/e/z.sh`]);
  });

  it('is complete when nothing was cut off', () => {
    expect(filesNamedBy('*.sh', dir, newPatternBudget()).complete).toBe(true);
    expect(filesNamedBy('{x,y}.sh', dir, newPatternBudget()).complete).toBe(true);
  });

  it.each(['*.sh~y', '*.sh#', '^*.sh', '*(x|y', 'x.*(a|(b)'])(
    'says so when %s is a form of pattern it does not read',
    (pattern) => {
      expect(filesNamedBy(pattern, dir, newPatternBudget()).complete).toBe(false);
    },
  );

  it.each(['***/z.sh', 'x.s[[.h.]]', '[[=x=]].sh'])(
    'says so when %s is a form that goes below one level or is read another way',
    (pattern) => {
      expect(filesNamedBy(pattern, dir, newPatternBudget()).complete).toBe(false);
    },
  );

  it('says so for every pattern word when the command sets an option that changes matching', () => {
    const budget = newPatternBudget();
    budget.unreliable = true;
    expect(filesNamedBy('*.sh', dir, budget).complete).toBe(false);
    expect(filesNamedBy('x.sh', dir, budget).complete).toBe(true);
  });

  it('lists only what is there when a pattern ends in a literal name', () => {
    expect(named('*/z.sh')).toEqual(['d/z.sh', 'e/z.sh']);
    expect(named('*/not-there.sh')).toEqual([]);
  });

  it('reads a segment once, however many words hold it, and pays for it by its length', () => {
    const budget = newPatternBudget();
    const hostile = `{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}${'[[:'.repeat(60)}`;
    const started = cpuNow();
    const found = filesNamedBy(hostile, dir, budget);
    expect(cpuNow() - started).toBeLessThan(1000);
    expect(found.paths).toEqual([]);
    expect(budget.steps).toBeLessThan(400_000);
  });

  it('says so when a recursive segment is not listed', () => {
    const found = filesNamedBy('**/z.sh', dir, newPatternBudget());
    expect(found.complete).toBe(false);
  });

  it('says so when a brace expansion makes more than it reads', () => {
    const bomb = '{a,b}'.repeat(7) + '.sh';
    expect(filesNamedBy(bomb, dir, newPatternBudget()).complete).toBe(false);
  });

  it('says so when a pattern is longer than it reads', () => {
    expect(filesNamedBy(`${'a'.repeat(300)}*`, dir, newPatternBudget()).complete).toBe(false);
  });

  it('says so, and keeps the first, when a pattern stands for more files than it reads', () => {
    const many = join(dir, 'many');
    mkdirSync(many);
    for (let n = 0; n < MAX_PATTERN_PATHS + 10; n += 1) writeFileSync(join(many, `s${n}.sh`), '');
    const found = filesNamedBy('many/*.sh', dir, newPatternBudget());
    expect(found.complete).toBe(false);
    expect(found.paths.length).toBeLessThanOrEqual(MAX_PATTERN_PATHS);
    expect(found.paths.length).toBeGreaterThan(0);
  });

  it('says so when a directory holds more entries than it reads', () => {
    const wide = join(dir, 'wide');
    mkdirSync(wide);
    for (let n = 0; n < 4200; n += 1) writeFileSync(join(wide, `f${n}`), '');
    expect(filesNamedBy('wide/f1*', dir, newPatternBudget()).complete).toBe(false);
  });

  it('lists a directory once for every pattern one command holds', () => {
    const budget = newPatternBudget();
    filesNamedBy('*.sh', dir, budget);
    const left = budget.entries;
    filesNamedBy('?.sh', dir, budget);
    expect(budget.entries).toBe(left);
  });

  it('spends a counted number of steps on a pattern built to be slow', () => {
    const slow = join(dir, 'slow');
    mkdirSync(slow);
    for (let n = 0; n < 200; n += 1) writeFileSync(join(slow, `${'a'.repeat(200)}${n}`), '');
    const started = cpuNow();
    const found = filesNamedBy(`slow/*${'a'.repeat(100)}b`, dir, newPatternBudget());
    expect(cpuNow() - started).toBeLessThan(2000);
    expect(found.paths).toEqual([]);
    expect(found.complete).toBe(false);
  });

  it('says so when its steps are used up', () => {
    const budget = newPatternBudget();
    budget.steps = 5;
    expect(filesNamedBy('*.sh', dir, budget).complete).toBe(false);
  });
});
