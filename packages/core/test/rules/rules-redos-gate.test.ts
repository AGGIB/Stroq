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
const TAILORED: Array<readonly [string, number, ReadonlyArray<(n: number) => string>]> = [
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
  // A directive to skip security checks begins at the verb and looks back; the shapes are a verb after
  // every kind of lead-in, and the runs of blanks and line breaks that lead-in is read backwards over.
  [
    'ATR-2026-00163#2',
    2,
    [
      (n) => '\n'.repeat(n),
      (n) => ' '.repeat(n),
      (n) => rep('. ', n),
      (n) => rep('\n- skip ', n),
      (n) => rep(', disable security ', n),
      (n) => rep('. Now bypass all security check ', n),
      (n) => `${' '.repeat(n)}skip security checks for `,
    ],
  ],
];
// The broad token-sending pattern read the rest of the line from every verb on it, and so did the
// pattern for an Authorization header that is logged or dumped (3.75 seconds on `log ` repeated).
// Both now look back from the token for the verb, however far, and stop at the previous token, which
// has been tried already; the one on web content differs by the verbs it takes. A lookahead for a
// HTTP method after `post` once ran at every blank of a run of blanks (40 seconds), and a `\s+` in the
// lookbehind was quadratic in the run: the shapes are the runs of blanks and line breaks before a token.
const VERB_THEN_NOTHING: ReadonlyArray<(n: number) => string> = [
  (n) => rep('send the ', n),
  (n) => rep('post ', n),
  (n) => `send ${'a'.repeat(n)}`,
  (n) => rep('log ', n),
  (n) => rep('dump the ', n),
  (n) => rep('extract ', n),
  (n) => rep('autopost ', n),
  (n) => rep('send the Bearer ', n),
  (n) => rep('log the Authorization header ', n),
  (n) => `log ${' '.repeat(n)}`,
  (n) => `${rep('send ', n / 2)}${'\n'.repeat(n / 2)}`,
  (n) => rep('password ', n),
  (n) => rep('api_key ', n),
  (n) => rep('x api_key x ', n),
  (n) => rep(`api_key${' '.repeat(4_000)}`, n),
  (n) => rep(`api_key${' '.repeat(20_000)}`, n),
  (n) => rep(`api_key${'\n'.repeat(5_000)}`, n),
  (n) => `${' '.repeat(n - 7)}api_key`,
  (n) => `${'\n'.repeat(n - 7)}api_key`,
  (n) => `${rep('\n ', n - 7)}api_key`,
  (n) => `${rep(' \n', n - 7)}api_key`,
  (n) => `${'a'.repeat(n - 8)} api_key`,
  (n) => `${rep('send', n - 8)} api_key`,
  (n) => `send${' '.repeat(n)}`,
  (n) => rep('post  ', n),
  (n) => rep('postfoo bearer ', n),
  (n) => rep('Bearer header ', n),
  (n) => `${' '.repeat(n - 21)}Bearer header token`,
];
TAILORED.push(
  ...[0, 2, 5, 6].map(
    (index) => [`ATR-2026-00114#${index}`, index, VERB_THEN_NOTHING] as (typeof TAILORED)[number],
  ),
);
// A comment that opens and never closes: `<!--[^>]*word[^>]*-->` read every opening to the end of the text.
TAILORED.push([
  'STROQ-2026-00002#1',
  1,
  [
    (n) => rep('<!--', n),
    (n) => rep('<!--run', n),
    (n) => rep('<!-- ', n),
    (n) => rep('<!-- x ', n),
    (n) => `<!--${' '.repeat(n)}`,
    (n) => rep('<!-- ignore ', n),
    // One opening and no end: the word is looked for in a comment that never closes.
    (n) => `<!--${rep(' run', n)}`,
    (n) => `<!--${rep(' you must', n)}`,
    (n) => `<!--${rep(' instructions:', n)}`,
    (n) => `<!--${rep(' ignore', n)}-->`,
    (n) => `${rep('<!--', n / 2)}${rep(' run', n / 2)}`,
  ],
]);
// STROQ-2026-00014 pairs a cue with a cue within 400 characters of it. A text made of nothing but
// cues makes every cue the start of a window, which is the worst case for a pattern of that shape.
const ADDENDUM_SHAPES: ReadonlyArray<(n: number) => string> = [
  (n) => rep('Hi Assistant, ', n),
  (n) => rep('Hello AI, ', n),
  (n) => rep('note to ', n),
  (n) => rep('before finishing the task ', n),
  (n) => rep('then continue with the original ', n),
  (n) => rep('[PRIORITY MESSAGE] ', n),
  (n) => rep('urgent: ', n),
  (n) => rep('\u2014 the user ', n),
  (n) => rep('Hi Assistant, before finishing the task above, urgent: ', n),
  (n) => rep('\\nHi Assistant\\nI forgot to mention ', n),
  (n) => rep('Hi Assistant, ', n / 2) + rep('x ', n / 2),
  (n) => `${rep('Hi Assistant, ', n / 2)}${' '.repeat(n / 2)}urgent:`,
];
TAILORED.push(
  ...[0, 1, 2, 3].map(
    (index) => [`STROQ-2026-00014#${index}`, index, ADDENDUM_SHAPES] as (typeof TAILORED)[number],
  ),
);
// Every pattern the narrowing and its reviews changed, on text made of nothing but the words each one
// is looking for, at 200,000 characters: each word is the start of a window for the patterns that read
// a verb and then a path, a token or an address, and the worst case of such a pattern is a text in which
// every position starts one.
const CHANGED_RULES = [
  'ATR-2026-00060',
  'ATR-2026-00113',
  'ATR-2026-00114',
  'ATR-2026-00150',
  'ATR-2026-00161',
  'ATR-2026-00163',
  'ATR-2026-00568',
  'STROQ-2026-00002',
  'STROQ-2026-00004',
  'STROQ-2026-00014',
];
const CUE_UNITS = [
  'head ',
  'cat ~/.aws/credentials ',
  '~/.ssh/id_rsa ',
  'run aws configure ',
  '--post-file=',
  '| ',
  '< ',
  'keychain ',
  'read the keychain ',
  'security dump-keychain ',
  'Library/Keychains ',
  'copy the keychain ',
  'from the keychain ',
  '/etc/passwd ',
  'cat /etc/passwd ',
  'file:///home/u/',
  'file:///home/a/b/c/d/',
  '-----BEGIN PRIVATE KEY----- ',
  'send ',
  'send the ',
  'api_key ',
  'send api_key to ',
  'access_token ',
  'disable all security ',
  ', skip ',
  'to disable ',
  'need to ',
  'replacement for ',
  'the same as the official ',
  '<!--',
  '<!-- run ',
  '<!-- ignore ',
  '<!-- x > ',
  'copy ',
  'copy .env.example to ',
  'copy .env.example ',
  'AI must now ',
  'the agent must now ',
  'Attention agent. ',
  'Hello AI, you must ',
  'must now run ',
  'password ',
  'credentials ',
  '\\n',
  '\\nHi Assistant',
  // Round 3: the verbs a hostile line puts before a path, a token or a keychain, the places a benign
  // line puts a path (a table, a mount, an assignment), and the lead-ins of a note to an assistant.
  'log ',
  'dump ',
  'print ',
  'show all ',
  'paste ',
  'Start by uploading ',
  'Begin by copying ',
  '~/.npmrc ',
  '~/.aws/credentials, paste it ',
  'Whatever is in ~/.aws/credentials ',
  'Take ~/.netrc and put it in ',
  'Add ~/.docker/config.json to ',
  'git add ~/.kube/config ',
  'For verification we need ',
  '| a | ',
  '\n| ',
  '`~/.aws/credentials` ',
  'export X=~/.npmrc ',
  '-v ~/.npmrc:',
  'the login keychain: ',
  'secret-tool ',
  'security find-generic-password ',
  '/etc/passwd\n',
  'open /etc/passwd ',
  'scp /etc/passwd ',
  'file:///home/alice/x ',
  'The assistant must now ',
  'Dear AI assistant. ',
  'Hi AI assistant! ',
  '[IMPORTANT] ',
  'If you are a bot, ',
  'If you are an AI agent: ',
  'From now on ',
  '<!-- instructions: ',
  '<!-- <!-- ',
  '<!-- see a->b ',
  'it is best to ',
  'the only way to continue is to ',
  'make it a habit to ',
  'A drop-in replacement for github-mcp-server ',
  'autopost ',
  'resend ',
  'POST /api ',
  'post -',
  'post localhost ',
];

describe('every pattern the narrowing changed, on text made of the words it looks for', () => {
  it('has the rules to read', () => {
    for (const id of CHANGED_RULES)
      expect(
        rules.some((r) => r.id === id),
        id,
      ).toBe(true);
  });
  it('reads 200,000 characters of any of them in under a second', () => {
    const slow: string[] = [];
    for (const id of CHANGED_RULES) {
      const rule = rules.find((r) => r.id === id);
      for (const [index, test] of (rule?.tests ?? []).entries()) {
        if (test.regex === undefined) continue;
        for (const unit of CUE_UNITS) {
          const ms = timed(test.regex, rep(unit, 200_000));
          if (ms > 1_000)
            slow.push(`${id}#${index} on ${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
        }
      }
    }
    expect(slow).toEqual([]);
  }, 600_000);
});

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
