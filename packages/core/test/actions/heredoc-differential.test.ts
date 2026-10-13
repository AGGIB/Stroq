import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitSegments } from '../../src/actions/shell-segments.js';

/**
 * Where a here-document ends is what a shell says, and a body that the classifier leaves out is only
 * as safe as its idea of where the body ends: a line that the shell runs after ITS end of the body,
 * and the classifier took for text, is a command nobody read. A second review found two such
 * openers (`<<EOF\` and a line break, and `<<$'EOF'`); this runs a matrix of them.
 *
 * Each command opens a here-document with one of the openers below, ends it with one of the closing
 * lines, and has commands on the lines after that: `touch m1` makes a file of that name, so that what
 * ran can be seen. (`touch` is on the list of plain file work, as it must be: a command that is not
 * leaves the whole line read as it was, and the matrix would test nothing.) Run in each real shell
 * that is installed, every mark that ran must be in what the classifier reads (`splitSegments`). A
 * mark that did not run asks nothing, and nor does one in a body the shell kept as text: the harm is
 * only in the direction that is tested.
 */

const SHELLS = ['/bin/bash', '/bin/dash', '/bin/ksh', '/bin/zsh'].filter(
  (shell) => process.platform !== 'win32' && existsSync(shell),
);
const SPAWN_TIMEOUT_MS = 6000;
const CPU_LIMIT_SECONDS = 3;
const CONCURRENCY = 6;

/** The words after `<<`, written the way a shell is made to read them. */
const OPENERS: readonly string[] = [
  "<<'EOF'",
  '<<"EOF"',
  '<<\\EOF',
  '<<EOF',
  "<<-'EOF'",
  '<<-EOF',
  '<<-"EOF"',
  '<<- EOF',
  '<< EOF',
  "<< 'EOF'",
  "<<'EO'F",
  "<<E'O'F",
  '<<"E"OF',
  '<<E\\OF',
  '<<EO\\F',
  '<<E""OF',
  "<<''EOF",
  '<<EOF""',
  "<<$'EOF'",
  '<<$"EOF"',
  "<<$'E'OF",
  "<<E$'O'F",
  "<<$'\\x45OF'",
  '<<"$EOF"',
  "<<'$EOF'",
  '<<$EOF',
  '<<${EOF}',
  '<<\\$EOF',
  '<<`echo EOF`',
  '<<$(echo EOF)',
  '<<EOF\\\n',
  "<<'EOF'\\\n",
  '<<E\\\nOF',
  '<<\\\nEOF',
  "<<'E\\\nOF'",
  '<<"E\\\nOF"',
  '<<"E\\"OF"',
  '<<"E\\\\OF"',
  '<<"E\\$OF"',
  "<<' EOF'",
  "<<'EOF '",
  "<<''",
  '<<""',
  "<<'' EOF",
  '<<~EOF',
  "<<'*'",
  '<<[E]OF',
  '<<E{O,}F',
  '<<EOF=',
  '<<EOF:',
  '<<-EOF-',
  '<<_EOF',
];

/** The line that may end the body, in the forms a delimiter can be misread as. */
const CLOSINGS: readonly string[] = [
  'EOF',
  '$EOF',
  "'EOF'",
  '"EOF"',
  '\\EOF',
  'E"OF',
  'E\\"OF',
  "' EOF'",
  'EOF ',
  '\tEOF',
  'EOF\\',
  '',
];

interface Case {
  readonly command: string;
}

/**
 * Bodies that a shell which finds the end of a substitution by counting brackets and quotes (bash 3.2,
 * which is `/bin/bash` and `/bin/sh` on a Mac) reads in another way than one that reads the document
 * first: a `)` or a `}` that ends the substitution early, a quote that is never closed, a backtick, a
 * backslash. `touch b0` after the line is a command if the substitution ended before it.
 */
const TRICKY_BODIES: readonly string[] = [
  ')\ntouch b0',
  '}\ntouch b0',
  ') ; touch b0',
  ');touch b0',
  ') && touch b0',
  "don't\ntouch b0",
  '"\ntouch b0',
  '`\ntouch b0',
  '(\ntouch b0',
  '\\\ntouch b0',
  '$(touch b1)\ntouch b0',
  'a ) b\ntouch b0',
  'x\n)\ntouch b0',
  // A comment hides a bracket or a quote from bash 3.2's count, and not from the document's reader.
  '# (\n)\ntouch b0',
  "# '\n'\ntouch b0",
  '# "\n"\ntouch b0',
  'x # (\n)\ntouch b0',
  '#(\n)\ntouch b0',
  '# plain note\ntouch b0',
  'fix #12 (see the issue)\ntouch b0',
  '(touch b0)',
  // `$'…'` is a string with escapes to bash 3.2: two of them make the quote count even, and an odd count
  // of plain quotes would not agree with the document's reader either.
  "$'\\''\n)\ntouch b0\n'\n$'\\''\n'",
  "$'\\''\n)\ntouch b0\n'",
  "$'a'\n)\ntouch b0",
  '$"a"\n)\ntouch b0',
  "$'\\''$'\\''\n)\ntouch b0\n''",
  'feat(api): add x\ntouch b0',
  "it's (ok)\ntouch b0",
  'plain text\ntouch b0',
  '',
];

/** The places a substitution can stand, each taking the whole of one here-document as its inside. */
const SUBSTITUTIONS: readonly ((inner: string) => string)[] = [
  (inner) => `x=$(${inner})\ntouch m1\n`,
  (inner) => `echo $(${inner})\ntouch m1\n`,
  (inner) => `x="$(${inner})"\ntouch m1\n`,
  (inner) => `cat <(${inner}) > /dev/null\ntouch m1\n`,
  (inner) => `x=\${y:-$(${inner})}\ntouch m1\n`,
  (inner) => `x=$(echo $(${inner}))\ntouch m1\n`,
  (inner) => `x=$(${inner} | cat)\ntouch m1\n`,
  (inner) => `x=$(if true; then ${inner}; fi)\ntouch m1\n`,
];

/** More bodies that have brackets and quotes in pairs, which bash 3.2 reads as the others do. */
const BALANCED_BODIES: readonly string[] = [
  'feat(api): add x\ntouch b0',
  'a (b) c\ntouch b0',
  '(a (b)) c\ntouch b0',
  "it's what 'they' said\ntouch b0",
  'say "hi" now\ntouch b0',
  'use `git status` first\ntouch b0',
  "costs $5 and $HOME ('x')\ntouch b0",
  "'a ) b'\ntouch b0",
  "'a ( b'\ntouch b0",
  '"a ) b"\ntouch b0',
  '`a ) b`\ntouch b0',
  "(a ')' b)\ntouch b0",
  'x\n(\n)\ntouch b0',
  "'\n)\n'\ntouch b0",
  '())\ntouch b0',
  '(()\ntouch b0',
];

/** A small deterministic generator, so that a failure is the same one the next time. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bodies made of what a bracket-counting reader looks at, in any order, and a command on the last
 * line: brackets, quotes, comments, `$(` and `${`, the signs a line may end a command with.
 */
function fuzzBodies(count: number): readonly string[] {
  const next = random(20261006);
  const alphabet = [
    '(',
    ')',
    "'",
    '"',
    '`',
    '\\',
    '$',
    '{',
    '}',
    'a',
    'b',
    ' ',
    ' ',
    '\n',
    '\n',
    '(',
    ')',
    '#',
    '#',
    ';',
    '&',
    '|',
    '<',
    '>',
    '[',
    ']',
    '\t',
    '$(',
    '${',
    "$'",
    '$"',
    '((',
    '))',
  ];
  return Array.from({ length: count }, () => {
    const length = 2 + Math.floor(next() * 12);
    let text = '';
    for (let i = 0; i < length; i += 1)
      text += alphabet[Math.floor(next() * alphabet.length)] as string;
    return `${text}\ntouch b0`;
  });
}

/** A here-document inside a substitution, where bash 3.2 finds the end of the substitution on its own. */
function nestedCases(): readonly Case[] {
  const out: Case[] = [];
  for (const wrap of SUBSTITUTIONS)
    for (const opener of ["<<'EOF'", '<<"EOF"', '<<\\EOF', "<<-'EOF'"])
      for (const body of [...TRICKY_BODIES, ...BALANCED_BODIES]) {
        const inner = `cat ${opener} > a.txt\n${body}\nEOF\n`;
        out.push({ command: wrap(inner) });
      }
  // The line that opens the document has its own comment, and a bracket or a quote in it.
  for (const wrap of SUBSTITUTIONS)
    for (const tail of [';#)', ' # (', " #'", ' #"', ' # )', ';# plain'])
      for (const body of ['touch b0', ')\ntouch b0', '(\ntouch b0', 'plain\ntouch b0']) {
        const inner = `cat <<'EOF' > a.txt${tail}\n${body}\nEOF\n`;
        out.push({ command: wrap(inner) });
      }
  for (const wrap of SUBSTITUTIONS.slice(0, 4))
    for (const body of fuzzBodies(400))
      out.push({ command: wrap(`cat <<'EOF' > a.txt\n${body}\nEOF\n`) });
  return out;
}

/** Marks: `b0` in the body, `b1` and `b2` in substitutions in the body, `m1` and `m2` after it, `s1` on the opener line. */
function cases(): readonly Case[] {
  const out: Case[] = [];
  for (const opener of OPENERS) {
    for (const closing of CLOSINGS) {
      // The opener that ends in a continuation joins the next line to its own.
      const open = `cat ${opener} > a.txt`;
      out.push({
        command: `${open}\ntouch b0\n${closing}\ntouch m1\nEOF\ntouch m2\n`,
      });
      out.push({
        command: `${open}\n$(touch b1)\n\`touch b2\`\n${closing}\ntouch m1\nEOF\ntouch m2\n`,
      });
    }
    out.push({ command: `${`cat ${opener} > a.txt && touch s1`}\nbody\nEOF\ntouch m2\n` });
  }
  out.push(...nestedCases());
  // Two here-documents on one line, each read to its own delimiter.
  for (const [a, b] of [
    ["<<'A'", "<<'B'"],
    ["<<'A'", '<<B'],
    ['<<A', "<<'B'"],
    ["<<'A'", "<<$'B'"],
  ] as const) {
    out.push({
      command: `cat ${a} ${b} > a.txt\ntouch b0\nA\n$(touch b1)\nB\ntouch m1\nA\ntouch m2\n`,
    });
  }
  return out;
}

let dir = '';

beforeAll(() => {
  if (SHELLS.length === 0) return;
  dir = mkdtempSync(join(tmpdir(), 'stroq-heredoc-diff-'));
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

const MARKS = ['b0', 'b1', 'b2', 'm1', 'm2', 's1'] as const;

/** The marks the shell ran for the command: each is a file that `touch` made in a directory of its own. */
function marksRun(shell: string, command: string): Promise<readonly string[]> {
  const cwd = mkdtempSync(join(dir, 'case-'));
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', `ulimit -t ${CPU_LIMIT_SECONDS}; exec "$0" -c "$1"`, shell, command],
      {
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: cwd,
          TMPDIR: cwd,
          // `<<$EOF` is read by no shell as an expansion; a variable that is set must make no difference.
          EOF: 'EOF',
        },
        timeout: SPAWN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      () => {
        const ran = MARKS.filter((mark) => existsSync(join(cwd, mark)));
        rmSync(cwd, { recursive: true, force: true });
        resolve(ran);
      },
    );
  });
}

/** Runs `work` over `items`, `limit` at a time. */
async function inBatches<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Where the lexer and a shell disagree about whether a document opens. A third review found three ways that the lexer read a
 * `<<'EOF'` as an opener where a real shell did not (or the other way round), so that a line the shell
 * runs was left out as the body of a document that never opened: a `#` right after `)` (a comment to
 * every shell, a word to the lexer), a line break after a `|` that took the body a line late, and `((`
 * with no white space after it (an arithmetic, in which `<<` is a shift, to bash, zsh and ksh, and two
 * subshells to dash). `touch b0` is the line after the document that was never one.
 */
const PAYLOAD = 'touch b0';
const DOCUMENT = `<<'EOF'\n${PAYLOAD}\nEOF\n`;

/** Every character that may stand right before a `#`, after a command of every kind that ends in a bracket. */
const BEFORE_HASH: readonly string[] = [
  ...Array.from({ length: 15 }, (_, i) => String.fromCharCode(33 + i)),
  ...Array.from({ length: 7 }, (_, i) => String.fromCharCode(58 + i)),
  ...Array.from({ length: 6 }, (_, i) => String.fromCharCode(91 + i)),
  ...Array.from({ length: 4 }, (_, i) => String.fromCharCode(123 + i)),
  ' ',
  '\t',
  '',
];

const COMMANDS_BEFORE: readonly string[] = [
  'true',
  '(true)',
  '( ( true ) )',
  '{ true; }',
  'echo $(true)',
  'echo `true`',
  'echo "a"',
  "echo 'a'",
  'if true; then true; fi',
  'for i in 1; do :; done',
  'case a in a) true;; esac',
  'f() (true)',
  '[[ a == a ]]',
  'echo a >&2',
];

function lexerCases(): readonly Case[] {
  const out: Case[] = [];
  for (const before of COMMANDS_BEFORE)
    for (const c of BEFORE_HASH) {
      out.push({ command: `${before}${c}# ${DOCUMENT}` });
      out.push({ command: `${before}${c}#${DOCUMENT}` });
    }
  // A body that begins a line late: the line after the `|` is not a line of the document.
  for (const pipe of ['|', '|&', '| # note', '| \\\n'])
    for (const word of ['cat', 'true', 'EOF', 'wc'])
      out.push({ command: `cat <<'${word}' ${pipe}\n${word}\n${PAYLOAD}\n${word}\n` });
  out.push({ command: `cat <<'EOF' |\n\n${PAYLOAD}\nEOF\n` });
  out.push({ command: `cat <<'EOF' |\n# c\n${PAYLOAD}\nEOF\n` });
  // `((` with no white space after it: an arithmetic, or two subshells.
  for (const lead of [
    '',
    'x=1; ',
    'echo a && ',
    'echo a || ',
    'if ',
    'while ',
    'until ',
    '! ',
    '{ ',
    '( ',
  ])
    for (const inner of ['true', 'cd', 'cat', ':', 'x=1', 'echo hi', '1'])
      out.push({ command: `${lead}((${inner}<<'EOF'))\n${PAYLOAD}\nEOF\n` });
  for (const inner of [";true<<'EOF';", "true<<'EOF';;", ";;true<<'EOF'"])
    out.push({ command: `for ((${inner})); do :; done\n${PAYLOAD}\nEOF\n` });
  out.push({ command: `((cat<<\\EOF\n${PAYLOAD}\nEOF\n))\n${PAYLOAD}\n` });
  // A backslash and a line break join the lines: the `#` that begins the next is a comment where a
  // blank stood before the backslash, and part of a word where it did not.
  for (const lead of ['echo a ', 'echo a', 'cat > a.txt ', 'true; ', '(echo a) ', 'echo a  ', ''])
    for (const tail of ['# ', '#', '  # ']) {
      out.push({ command: `${lead}\\\n${tail}${DOCUMENT}` });
      out.push({ command: `${lead}\\\n\\\n${tail}${DOCUMENT}` });
    }
  // A `$'…'` string with an escape in it: dash reads a string that ends at the first quote.
  for (const string of ["$'\\''", "$'a\\'b'", "$'\\\\'", "$'\\n'", "$'\\x27'"]) {
    out.push({ command: `echo ${string} ; cat ${DOCUMENT}` });
    // The quote that dash left open is closed by a line of the document, and the line after is a command.
    out.push({ command: `echo ${string} ; cat <<'EOF'\n'\n${PAYLOAD}\nEOF\n` });
    out.push({ command: `echo ${string} ; cat <<'EOF'\n'x'\n${PAYLOAD}\nEOF\n'` });
  }
  out.push({ command: `echo $'\\''\ncat ${DOCUMENT}'` });
  return out;
}

describe('which bodies in a substitution are left out as text', () => {
  // The matrix below only proves something about the bodies that are left out: where every one is
  // read, no mark can be missed.
  it('leaves out some, and reads others, or it proves nothing', () => {
    const withMark = nestedCases().filter(({ command }) => command.includes('touch b0'));
    const read = withMark.filter(({ command }) =>
      splitSegments(command).some((segment) => /\btouch b0\b/.test(segment)),
    );
    expect(withMark.length - read.length, 'bodies left out').toBeGreaterThan(40);
    expect(read.length, 'bodies read').toBeGreaterThan(40);
  });
});

/** The shells of the matrix above, and `/bin/sh`, which is bash 3.2 in its POSIX mode on a Mac. */
const LEXER_SHELLS = [
  ...new Set([...SHELLS, ...['/bin/sh'].filter((shell) => SHELLS.length > 0 && existsSync(shell))]),
];

describe.skipIf(SHELLS.length === 0)(
  'a line that no document opened is not the body of one, in the shells that run it',
  () => {
    const all = lexerCases();

    it.each(LEXER_SHELLS)(
      'in %s: every mark that ran is in what the classifier reads',
      async (shell) => {
        const missed: string[] = [];
        let ran = 0;
        await inBatches(all, CONCURRENCY, async ({ command }) => {
          const marks = await marksRun(shell, command);
          const read = splitSegments(command);
          for (const mark of marks) {
            ran += 1;
            if (!read.some((segment) => new RegExp(`\\b${mark}\\b`).test(segment)))
              missed.push(`${mark} ran, and was not read: ${JSON.stringify(command)}`);
          }
        });
        // The matrix proves nothing if no command of it ran a mark.
        expect(ran, `${shell}: marks that ran`).toBeGreaterThan(20);
        expect(missed.slice(0, 5)).toEqual([]);
      },
      240_000,
    );
  },
);

describe.skipIf(SHELLS.length === 0)(
  'where a here-document ends, in the shells that run it',
  () => {
    const all = cases();

    it.each(SHELLS)(
      'in %s: every mark that ran is in what the classifier reads',
      async (shell) => {
        const missed: string[] = [];
        let ranAfterClosing = 0;
        let heldAsText = 0;
        await inBatches(all, CONCURRENCY, async ({ command }) => {
          const marks = await marksRun(shell, command);
          const read = splitSegments(command);
          for (const mark of marks) {
            if (mark === 'm1') ranAfterClosing += 1;
            if (!read.some((segment) => new RegExp(`\\b${mark}\\b`).test(segment)))
              missed.push(`${mark} ran, and was not read: ${JSON.stringify(command)}`);
          }
          if (!marks.includes('m1') && !marks.includes('m2')) heldAsText += 1;
        });
        // The matrix proves nothing if no shell ever ended a body early, or none ever kept a body whole.
        expect(ranAfterClosing, `${shell}: marks that ran after the closing line`).toBeGreaterThan(
          20,
        );
        expect(heldAsText, `${shell}: commands whose lines stayed text`).toBeGreaterThan(20);
        expect(missed.slice(0, 5)).toEqual([]);
      },
      240_000,
    );
  },
);
