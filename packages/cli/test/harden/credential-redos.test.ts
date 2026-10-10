import { describe, expect, it } from 'vitest';
import { MAX_SCAN_CHARS } from '@stroq/core';
import { findCredentialShape } from '../../src/harden/credential-shape.js';
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
