import { describe, expect, it } from 'vitest';
import { extractKeyValues, extractKeyValuesWhole } from '../../src/secrets/extract.js';
import { extractSourceSecretsWhole } from '../../src/secrets/index.js';
import { cpuNow } from '../cpu-time.js';

/**
 * A `.env` in a project folder is a file the agent or a repository can write, and `stroq sent` reads
 * each one whole, 4 MiB at a time. Each line is read by the `NAME=value` pattern, so that pattern
 * must not be able to try a line in more than one way. Held as growth, not milliseconds: each input
 * is timed at a quarter of its size and at its full size, and only one that is slow AND growing
 * faster than linear fails. Every value is made up.
 */
const SIZE = 1024 * 1024;
const BOUND_MS = 1_000;
const MAX_GROWTH = 8;

const timed = (run: () => unknown): number => {
  const started = cpuNow();
  run();
  return cpuNow() - started;
};

/** Lines of `line`, about `size` characters in all. */
const lines = (line: string) => (size: number) =>
  `${line}\n`.repeat(Math.ceil(size / (line.length + 1))).slice(0, size);

const SHAPES: ReadonlyArray<readonly [string, (size: number) => string]> = [
  // Found by the 2026-10-20 review: a lazy value followed by `\s*$` tried each run of blanks once
  // for every place the value could end.
  ['blanks inside a value', lines(`API_KEY=a${' '.repeat(4000)}b`)],
  ['blanks and a tab inside a value', lines(`API_KEY=a${' \t'.repeat(2000)}b`)],
  ['blanks after an export', lines(`export${' '.repeat(4000)}=x`)],
  ['blanks after a name', lines(`API_KEY${' '.repeat(4000)}x`)],
  ['an equals sign and blanks', lines(`=${' '.repeat(4000)}`)],
  ['a value of equals signs', lines(`API_KEY=${'= '.repeat(2000)}x`)],
  ['one long line of blanks in a value', (size) => `API_KEY=a${' '.repeat(size)}b`],
  ['quotes never closed', lines(`API_KEY="${'\\"'.repeat(2000)}`)],
  ['quoted values with comments', lines(`API_KEY="${'a'.repeat(3000)}" ${'# '.repeat(400)}`)],
  ['URL authorities of colons and ats', lines(`DATABASE_URL=postgres://${':@'.repeat(2000)}`)],
];

describe('reading NAME=value lines stays linear', () => {
  it.each(SHAPES)('%s', (_name, build) => {
    for (const read of [
      (text: string) => extractKeyValues(text),
      (text: string) => extractKeyValuesWhole(text),
      (text: string) => extractSourceSecretsWhole('/w/.env', text),
    ]) {
      const small = build(SIZE / 4);
      const big = build(SIZE);
      const quarter = timed(() => read(small));
      const full = timed(() => read(big));
      const growth = `${quarter.toFixed(0)} ms at ${SIZE / 4096} KiB, ${full.toFixed(0)} ms at ${SIZE / 1024} KiB`;
      expect(full < BOUND_MS || full < MAX_GROWTH * quarter, growth).toBe(true);
    }
  });

  // Each line is cut at 4 KiB before it is read, so a pattern that is quadratic in a line still
  // grows linearly with the file: the cost of one line is what has to be held. 1 MiB of lines of
  // blanks took 1.8 s with the lazy value, 7 s for one 4 MiB `.env`, for each file of a folder.
  it('reads 1 MiB of lines with long runs of blanks in their values quickly', () => {
    const text = lines(`API_KEY=a${' '.repeat(4000)}b`)(SIZE);
    const took = timed(() => extractSourceSecretsWhole('/w/.env', text));
    expect(took, `${took.toFixed(0)} ms`).toBeLessThan(300);
  });

  it('reads the same keys as before', () => {
    const text = [
      'API_KEY=FAKEplain0123456789',
      '  export  SECRET_TOKEN = "FAKEquoted0123456789"  ',
      'AUTH_SECRET=FAKEcommented0123456789 # note',
      'EMPTY_TOKEN=',
      'SPACED_TOKEN=   ',
      "SINGLE_KEY='FAKEsingle0123456789'\r",
      '//registry.npmjs.org/:_authToken=npm_FAKEnpm0123456789abcdefABCD',
    ].join('\n');
    expect(extractKeyValues(text)).toEqual([
      { name: 'API_KEY', value: 'FAKEplain0123456789', canary: false },
      { name: 'SECRET_TOKEN', value: 'FAKEquoted0123456789', canary: false },
      { name: 'AUTH_SECRET', value: 'FAKEcommented0123456789', canary: false },
      { name: 'SINGLE_KEY', value: 'FAKEsingle0123456789', canary: false },
      {
        name: '//registry.npmjs.org/:_authToken',
        value: 'npm_FAKEnpm0123456789abcdefABCD',
        canary: false,
      },
    ]);
  });
});
