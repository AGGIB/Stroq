import { describe, expect, it } from 'vitest';
import { MAX_SCAN_CHARS } from '@stroq/core';
import { findCredentialShape, hiddenLineMask } from '../../src/harden/credential-shape.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import type { JsonEdit, JsonPlan } from '../../src/harden/types.js';
import { cpuNow } from '../helpers/cpu-time.js';

/**
 * A repository can commit a config file, and the engine reads config files with patterns. The
 * reading must take time linear in the file, whatever shape the file has.
 *
 * The first test is the shape that made core's `NAME=VALUE` pattern quadratic: a name, a sign, a
 * letter, a long run of spaces and a letter that ends the line. At this length one line costs
 * that pattern about 13 ms of processor time, and a file of the largest size it is willing to read
 * costs it several seconds; the same file costs the linear reader a few hundredths of one.
 */
const LINE_LENGTH = 4094;
const FILE_BUDGET = MAX_SCAN_CHARS - 200_000;

/** Lines of `line`, as many as fit in a file under the scan limit. */
const fileOf = (line: string): string =>
  Array.from({ length: Math.floor(FILE_BUDGET / (line.length + 1)) }, () => line).join('\n');

/** The processor time `fn` takes, in milliseconds as a reference machine would count them. */
function cpuTime(fn: () => unknown): number {
  const started = cpuNow();
  fn();
  return cpuNow() - started;
}

describe('findCredentialShape: a name, a sign and a run of spaces', () => {
  it('reads a file of lines like `a=b` + 4,090 spaces + `c` in linear time', () => {
    const text = fileOf(`a=b${' '.repeat(4090)}c`);
    expect(text.length).toBeGreaterThan(1_000_000);
    expect(text.split('\n')[0]).toHaveLength(LINE_LENGTH);

    let shape: unknown;
    const took = cpuTime(() => {
      shape = findCredentialShape(text);
    });

    expect(shape).toBeNull();
    // Quadratic reading takes about 5 s here; linear reading takes a small fraction of one.
    expect(took).toBeLessThan(2_000);
  });
});

describe('findCredentialShape: shapes that make a careless pattern backtrack', () => {
  const spaces = ' '.repeat(4000);
  const shapes: [string, string][] = [
    ['export and a run of spaces', fileOf(`export${spaces}a=b`)],
    ['a name, a run of spaces and a sign', fileOf(`a${spaces}=b`)],
    ['a sign, a run of tabs and a letter', fileOf(`a=b${'\t'.repeat(4000)}c`)],
    ['a value with a comment mark in every other place', fileOf(`a=${' #'.repeat(2000)}`)],
    ['signs only', fileOf('='.repeat(4000))],
    ['names that never get a sign', fileOf('a'.repeat(4000))],
    ['the word authorization over and over', fileOf('authorization '.repeat(280))],
    ['a header with a long gap', fileOf(`authorization:${spaces}bearer${spaces}x`)],
    ['bearer over and over', fileOf('Authorization: Bearer '.repeat(180))],
    ['scheme separators over and over', fileOf('://'.repeat(1300))],
    ['a scheme and a very long user name', fileOf(`http://${'u'.repeat(4000)}`)],
    ['a scheme, a user name and no host', fileOf(`x://${'a:'.repeat(1900)}`)],
    ['an at sign after a very long password', fileOf(`h://u:${'p'.repeat(3900)}@`)],
    ['secret flags over and over', fileOf('--password '.repeat(350))],
    ['secret flags joined to nothing', fileOf('--token='.repeat(480))],
    ['key block headers over and over', fileOf('-----BEGIN '.repeat(350))],
    ['a key block header with a very long label', fileOf(`-----BEGIN ${'A'.repeat(3900)}`)],
    ['wrapping characters around a word', fileOf(`--token ${'))))'.repeat(950)}x`)],
    ['one very long line', 'x'.repeat(FILE_BUDGET)],
    ['assignments over and over', fileOf('N1=abcdef N2=abcdef N3=abcdef '.repeat(130))],
    ['a short assignment over and over', fileOf('x=y '.repeat(1000))],
    ['query parameters over and over', fileOf('?a=b&c=d?e=f#g=h;'.repeat(230))],
    ['npmrc names over and over', fileOf('//r/:_authToken=${T} '.repeat(190))],
    ['a name and a colon over and over', fileOf('a:b '.repeat(1000))],
    ['a header flag over and over', fileOf('-H password: '.repeat(300))],
    ['a header flag and nothing', fileOf('-H '.repeat(1300))],
    ['a user flag over and over', fileOf('-u a:b '.repeat(570))],
    ['an option with an assignment over and over', fileOf('--env=A=b '.repeat(400))],
    ['a long run of slashes as a value', fileOf(`--token ${'/'.repeat(3900)}`)],
    ['a long run of dollar signs as a value', fileOf(`--token ${'$'.repeat(3900)}`)],
    ['a long run of dashes as a value', fileOf(`--token ${'-'.repeat(3900)}`)],
    ['mysql with -p repeated', fileOf('mysql -psecret '.repeat(270))],
    ['mysql one very long password', fileOf(`mysql -p${'a'.repeat(3900)}`)],
    ['sudo repeated then mysql', fileOf(`${'sudo '.repeat(500)}mysql -psecret`)],
    ['docker login -p repeated', fileOf('docker login -u user -p secret '.repeat(100))],
    ['sshpass -p repeated', fileOf('sshpass -p secret ssh host '.repeat(120))],
    ['redis-cli -a repeated', fileOf('redis-cli -a secret ping '.repeat(150))],
    ['repeated separators in command line', fileOf('; && || | '.repeat(400))],
    ['repeated command substitutions', fileOf('$('.repeat(1000) + ')'.repeat(1000))],
    ['semicolons run ending with word and separator', fileOf(';'.repeat(4000) + 'x;')],
    ['ampersands run ending with word and separator', fileOf('&'.repeat(4000) + 'x;')],
  ];

  it.each(shapes)('reads %s in linear time', (_name, text) => {
    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(3_000);
  });

  it('reads a JSON document with the same shapes inside its strings', () => {
    const strings = [
      `a=b${' '.repeat(4090)}c`,
      `authorization:${spaces}bearer${spaces}x`,
      '://'.repeat(1300),
      '--password '.repeat(350),
      '-----BEGIN '.repeat(350),
      `--token ${'))))'.repeat(950)}x`,
    ];
    const text = JSON.stringify({
      list: strings.flatMap((s) => Array.from({ length: 40 }, () => s)),
    });

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(3_000);
  });

  it('reads one string of a JSON document that is as long as a file may be, with the same shapes in it', () => {
    const shapes = [
      'N1=abcdef ',
      '?a=b&c=d;',
      'a:b ',
      '-H password: ',
      '-u a:b ',
      'x=y ',
      '//r/:_t=${T} ',
      'mysql -psecret ',
      'docker login -p sec ',
      'sshpass -p sec ',
      'redis-cli -a sec ',
    ];
    for (const shape of shapes) {
      const text = JSON.stringify({ command: shape.repeat(Math.floor(1_900_000 / shape.length)) });
      expect(text.length).toBeLessThan(MAX_SCAN_CHARS);

      const took = cpuTime(() => findCredentialShape(text));

      expect(took, shape).toBeLessThan(3_000);
    }
  });

  it('reads a long run of separators ending with word and separator in linear time', () => {
    const text = JSON.stringify({ command: ';'.repeat(150_000) + 'x;' });

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(3_000);
  });

  it('reads a JSON document with a great many tiny strings in linear time', () => {
    const text = `{"list":[${'"a",'.repeat(300_000)}"b"]}`;

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(3_000);
  });

  it('reads a JSON document with a great many keys in linear time', () => {
    const text = `{${Array.from({ length: 100_000 }, (_, i) => `"k${i}":"v"`).join(',')}}`;

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(3_000);
  });
});

/**
 * A name is read once, where its key is, and an array hands the verdict down to its items. Reading
 * the key again for every item makes the cost the length of the key times the number of items:
 * a hostile repo can commit a 1.9 MB settings file (under the scan limit, valid JSON, one key)
 * that took one call of this reader 175 s. The shapes below are the ones that were measured.
 */
describe('findCredentialShape: a long key above a long list', () => {
  const list = (count: number, item = 'a'): string =>
    Array.from({ length: count }, () => JSON.stringify(item)).join(',');
  const under = (key: string, body: string): string => `{${JSON.stringify(key)}:[${body}]}`;

  it('reads a 400,000-character key above 20,000 items in a few CPU seconds', () => {
    const text = under('k'.repeat(400_000), list(20_000));

    const took = cpuTime(() => findCredentialShape(text));

    // Per-item reading of the key took 5.8 s on the machine that measured it.
    expect(took).toBeLessThan(1_000);
  });

  it('reads a 900,000-character key above 250,000 items in a few CPU seconds', () => {
    const text = under('k'.repeat(900_000), list(250_000));
    expect(text.length).toBeGreaterThan(1_800_000);
    expect(text.length).toBeLessThan(MAX_SCAN_CHARS);

    const took = cpuTime(() => findCredentialShape(text));

    // This one took 175 s.
    expect(took).toBeLessThan(1_000);
  });

  it('reads long items under a long key, which the name rules read as well', () => {
    // Not `xxxx...`: that is a placeholder, and is set aside before the name is looked at.
    const text = under('k'.repeat(300_000), list(8_000, 'abcdefghij'.repeat(4)));

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(1_000);
  });

  it('reads a key that is as long as a key may be above the most items it may hold', () => {
    const text = under('k'.repeat(512), list(50_000));

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(2_000);
  });

  it('reads lists nested very deep under one key', () => {
    const depth = 40_000;
    const text = `{${JSON.stringify('k'.repeat(500))}:${'['.repeat(depth)}${list(40_000)}${']'.repeat(depth)}}`;

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(2_000);
  });

  it('reads objects nested very deep, each with a key of its own', () => {
    const depth = 8_000;
    const key = JSON.stringify('k'.repeat(60));
    const text = `${`{${key}:`.repeat(depth)}"a"${'}'.repeat(depth)}`;

    const took = cpuTime(() => findCredentialShape(text));

    expect(took).toBeLessThan(2_000);
  });
});

describe('planJsonEdits: a hostile file costs the same as any other', () => {
  it('plans an edit of a 490 KB file with a 400,000-character key above 10,000 items', () => {
    // Sized so that the file, and the text after the edit lays it out one item to a line, are both
    // small enough for a diff: a plan that is refused as too large never reads the file at all.
    const body = Array.from({ length: 10_000 }, () => '"a"').join(',');
    const text = `{${JSON.stringify('k'.repeat(400_000))}:[${body}]}`;
    const edit: JsonEdit = { kind: 'json-array-add', path: ['permissions', 'deny'], value: 'x' };

    let plan: JsonPlan | undefined;
    const took = cpuTime(() => {
      plan = planJsonEdits('/project/settings.json', [edit], { read: () => text });
    });

    // Reading the key for every item took 25.7 s for the plan of a file this shape. A file the
    // reader could not look at all the way through is not one to copy, and the plan says so.
    expect(took).toBeLessThan(3_000);
    expect(plan?.backup).toBe('none-unchecked');
  });
});

describe('findCredentialShape: lines made of the pieces the readers look for', () => {
  // A seeded generator, so that a failure is the same failure on the next run.
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }
  const pieces = [
    'password',
    'TOKEN',
    'API_KEY',
    'exaApiKey',
    'Authorization',
    'Bearer',
    'Basic',
    'Token',
    '=',
    ':',
    '?',
    '&',
    '#',
    ';',
    '-H',
    '-u',
    '-p',
    '-a',
    '--user',
    '--token',
    '--env=',
    '--header=',
    'mysql',
    'mariadb',
    'mysqldump',
    'docker',
    'podman',
    'login',
    'sshpass',
    'redis-cli',
    "'",
    '"',
    '`',
    '$',
    '${',
    '}',
    '<',
    '>',
    '/',
    '//',
    '~',
    '-',
    '--',
    '.',
    '...',
    '@',
    '*',
    'https://',
    'user:',
    ':pass',
    'abcd1234',
    'hunter2',
    'x',
    ' ',
    ' ',
    ' ',
    '\t',
    '\\',
    '(',
    ')',
    '[',
    ']',
    ',',
    '_',
    '0',
    'ghp_',
    'sk_live_',
    '-----BEGIN ',
    'PRIVATE KEY',
    'İ',
    'é',
  ];

  it('never throws, and gives the same answer twice, for 4,000 of them', () => {
    const next = generator(2026);
    const shapes = new Set<string>();
    const began = cpuNow();
    for (let n = 0; n < 4_000; n += 1) {
      const count = 1 + Math.floor(next() * 40);
      const line = Array.from(
        { length: count },
        () => pieces[Math.floor(next() * pieces.length)],
      ).join('');
      for (const text of [line, JSON.stringify({ a: line }), JSON.stringify([line, line])]) {
        const shape = findCredentialShape(text);
        expect(findCredentialShape(text)).toBe(shape);
        shapes.add(String(shape));
        expect(() => hiddenLineMask(text)(0, text)).not.toThrow();
      }
    }
    // The mix finds things and leaves things alone; a generator that did only one would test little.
    expect(shapes.size).toBeGreaterThan(2);
    expect(cpuNow() - began).toBeLessThan(10_000);
  });
});
