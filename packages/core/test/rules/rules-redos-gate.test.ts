import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { loadBundledRules } from '../../src/rules/bundle.js';
import { SUPPLIED_FIELDS } from '../../src/rules/supplied-fields.js';
import { cpuNow } from '../cpu-time.js';

/**
 * A tool's response is scanned whole (up to 200,000 characters) inside a hook that has seconds to
 * answer, and a regex that is slow on a long repetitive text blocks the event loop so that nothing
 * can interrupt it: the hook is cut off before it has recorded anything. The build's timing gate
 * once gave a rule only its `content`, so the conditions on a tool's response or description were
 * never timed, and the blobs it used had no repetitive prose, no run of blanks or line breaks and
 * no hyphenated words. These shapes are those of the conditions that were slow.
 *
 * Every run goes through `vm` with a timeout, so a pattern that blows up fails this test and does
 * not hang it. The bound is on processor time, divided by how slow this machine is (see
 * `cpu-time.ts`), and well above what a linear pattern costs on text of this size.
 */
const rep = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const GENERIC: ReadonlyArray<readonly [string, (size: number) => string]> = [
  ['single-letter words', (n) => rep('A ', n)],
  ['lower-case words', (n) => rep('a ', n)],
  ['prose', (n) => rep('lorem ipsum dolor sit amet ', n)],
  ['one letter', (n) => 'a'.repeat(n)],
  ['hyphenated', (n) => rep('a-b-', n)],
  ['line breaks', (n) => '\n'.repeat(n)],
  ['blanks', (n) => ' '.repeat(n)],
  ['short lines', (n) => rep('word\n', n)],
  ['dashes', (n) => '-'.repeat(n)],
  ['quote marks', (n) => rep('> ', n)],
  ['quoted lines', (n) => rep('>\n', n)],
  ['open brackets', (n) => '['.repeat(n)],
  ['open parentheses', (n) => '('.repeat(n)],
  ['open braces', (n) => '{'.repeat(n)],
  ['angle brackets', (n) => '<'.repeat(n)],
  ['pipes', (n) => '|'.repeat(n)],
  ['backslashes', (n) => '\\'.repeat(n)],
  ['double quotes', (n) => '"'.repeat(n)],
  ['links with no end', (n) => rep('[a](http://x', n)],
  ['markers with no end', (n) => rep('[[ EMAIL ', n)],
  ['pound signs', (n) => '#'.repeat(n)],
  ['underscores', (n) => '_'.repeat(n)],
  ['digits', (n) => rep('1234567890', n)],
  ['base64', (n) => rep('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', n)],
  ['key and value', (n) => rep('key: value\n', n)],
];
const GENERIC_CHARS = 20_000;
const GENERIC_BOUND_MS = 250;

const rules = loadBundledRules();
const conditions = rules.flatMap((rule) =>
  rule.tests.flatMap((test, index) =>
    test.regex !== undefined && SUPPLIED_FIELDS.has(test.field)
      ? [{ id: `${rule.id}#${index}`, regex: test.regex }]
      : [],
  ),
);

/** Runs the pattern on the text under a wall-clock cut-off, and returns processor milliseconds, or Infinity if cut off. */
function timed(regex: RegExp, text: string): number {
  const context = vm.createContext({ regex, text });
  const script = new vm.Script('regex.test(text)');
  const started = cpuNow();
  try {
    script.runInContext(context, { timeout: 2_000 });
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return cpuNow() - started;
}

describe('the conditions of the bundled rules on text that repeats', () => {
  it('has conditions on the fields Stroq supplies to try', () => {
    expect(conditions.length).toBeGreaterThan(500);
  });

  it(`takes under ${GENERIC_BOUND_MS} ms on ${GENERIC_CHARS} characters of any of ${GENERIC.length} shapes`, () => {
    const slow: string[] = [];
    for (const [shape, build] of GENERIC) {
      const text = build(GENERIC_CHARS);
      for (const { id, regex } of conditions) {
        const ms = timed(regex, text);
        if (ms > GENERIC_BOUND_MS) slow.push(`${id} on ${shape}: ${ms.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 300_000);
});

/**
 * The conditions that were slow, each on the shapes it was slow on, at a size where a quadratic
 * one costs seconds, and the one that was exponential on a line of `>` marks at a size where it
 * would never have finished.
 */
const TAILORED: ReadonlyArray<readonly [string, number, ReadonlyArray<(n: number) => string>]> = [
  [
    'ATR-2026-00139#0',
    0,
    [(n) => ' '.repeat(n), (n) => '\n'.repeat(n), (n) => rep('lead said ', n)],
  ],
  [
    'ATR-2026-00256#4',
    4,
    [(n) => '\n'.repeat(n), (n) => rep('\n ', n), (n) => `\n${'A'.repeat(n)}`],
  ],
  [
    'ATR-2026-00265#2',
    2,
    [(n) => '\n'.repeat(n), (n) => `---${'\n'.repeat(n)}x`, (n) => rep('--- \n', n)],
  ],
  ['ATR-2026-00277#1', 1, [(n) => '\n'.repeat(n), (n) => rep('\n ', n)]],
  ['ATR-2026-00282#0', 0, [(n) => '\n'.repeat(n), (n) => rep('\nIGNORE ', n)]],
  [
    'ATR-2026-00282#1',
    1,
    [(n) => '\n'.repeat(n), (n) => rep('\n---\n', n), (n) => rep('\n--- \n', n)],
  ],
  [
    'ATR-2026-00282#4',
    4,
    [
      (n) => rep('> ', n),
      (n) => rep('>\n', n),
      (n) => rep('\n> ', n),
      (n) => `\n${rep('>  ', n)}x`,
    ],
  ],
  [
    'ATR-2026-00290#3',
    3,
    [
      (n) => rep('A ', n),
      (n) => rep('lorem ipsum dolor sit amet ', n),
      (n) => rep('a\n', n),
      (n) => rep('w1 \x01', n),
    ],
  ],
  ['ATR-2026-00321#4', 4, [(n) => '_'.repeat(n), (n) => rep('_ ', n), (n) => rep('>', n)]],
  ['ATR-2026-00328#3', 3, [(n) => 'a'.repeat(n), (n) => rep('1234567890', n)]],
  ['ATR-2026-00330#2', 2, [(n) => 'A'.repeat(n), (n) => rep('A1', n), (n) => rep('AB ', n)]],
  ['ATR-2026-00418#3', 3, [(n) => '\n'.repeat(n), (n) => rep('\ncommand: curl \n', n)]],
  ['ATR-2026-00418#4', 4, [(n) => '\n'.repeat(n), (n) => rep('\ncommand: sh \n', n)]],
  [
    'ATR-2026-00418#8',
    8,
    [(n) => '\n'.repeat(n), (n) => rep('\n -', n), (n) => rep('\n - -c ', n)],
  ],
  ['ATR-2026-00508#3', 3, [(n) => '-'.repeat(n), (n) => rep('--- ', n), (n) => rep('=*-\\', n)]],
  ['ATR-2026-00566#1', 1, [(n) => 'x'.repeat(n), (n) => rep('xa=', n), (n) => rep('header: ', n)]],
  ['ATR-2026-01463#3', 3, [(n) => '#'.repeat(n), (n) => rep('## ', n)]],
  [
    'ATR-2026-00426#1',
    1,
    [
      (n) => '['.repeat(n),
      (n) => rep('[a](http://x', n),
      (n) => rep('![](https://x', n),
      (n) => `${'['.repeat(n)}](http://x?$TOKEN`,
    ],
  ],
  [
    'ATR-2026-01865#0',
    0,
    [(n) => '['.repeat(n), (n) => rep('[[ ', n), (n) => rep('{{ ', n), (n) => rep('[email ', n)],
  ],
  [
    'ATR-2026-00416#2',
    2,
    [(n) => '{'.repeat(n), (n) => rep('{"transport": "stdio" ', n), (n) => rep('{ ', n)],
  ],
  [
    'ATR-2026-00419#1',
    1,
    [(n) => '{'.repeat(n), (n) => rep('{"mcpServers": {', n), (n) => rep('"mcpServers": ', n)],
  ],
  ['ATR-2026-02351#0', 0, [(n) => rep('a-b-', n), (n) => 'a'.repeat(n), (n) => rep('a.', n)]],
];
const TAILORED_CHARS = 200_000;
const TAILORED_BOUND_MS = 1_000;

describe('the conditions that were slow, on the shapes they were slow on', () => {
  it.each(TAILORED)('%s reads 200,000 characters in under a second', (key, index, shapes) => {
    const id = key.split('#')[0];
    const rule = rules.find((r) => r.id === id);
    expect(rule, `${id} is in the bundle`).toBeDefined();
    const regex = rule?.tests[index]?.regex;
    expect(regex, key).toBeDefined();
    for (const [position, build] of shapes.entries()) {
      const ms = timed(regex as RegExp, build(TAILORED_CHARS));
      expect(ms, `${key}, shape ${position + 1}`).toBeLessThan(TAILORED_BOUND_MS);
    }
  });
});
