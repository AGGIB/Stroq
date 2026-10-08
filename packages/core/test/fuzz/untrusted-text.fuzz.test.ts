import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  extractSubstitutions,
  splitPipelines,
  splitSegments,
  tokenize,
} from '../../src/actions/shell-segments.js';
import { lex, lostPipe } from '../../src/actions/shell-lex.js';
import { parseShellArgs } from '../../src/actions/shell-args.js';
import { decodePrograms, shellInput } from '../../src/actions/shell-input.js';
import { collectKeyedStrings, collectStrings, mapStrings } from '../../src/cloak/json-strings.js';
import { compileNameMatcher, nameNeedles } from '../../src/cloak/prose-names.js';
import { expandVariants, normalizeText } from '../../src/normalize/normalizer.js';
import { neutralizeControls } from '../../src/util/controls.js';
import { cpuNow } from '../cpu-time.js';

/**
 * Property tests for the code that reads text an attacker wrote: shell commands the
 * model produced, tool output, JSON a server returned. Example tests check the cases
 * someone thought of; these generate the ones nobody did, and fail on a throw, a
 * wrong answer, or a call slow enough to matter inside a hook.
 */

/** Characters that change how a shell or a parser reads a line. */
const SHELL_CHARS = [
  ...'|;&<>()$`"\'\\ \n\t={}[]#*?~!',
  'a',
  'b',
  'x',
  'cat',
  'curl',
  'sh',
  'bash',
  'EOF',
  'eval',
  '-c',
  '/',
  '.',
  '0',
  '1',
];
const shellish = (maxLength: number) =>
  fc.array(fc.constantFrom(...SHELL_CHARS), { maxLength }).map((parts) => parts.join(''));

/** Fails when one call takes longer than a hook can afford. */
function fast<T>(fn: () => T, ms = 250): T {
  const started = cpuNow();
  const out = fn();
  expect(cpuNow() - started).toBeLessThan(ms);
  return out;
}

describe('shell segmentation on arbitrary commands', () => {
  it('never throws and stays fast', () => {
    fc.assert(
      fc.property(fc.oneof(shellish(400), fc.string({ maxLength: 400 })), (command) => {
        fast(() => splitSegments(command));
        fast(() => splitPipelines(command));
        fast(() => extractSubstitutions(command));
        for (const segment of splitSegments(command)) fast(() => tokenize(segment));
      }),
      { numRuns: 400 },
    );
  });
});

describe('reading what a shell is handed on arbitrary commands', () => {
  // The words a shell reads a program from, mixed into the characters that change how it is read.
  const pieces = [
    ...SHELL_CHARS,
    '| bash',
    '<<<',
    '<<EOF\n',
    '\nEOF\n',
    'echo ',
    'printf ',
    '$(',
    '`',
  ];
  const noisy = (maxLength: number) =>
    fc.array(fc.constantFrom(...pieces), { maxLength }).map((parts) => parts.join(''));

  it('never throws, stays fast, and keeps what it builds within the budget', () => {
    fc.assert(
      fc.property(fc.oneof(noisy(200), shellish(400), fc.string({ maxLength: 400 })), (command) => {
        const lexed = fast(() => lex(command));
        fast(() => lostPipe(command, lexed));
        const found = fast(() => shellInput(command));
        expect(found.texts.join('').length).toBeLessThanOrEqual(2 * command.length + 65_536);
        fast(() => decodePrograms(command), 500);
        fast(() => parseShellArgs(command.split(/\s+/)));
      }),
      { numRuns: 400 },
    );
  });

  it('decodes the text an echo prints, whatever it is, when nothing in it expands', () => {
    const plain = fc
      .array(fc.constantFrom(...'abcxyz019 ._/'.split('')), { minLength: 1, maxLength: 40 })
      .map((chars) => chars.join(''))
      .filter((text) => text.trim() === text);
    fc.assert(
      fc.property(plain, (text) => {
        const found = shellInput(`echo '${text}' | bash`);
        expect(found.opaque).toBe(false);
        expect(found.texts).toEqual([text]);
        expect(shellInput(`bash <<< '${text}'`).texts).toEqual([text]);
        expect(shellInput(`printf '%s' '${text}' | sh`).texts).toEqual([text]);
      }),
      { numRuns: 200 },
    );
  });

  it('asks about a pipe into a shell from a source it cannot read, wherever the pipe stands', () => {
    const before = noisy(40);
    fc.assert(
      fc.property(before, (prefix) => {
        // A backslash that ends the prefix joins the next line to it (`echo <<<\` and then
        // `unknown-tool | bash` is `echo <<<unknown-tool | bash`, which a shell runs as a pipe from an
        // echo that prints nothing): that line is not a fresh one.
        fc.pre(!prefix.endsWith('\\'));
        // Whatever precedes it, a fresh line with `unknown-tool | bash` is a pipe the reading
        // finds, or one it says it lost.
        const command = `${prefix}\nunknown-tool | bash`;
        const found = shellInput(command);
        expect(found.opaque || found.texts.length > 0 || found.files.length > 0).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // Complete commands, each of which a shell reads to its end and then runs what follows: a quote
  // or a substitution that closes, a comment that a line break ends, a here-document with its
  // delimiter. What follows the last of them runs, so a reading that has taken any of them for
  // something longer has hidden a command.
  interface Closed {
    readonly text: string;
    /** The command runs to a line break: a comment, or a here-document that ends on its own line. */
    readonly line?: boolean;
  }
  const closed: readonly Closed[] = [
    { text: 'echo a' },
    { text: 'echo "a b"' },
    { text: "echo 'a | bash'" },
    { text: 'echo "a | bash"' },
    { text: 'echo $(date)' },
    { text: 'echo "$(date)"' },
    { text: 'echo $(echo ")")' },
    { text: 'echo ${x:-a}' },
    { text: 'echo ${x:-{}' },
    { text: "echo $'a\\'b'" },
    { text: "echo $(echo $'\\'')" },
    { text: 'echo \\$x' },
    { text: "echo \\$'a\\'" },
    { text: "echo $$'a'" },
    { text: 'echo $$' },
    { text: 'echo a\\\n#b' },
    { text: 'echo a\\;#b' },
    { text: 'echo a\\ #b' },
    { text: 'echo a\u00a0#b' },
    { text: 'echo `date`' },
    { text: 'echo a#b' },
    { text: 'case x in a|b) echo a;; esac' },
    { text: '[[ a == b ]]' },
    { text: '(( 1 + 1 ))' },
    { text: 'f() { echo a; }' },
    { text: '# a | bash', line: true },
    { text: "cat <<'@@' >/dev/null\nit's\n@@", line: true },
    { text: 'cat <<E"O"F >/dev/null\nit\'s\nEOF', line: true },
    { text: "cat <<EOF >/dev/null\n$(date) 's\nEOF", line: true },
  ];
  /** The text of the commands, each joined to the next the way a shell runs one after another. */
  const sequence = fc
    .array(fc.tuple(fc.constantFrom(...closed), fc.constantFrom('\n', ';', '\n\n', ' ; ')), {
      maxLength: 6,
    })
    .map((items) =>
      items
        .map(([command, separator]) => `${command.text}${command.line === true ? '\n' : separator}`)
        .join(''),
    );

  it('decodes the program of a pipe after any run of complete commands', () => {
    fc.assert(
      fc.property(sequence, (before) => {
        const found = decodePrograms(`${before}echo 'rm -rf ~' | bash`);
        expect(found.texts).toContain('rm -rf ~');
      }),
      { numRuns: 400 },
    );
  });

  it('asks about the unreadable source of a pipe after any run of complete commands', () => {
    fc.assert(
      fc.property(sequence, (before) => {
        expect(decodePrograms(`${before}unknown-tool | bash`).opaque).toBe(true);
        expect(decodePrograms(`${before}bash <<< "$x"`).opaque).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});

describe('normalization on arbitrary text', () => {
  it('never throws and stays within the scan budget', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000, unit: 'binary' }), (text) => {
        fast(() => normalizeText(text), 500);
        fast(() => expandVariants(text), 500);
      }),
      { numRuns: 200 },
    );
  });
});

describe('JSON leaf walking on arbitrary server results', () => {
  it('rewrites nothing when the rewrite is identity', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        expect(mapStrings(value, (s) => s)).toEqual(value);
      }),
    );
  });

  it('sees every string leaf, and a key it reports is a key the value has', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        const leaves = collectStrings(value);
        const serialised = JSON.stringify(value);
        for (const leaf of leaves) expect(serialised).toContain(JSON.stringify(leaf).slice(1, -1));
        const keyed = collectKeyedStrings(value);
        expect([...keyed.keys()].sort()).toEqual([...new Set(leaves)].sort());
      }),
    );
  });

  it('survives nesting far past its depth bound', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 5000; i += 1) deep = { k: [deep] };
    expect(() => fast(() => collectStrings(deep))).not.toThrow();
    expect(() => fast(() => mapStrings(deep, (s) => s.toUpperCase()))).not.toThrow();
  });
});

describe('neutralizeControls on arbitrary text', () => {
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

  it('leaves no control character behind', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (text) => {
        expect(UNSAFE.test(neutralizeControls(text))).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  // The claim `--json` output rests on: neutralizing serialised JSON must still
  // decode to exactly the original value.
  it('keeps serialised JSON decoding to the original value', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        // Against what JSON itself makes of the value: `-0` serialises as `0`, and
        // no text can carry the difference.
        const asJson: unknown = JSON.parse(JSON.stringify(value));
        expect(JSON.parse(neutralizeControls(JSON.stringify(value)))).toEqual(asJson);
      }),
      { numRuns: 300 },
    );
  });
});

describe('prose-name matching on arbitrary names and text', () => {
  it('returns non-overlapping spans that are exactly what the text holds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 8 }),
        fc.string({ maxLength: 400 }),
        (names, text) => {
          const matcher = compileNameMatcher(nameNeedles(names));
          if (matcher === null) return;
          const spans = fast(() => matcher(text));
          let end = 0;
          for (const span of spans) {
            expect(span.start).toBeGreaterThanOrEqual(end);
            expect(text.slice(span.start, span.end)).toBe(span.value);
            end = span.end;
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
