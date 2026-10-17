import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keptNote } from '../src/commands/init-mcp.js';
import { renderCard } from '../src/commands/vet-card.js';
import { openclawInstallCommands } from '../src/commands/openclaw-plugin.js';
import { parseRunArgv } from '../src/commands/run.js';
import { confirmationScreen, CONFIRM_SENSITIVE_MAX } from '../src/commands/vet-render.js';
import { wrongCallLines } from '../src/commands/why.js';
import { inspectTree } from '../src/install/inspect/index.js';
import { mcpRemedyCommands, skillRemedyCommands } from '../src/install/remedy.js';
import { reconfirmCommand } from '../src/mcp/pin-argument.js';
import { commandLine, quoteWord } from '../src/shell-quote.js';
import { treeOf } from './helpers/install-tree.js';

/**
 * Every command line that Stroq prints for a person to paste has values in it that somebody else wrote: the name of a
 * server in a config, the path a lock remembers, the ref of a package. None of them may become a second command, a
 * redirection or an option when the line is pasted. The lines are built by `commandLine`; the tests here hold each
 * printer to it, by running the printed line through a real `sh` with a shell function in place of the program, which
 * writes its arguments as JSON, and by the marker file that a payload would write: it must not exist afterwards.
 */
const posix = process.platform !== 'win32';

let dir = '';
let marker = '';
let argvScript = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-quote-'));
  marker = join(dir, 'pwned');
  argvScript = join(dir, 'argv.mjs');
  writeFileSync(argvScript, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a printed line with `stroq` and `openclaw` standing for a program that prints its arguments; null if it fails. */
function argvOf(line: string): string[] | null {
  const script =
    'stroq() { "$NODE" "$ARGV" "$@"; }\nopenclaw() { "$NODE" "$ARGV" "$@"; }\n' + line + '\n';
  try {
    const out = execFileSync('sh', ['-c', script], {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '', NODE: process.execPath, ARGV: argvScript },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.trim().split('\n');
    return lines.length === 1 ? (JSON.parse(lines[0]!) as string[]) : null;
  } catch {
    return null;
  }
}

/** Values from outside, each of them written to break out of a line, one way or another. */
const hostile = (): readonly (readonly [label: string, value: string])[] => [
  ['semicolon', `x; printf pwned > ${marker}`],
  ['command substitution', `$(printf pwned > ${marker})`],
  ['backticks', `\`printf pwned > ${marker}\``],
  ['a single quote that closes the quoting', `x'; printf pwned > ${marker}; '`],
  ['a double quote that closes the quoting', `x"; printf pwned > ${marker}; "`],
  ['and', `x && printf pwned > ${marker}`],
  ['pipe', `x | printf pwned > ${marker}`],
  ['background', `x & printf pwned > ${marker}`],
  ['redirect', `x > ${marker}`],
  ['redirect from', `< ${marker}`],
  ['percent variable', '%PATH%'],
  ['caret', 'a^b^'],
  ['bang', 'a!b'],
  ['dollar variable', '$HOME ${IFS}'],
  ['glob', '*'],
  ['tilde', '~root'],
  ['brace', '{a,b}'],
  ['space', 'a b  c'],
  ['hash', 'a #b'],
  ['backslash', 'a\\b\\'],
  ['only a quote', "'"],
  ['only a double quote', '"'],
  ['quote and backslash', `\\'`],
  ['the empty string', ''],
  ['a leading dash', '-rf'],
  ['an option', '--force'],
  ['a leading dash with a space', '-x y'],
  ['the separator', '--'],
  ['a newline', `x\nprintf pwned > ${marker}`],
  ['a carriage return', `x\rprintf pwned > ${marker}`],
  ['NUL', 'a\u0000b'],
  ['escape', 'a\u001b[2Jb'],
  ['a bell', 'a\u0007'],
  ['a right-to-left override', 'abc\u202edef'],
  ['a zero-width space', 'a\u200bb'],
  ['a lone surrogate', 'a\ud800b'],
  ['a very long value', 'a'.repeat(5000)],
  ['a long value of quotes', "'".repeat(3000)],
  ['unicode that is only text', 'проект/日本語/ünï'],
  ['a name with every kind of bracket', '([{<>}])'],
];

/** Whether the value can be shown and pasted as itself. */
const showable = (value: string): boolean =>
  value.length <= 4096 &&
  !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(value);

interface Printer {
  readonly name: string;
  /** Characters this printer cannot carry because the line goes into text where they mean something. */
  readonly forbid?: string;
  /** The printed line for a value, and the arguments a program should get from it when the value is shown. */
  readonly print: (value: string) => { line: string; argv: (shown: string) => string[] };
}

const record = (value: string) => ({
  source: value,
  config: value,
  entrypoint: value,
  passEnv: ['A', 'B'],
  cwd: value,
});

const printers: readonly Printer[] = [
  {
    name: 'the line that confirms a wrapper again (init, the proxy, doctor)',
    print: (value) => ({
      line: reconfirmCommand(value),
      argv: (shown) =>
        shown.startsWith('-')
          ? ['add', '--kind', 'mcp', '--force', '--', shown]
          : ['add', shown, '--kind', 'mcp', '--force'],
    }),
  },
  {
    name: 'the note init prints for a wrapper it kept',
    print: (value) => ({
      line: keptNote(value, false).split('confirm it again: ')[1]!,
      argv: (shown) =>
        shown.startsWith('-')
          ? ['add', '--kind', 'mcp', '--force', '--', shown]
          : ['add', shown, '--kind', 'mcp', '--force'],
    }),
  },
  {
    name: 'the remove line for a damaged server',
    print: (value) => ({
      line: mcpRemedyCommands(value, record(value))[0],
      argv: (shown) =>
        shown.startsWith('-')
          ? ['remove', '--kind', 'mcp', '--force', '--', shown]
          : ['remove', shown, '--kind', 'mcp', '--force'],
    }),
  },
  {
    name: 'the add line for a damaged server',
    print: (value) => ({
      line: mcpRemedyCommands(value, record(value))[1],
      argv: (shown) => {
        const flags = (v: string) => (v.startsWith('-') ? (f: string) => `${f}=${v}` : null);
        const named = flags(shown);
        const pair = (flag: string): string[] => (named ? [named(flag)] : [flag, shown]);
        const rest = [
          '--kind',
          'mcp',
          ...pair('--name'),
          ...pair('--config'),
          ...pair('--entrypoint'),
          '--pass-env',
          'A,B',
          ...pair('--cwd'),
        ];
        return shown.startsWith('-') ? ['add', ...rest, '--', shown] : ['add', shown, ...rest];
      },
    }),
  },
  {
    name: 'the remove line for a damaged skill',
    print: (value) => ({
      line: skillRemedyCommands(
        value,
        { source: value, root: '/p' },
        { home: '/h', project: '/p' },
      )[0],
      argv: (shown) =>
        shown.startsWith('-') ? ['remove', '--force', '--', shown] : ['remove', shown, '--force'],
    }),
  },
  {
    name: 'the add line for a damaged skill',
    print: (value) => ({
      line: skillRemedyCommands(
        value,
        { source: value, root: '/h' },
        { home: '/h', project: '/p' },
      )[1],
      argv: (shown) =>
        shown.startsWith('-') ? ['add', '--user', '--', shown] : ['add', shown, '--user'],
    }),
  },
  {
    name: 'the refusal of a screen with too many sensitive lines',
    print: (value) => {
      const passport = inspectTree(treeOf({ 'SKILL.md': '# demo' }), {
        kind: 'skill',
        source: { type: 'dir', label: 'demo' },
        extraBlindSpots: [],
        stroqVersion: 'test',
        rulesId: 'test',
      });
      const lines = Array.from({ length: CONFIRM_SENSITIVE_MAX + 1 }, (_, i) => ({
        kind: 'net' as const,
        subject: `h${i}.example`,
        basis: 'observed' as const,
        sensitive: true,
        where: [{ file: 'SKILL.md', line: 1 }],
        detector: 'test',
      }));
      let message = '';
      try {
        confirmationScreen({ ...passport, lines }, value);
      } catch (error) {
        message = (error as Error).message;
      }
      return {
        line: message.slice(message.indexOf('stroq vet')),
        argv: (shown) =>
          shown.startsWith('-')
            ? ['vet', `--from=${shown}`, '--json']
            : ['vet', '--from', shown, '--json'],
      };
    },
  },
  {
    name: 'the line that clears a session',
    print: (value) => {
      const entry = { sessionId: value, decision: { effect: 'deny', ruleId: 'r' } } as never;
      const line = wrongCallLines(entry)[1]!;
      return {
        line: line.slice(line.indexOf('stroq untaint')),
        argv: (shown) =>
          shown.startsWith('-')
            ? ['untaint', `--session=${shown}`]
            : ['untaint', '--session', shown],
      };
    },
  },
  {
    name: 'the commands that register the OpenClaw plugin',
    print: (value) => ({
      line: openclawInstallCommands(value)[0]!,
      argv: (shown) => ['plugins', 'install', '--link', shown],
    }),
  },
  {
    name: 'the "did you mean" of stroq run',
    print: (value) => {
      const parsed = parseRunArgv([`w${value}`]);
      const message = parsed.ok ? '' : parsed.error;
      return {
        line: message.slice(message.indexOf('stroq run')),
        argv: (shown) => ['run', '--', `w${shown}`],
      };
    },
  },
  {
    name: 'the reproduce line of the card of a GitHub source',
    forbid: '`',
    print: (value) => {
      const passport = inspectTree(treeOf({ 'SKILL.md': '# demo' }), {
        kind: 'skill',
        source: { type: 'dir', label: 'demo' },
        extraBlindSpots: [],
        stroqVersion: 'test',
        rulesId: 'test',
      });
      const card = renderCard({
        ...passport,
        artifact: {
          ...passport.artifact,
          source: { type: 'github', owner: 'o', repo: 'r', ref: 'main', subdir: value },
        },
      } as never);
      const found = /Reproduce: `([^\n]*)`/.exec(card);
      return {
        line: found?.[1] ?? '',
        argv: (shown) => [
          'vet',
          '--online',
          // an empty subdirectory is none
          `github:o/r#main${shown === '' ? '' : `:${shown}`}`,
          '--expect',
          `sha256:${passport.artifact.digest}`,
        ],
      };
    },
  },
];

describe.skipIf(!posix).each(printers)('$name', ({ print, forbid = '' }) => {
  it.each(hostile())('keeps %s as one argument and runs nothing else', (_label, value) => {
    const { line, argv } = print(value);
    const run = argvOf(line);

    expect(existsSync(marker), line).toBe(false);
    // The line holds no raw control or invisible character, whatever the value held.
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    if (showable(value) && ![...forbid].some((char) => value.includes(char))) {
      // The program was started once, with exactly the arguments that were meant, the value being one of them.
      expect(run, line).toEqual(argv(value));
    } else {
      // A value that cannot be shown is not in the line at all; what stands in its place does nothing.
      expect(line).not.toContain(value);
      expect(line).toMatch(/<[a-z]+-too-long>|<unprintable-[a-z]+>/);
    }
  });
});

describe('quoteWord', () => {
  it.each([
    ['plain', 'abc-1.2/x_y@z:q,r+s=t%', 'abc-1.2/x_y@z:q,r+s=t%'],
    ['spaces', 'a b', `'a b'`],
    ['a single quote', "it's", `'it'\\''s'`],
    ['a dollar', '$HOME', `'$HOME'`],
    ['a tilde at the start, which a shell expands', '~/x', `'~/x'`],
    ['the empty string', '', `''`],
    ['a newline', 'a\nb', '<unprintable-value>'],
    ['too long', 'a'.repeat(4097), '<value-too-long>'],
  ])('writes %s for a POSIX shell', (_what, value, expected) => {
    expect(quoteWord(value, 'value', 'linux')).toBe(expected);
  });

  it.each([
    ['a path', 'C:\\Users\\me\\proj', 'C:\\Users\\me\\proj'],
    ['spaces', 'C:\\My Files\\x', '"C:\\My Files\\x"'],
    ['a trailing backslash after spaces', 'C:\\My Files\\', '"C:\\My Files\\\\"'],
    ['an ampersand, which double quotes keep', 'a & b', '"a & b"'],
    ['a pipe and brackets', 'a|b (c)', '"a|b (c)"'],
    ['a variable of cmd', '%PATH%', '<unprintable-value>'],
    ['a caret', 'a^b', '<unprintable-value>'],
    ['a bang', 'a!b', '<unprintable-value>'],
    ['a dollar, which PowerShell expands', '$(id)', '<unprintable-value>'],
    ['a backtick, which PowerShell escapes with', 'a`b', '<unprintable-value>'],
    ['a double quote', 'a"b', '<unprintable-value>'],
    ['a newline', 'a\nb', '<unprintable-value>'],
  ])('writes %s for cmd.exe and PowerShell', (_what, value, expected) => {
    expect(quoteWord(value, 'value', 'win32')).toBe(expected);
  });

  it('names what the placeholder stands for', () => {
    expect(quoteWord('a\u0000b', 'name')).toBe('<unprintable-name>');
    expect(quoteWord('a\u0000b', 'path')).toBe('<unprintable-path>');
    expect(quoteWord('a'.repeat(5000), 'source')).toBe('<source-too-long>');
  });

  it('refuses a character the caller names, such as a backtick in Markdown', () => {
    expect(quoteWord('a`b', 'value', 'linux', '`')).toBe('<unprintable-value>');
    expect(quoteWord('ab', 'value', 'linux', '`')).toBe('ab');
  });
});

describe('commandLine', () => {
  it('keeps a positional where it was written', () => {
    expect(
      commandLine(['stroq', 'add', { positional: 'demo' }, '--kind', 'mcp'], { platform: 'linux' }),
    ).toBe('stroq add demo --kind mcp');
  });

  it('puts every positional after -- when one starts with a dash', () => {
    expect(
      commandLine(['stroq', 'add', { positional: '-x' }, '--kind', 'mcp', { positional: 'y' }], {
        platform: 'linux',
      }),
    ).toBe('stroq add --kind mcp -- -x y');
  });

  it('writes an option value that starts with a dash as --flag=value', () => {
    expect(
      commandLine(['stroq', 'vet', { flag: '--from', value: '-x y' }, '--json'], {
        platform: 'linux',
      }),
    ).toBe(`stroq vet --from='-x y' --json`);
  });

  it('quotes for Windows when asked', () => {
    expect(
      commandLine(['stroq', 'vet', { flag: '--from', value: 'C:\\My Files' }], {
        platform: 'win32',
      }),
    ).toBe('stroq vet --from "C:\\My Files"');
  });
});
