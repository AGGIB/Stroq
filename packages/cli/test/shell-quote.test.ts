import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADD_OPTIONS } from '../src/commands/add.js';
import { REMOVE_OPTIONS } from '../src/commands/remove.js';
import { UNTAINT_OPTIONS } from '../src/commands/untaint.js';
import { VET_OPTIONS } from '../src/commands/vet.js';
import { unknownOption, wantsHelp } from '../src/help.js';
import { keptNote } from '../src/commands/init-mcp.js';
import { openclawInstallCommands } from '../src/commands/openclaw-plugin.js';
import { parseRunArgv } from '../src/commands/run.js';
import { renderCard } from '../src/commands/vet-card.js';
import { CONFIRM_SENSITIVE_MAX, confirmationScreen } from '../src/commands/vet-render.js';
import { wrongCallLines } from '../src/commands/why.js';
import { inspectTree } from '../src/install/inspect/index.js';
import { mcpRemedyCommands, skillRemedyCommands } from '../src/install/remedy.js';
import { reconfirmCommand } from '../src/mcp/pin-argument.js';
import { commandLine, quoteWord, tryCommandLine, unprintableSentence } from '../src/shell-quote.js';
import { treeOf } from './helpers/install-tree.js';

/**
 * Every command line that Stroq prints for a person to paste has values in it that somebody else wrote: the name of a
 * server in a config, the path a lock remembers, the ref of a package. None of them may become a second command, a
 * redirection or an option when the line is pasted, in whichever shell it is pasted. The lines are built by
 * `commandLine`, which writes a value bare only from a whitelist of characters, between single quotes only if nothing
 * in it means something there to any shell, and otherwise prints a plain sentence instead of a command.
 *
 * The tests hold each printer to that by running the printed line through the shells on this machine, with `stroq`
 * and `openclaw` standing for a script that writes its arguments separated by NUL. The payloads in the values write
 * a marker file, which must not exist afterwards; the program must be started once, and the value must be exactly
 * one of its arguments. Where the rule says a value cannot be printed, the text is a sentence in letters, spaces and
 * commas, with nothing in it that any shell reads.
 */
const posix = process.platform !== 'win32';

let dir = '';
let bin = '';
let marker = '';
let shells: readonly (readonly [name: string, flags: readonly string[]])[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-quote-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  marker = join(dir, 'pwned');
  for (const program of ['stroq', 'openclaw']) {
    const file = join(bin, program);
    writeFileSync(file, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n');
    chmodSync(file, 0o755);
  }
  if (!posix) return;
  const present = (name: string): boolean => {
    try {
      execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const flags: Record<string, readonly string[]> = {
    sh: ['-c'],
    bash: ['-c'],
    dash: ['-c'],
    zsh: ['-c'],
    csh: ['-f', '-c'],
    tcsh: ['-f', '-c'],
    fish: ['--no-config', '-c'],
  };
  shells = Object.entries(flags).filter(([name]) => present(name));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the program was started with when the line was run by this shell, or null if it was not started. */
function argvIn(shell: string, flags: readonly string[], line: string): string[] | null {
  try {
    const out = execFileSync(shell, [...flags, line], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out === '' ? [] : out.split('\0').slice(0, -1);
  } catch {
    return null;
  }
}

type Verdict = 'print' | 'fallback';

/**
 * Values from outside, each of them written to break out of a line, one way or another, and what the rule says of it.
 * A value that begins with `-` is printed only where it is the value of an option (`--from=-x`); where it would be a
 * positional it is refused, and the printers say which they are.
 */
const hostile = (): readonly (readonly [label: string, value: string, verdict: Verdict])[] => [
  ['semicolon', `x; printf pwned > ${marker}`, 'print'],
  ['command substitution', `$(printf pwned > ${marker})`, 'print'],
  ['backticks', `\`printf pwned > ${marker}\``, 'print'],
  ['a single quote that closes the quoting', `x'; printf pwned > ${marker}; '`, 'fallback'],
  ['a double quote that closes the quoting', `x"; printf pwned > ${marker}; "`, 'print'],
  ['and', `x && printf pwned > ${marker}`, 'print'],
  ['pipe', `x | printf pwned > ${marker}`, 'print'],
  ['background', `x & printf pwned > ${marker}`, 'print'],
  ['redirect to', `x > ${marker}`, 'print'],
  ['redirect from', `< ${marker}`, 'print'],
  ['both redirects', `<${marker}>${marker}`, 'print'],
  ['percent variable', '%PATH%', 'print'],
  ['a job reference', '%self', 'print'],
  ['caret', 'a^b^', 'print'],
  ['bang', 'a!b', 'fallback'],
  ['a bang first', '!x', 'fallback'],
  ['a history reference', '!!', 'fallback'],
  ['dollar variable', '$HOME ${IFS}', 'print'],
  ['glob', '*', 'print'],
  ['tilde', '~root', 'print'],
  ['a home path', '~/x', 'print'],
  ['a response file', '@file', 'print'],
  ['a response file by path', '@/tmp/args.txt', 'print'],
  ['an equals sign inside', 'a=b', 'print'],
  ['equals first, which zsh expands', '=ls', 'print'],
  ['the name of a subcommand', 'add', 'print'],
  ['the name of another subcommand', 'remove', 'print'],
  ['brace', '{a,b}', 'print'],
  ['space', 'a b  c', 'print'],
  ['hash', 'a #b', 'print'],
  ['backslash', 'a\\b', 'fallback'],
  ['a backslash last', 'a\\', 'fallback'],
  ['only a quote', "'", 'fallback'],
  ['only a double quote', '"', 'print'],
  ['a quote and a backslash', `\\'`, 'fallback'],
  ['the empty string', '', 'print'],
  ['a short option', '-x', 'print'],
  ['a long option', '--force', 'print'],
  ['the help option', '--help', 'print'],
  ['the short help option', '-h', 'print'],
  ['an option with a value', '--kind=mcp', 'print'],
  ['a dash alone', '-', 'print'],
  ['a leading dash with a space', '-x y', 'print'],
  ['the separator', '--', 'print'],
  ['a newline', `x\nprintf pwned > ${marker}`, 'fallback'],
  ['a carriage return', `x\rprintf pwned > ${marker}`, 'fallback'],
  ['NUL', 'a\u0000b', 'fallback'],
  ['escape', 'a\u001b[2Jb', 'fallback'],
  ['a bell', 'a\u0007', 'fallback'],
  ['DEL', 'a\u007fb', 'fallback'],
  ['a next-line control', 'a\u0085b', 'fallback'],
  ['a line separator', 'a b', 'fallback'],
  ['a paragraph separator', 'a b', 'fallback'],
  ['a right-to-left override', 'abc‮def', 'fallback'],
  ['a zero-width space', 'a​b', 'fallback'],
  ['a lone surrogate', 'a\ud800b', 'fallback'],
  ['a long value', 'a'.repeat(5000), 'fallback'],
  ['a very long value', 'a'.repeat(10_000), 'fallback'],
  ['a long value of quotes', "'".repeat(3000), 'fallback'],
  ['unicode that is only text', 'проект/日本語/ünï', 'print'],
  ['every kind of bracket', '([{<>}])', 'print'],
  ['a plain name', 'demo', 'print'],
  ['a name with a hyphen and a digit', 'weather-2_a', 'print'],
  ['an absolute path', '/home/me/my project/it.js', 'print'],
];

/** A line that was printed, or the sentence that stands in for it. */
const isCommand = (text: string): boolean => /^(?:stroq|openclaw) /.test(text);
/** Nothing in it means anything to a shell. */
const SENTENCE = /^[A-Za-z ,.]+$/;

/** What the parser of a command makes of its arguments. */
interface Parsed {
  readonly positionals: readonly string[];
  readonly values: Record<string, unknown>;
}

/**
 * The arguments as the command reads them: first Stroq's own look at every argument before the command runs (help,
 * an option the command does not have), then the real option table of the command with `util.parseArgs`.
 */
function parsedBy(argv: readonly string[]): Parsed | null {
  const [command = '', ...rest] = argv;
  expect(wantsHelp(command, rest), argv.join(' ')).toBe(false);
  expect(unknownOption(command, rest), argv.join(' ')).toBeNull();
  switch (command) {
    case 'add':
      return parseArgs({ args: rest, allowPositionals: true, options: ADD_OPTIONS });
    case 'remove':
      return parseArgs({ args: rest, allowPositionals: true, options: REMOVE_OPTIONS });
    case 'untaint':
      return parseArgs({ args: rest, options: UNTAINT_OPTIONS });
    case 'vet':
      return parseArgs({ args: rest, options: VET_OPTIONS });
    default:
      return null;
  }
}

interface Printer {
  readonly name: string;
  /** Characters this printer cannot carry because the line goes into text where they mean something. */
  readonly forbid?: string;
  /** The value is a positional of the command, so one that begins with a dash is not printed. */
  readonly positional?: true;
  /** The command or the sentence for a value, the arguments a program should get, and how the command should read them. */
  readonly print: (value: string) => {
    text: string;
    argv: (shown: string) => string[];
    parsed?: (shown: string) => Parsed;
  };
}

const record = (value: string) => ({
  source: value,
  config: value,
  entrypoint: value,
  passEnv: ['A', 'B'],
  cwd: value,
});
const emptyPassport = () =>
  inspectTree(treeOf({ 'SKILL.md': '# demo' }), {
    kind: 'skill',
    source: { type: 'dir', label: 'demo' },
    extraBlindSpots: [],
    stroqVersion: 'test',
    rulesId: 'test',
  });

const reconfirm = {
  argv: (shown: string) => ['add', shown, '--kind', 'mcp', '--force'],
  parsed: (shown: string): Parsed => ({
    positionals: [shown],
    values: { kind: 'mcp', force: true },
  }),
};

const printers: readonly Printer[] = [
  {
    name: 'the line that confirms a wrapper again (init, the proxy, doctor)',
    positional: true,
    print: (value) => ({ text: reconfirmCommand(value), ...reconfirm }),
  },
  {
    name: 'the note init prints for a wrapper it kept',
    positional: true,
    print: (value) => ({
      text: keptNote(value, false).split('confirm it again: ')[1]!,
      ...reconfirm,
    }),
  },
  {
    name: 'the remove line for a damaged server',
    positional: true,
    print: (value) => ({
      text: mcpRemedyCommands(value, record(value))[0]!,
      argv: (shown) => ['remove', shown, '--kind', 'mcp', '--force'],
      parsed: (shown) => ({ positionals: [shown], values: { kind: 'mcp', force: true } }),
    }),
  },
  {
    name: 'the add line for a damaged server',
    positional: true,
    print: (value) => ({
      text: mcpRemedyCommands(value, record(value)).at(-1)!,
      argv: (shown) => [
        'add',
        shown,
        '--kind',
        'mcp',
        `--name=${shown}`,
        `--config=${shown}`,
        `--entrypoint=${shown}`,
        '--pass-env=A,B',
        `--cwd=${shown}`,
      ],
      parsed: (shown) => ({
        positionals: [shown],
        values: {
          kind: 'mcp',
          name: shown,
          config: shown,
          entrypoint: shown,
          'pass-env': 'A,B',
          cwd: shown,
        },
      }),
    }),
  },
  {
    name: 'the remove line for a damaged skill',
    positional: true,
    print: (value) => ({
      text: skillRemedyCommands(
        value,
        { source: value, root: '/p' },
        { home: '/h', project: '/p' },
      )[0]!,
      argv: (shown) => ['remove', shown, '--force'],
      parsed: (shown) => ({ positionals: [shown], values: { force: true } }),
    }),
  },
  {
    name: 'the add line for a damaged skill',
    positional: true,
    print: (value) => ({
      text: skillRemedyCommands(
        value,
        { source: value, root: '/h' },
        { home: '/h', project: '/p' },
      ).at(-1)!,
      argv: (shown) => ['add', shown, '--user'],
      parsed: (shown) => ({ positionals: [shown], values: { user: true } }),
    }),
  },
  {
    name: 'the refusal of a screen with too many sensitive lines',
    print: (value) => {
      const passport = emptyPassport();
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
        text: message.split('Read every line with: ')[1]!,
        argv: (shown) => ['vet', `--from=${shown}`, '--json'],
        parsed: (shown) => ({ positionals: [], values: { from: shown, json: true } }),
      };
    },
  },
  {
    name: 'the line that clears a session',
    print: (value) => {
      const entry = { sessionId: value, decision: { effect: 'deny', ruleId: 'r' } } as never;
      return {
        text: wrongCallLines(entry)[1]!.split('outside the agent: ')[1]!,
        argv: (shown) => ['untaint', `--session=${shown}`],
        parsed: (shown) => ({ positionals: [], values: { session: shown } }),
      };
    },
  },
  {
    // The command is another program's (OpenClaw's): there is no parser of ours to check it with, so a dash first is refused.
    name: 'the commands that register the OpenClaw plugin',
    positional: true,
    print: (value) => ({
      text: openclawInstallCommands(value)[0]!,
      argv: (shown) => ['plugins', 'install', '--link', shown],
    }),
  },
  {
    name: 'the "did you mean" of stroq run',
    print: (value) => {
      const parsed = parseRunArgv([`w${value}`]);
      const message = parsed.ok ? '' : parsed.error;
      return {
        text: message.split('did you mean: ')[1]!,
        argv: (shown) => ['run', '--', `w${shown}`],
      };
    },
  },
  {
    name: 'the reproduce line of the card of a GitHub source',
    forbid: '`',
    print: (value) => {
      const passport = emptyPassport();
      const card = renderCard({
        ...passport,
        artifact: {
          ...passport.artifact,
          source: { type: 'github', owner: 'o', repo: 'r', ref: 'main', subdir: value },
        },
      } as never);
      const line = /Reproduce: (.*)$/m.exec(card)![1]!;
      // An empty subdirectory is none.
      const spec = (shown: string) => `github:o/r#main${shown === '' ? '' : `:${shown}`}`;
      return {
        text: line.startsWith('`') ? line.slice(1, -1) : line,
        argv: (shown) => [
          'vet',
          `--online=${spec(shown)}`,
          `--expect=sha256:${passport.artifact.digest}`,
        ],
        parsed: (shown) => ({
          positionals: [],
          values: { online: spec(shown), expect: `sha256:${passport.artifact.digest}` },
        }),
      };
    },
  },
];

describe.skipIf(!posix).each(printers)('$name', ({ print, forbid = '', positional = false }) => {
  it.each(hostile())('keeps %s as one argument, or prints no command', (_label, value, said) => {
    const { text, argv, parsed } = print(value);
    const printed = isCommand(text);
    const carried = ![...forbid].some((char) => value.includes(char));
    // A positional that begins with a dash would be read as an option: it is not printed.
    const verdict = positional && value.startsWith('-') ? 'fallback' : said;

    // Nothing in the text is a raw control or invisible character, or a placeholder in angle brackets.
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    expect(text).not.toMatch(/<unprintable|<[a-z]+-too-long>/);
    if (verdict === 'print' && carried) expect(printed, text).toBe(true);
    if (verdict === 'fallback') expect(printed, text).toBe(false);
    if (!printed) {
      // No command at all: a sentence of letters, spaces and commas that says so.
      expect(text).toMatch(SENTENCE);
      expect(text).toContain('cannot be quoted safely');
      return;
    }
    for (const [shell, flags] of shells) {
      const run = argvIn(shell, flags, text);
      expect(existsSync(marker), `${shell}: ${text}`).toBe(false);
      // The program was started once, with exactly the arguments that were meant, the value being one of them.
      expect(run, `${shell}: ${text}`).toEqual(argv(value));
    }
    // And the command reads them as meant: the value is the positional or the value of the option, not an option.
    if (parsed !== undefined) {
      const read = parsedBy(argv(value));
      expect(read?.positionals, text).toEqual(parsed(value).positionals);
      expect(read?.values, text).toMatchObject(parsed(value).values);
    }
  });
});

describe('quoteWord on a POSIX shell', () => {
  it.each([
    ['plain', 'abc-1.2/x_y@z:q,r+s=t%', 'abc-1.2/x_y@z:q,r+s=t%'],
    ['spaces', 'a b', `'a b'`],
    ['a dollar', '$HOME', `'$HOME'`],
    ['a tilde, which a shell expands at the start', '~/x', `'~/x'`],
    ['an equals sign first, which zsh expands', '=ls', `'=ls'`],
    ['a percent sign first, which fish expands', '%self', `'%self'`],
    ['a dash first', '-x', `'-x'`],
    ['the empty string', '', `''`],
    ['a double quote', 'a"b', `'a"b'`],
    ['brackets and redirects', 'a<b>c(d)[e]{f}', `'a<b>c(d)[e]{f}'`],
  ])('writes %s', (_what, value, expected) => {
    expect(quoteWord(value, 'linux')).toBe(expected);
  });

  it.each([
    ['a single quote', "it's"],
    ['a backslash', 'a\\b'],
    ['a bang, which csh expands between single quotes', 'a!b'],
    ['a newline', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['NUL', 'a\u0000b'],
    ['DEL', 'a\u007fb'],
    ['U+0085', 'a\u0085b'],
    ['U+2028', 'a\u2028b'],
    ['U+2029', 'a\u2029b'],
    ['a bidi override', 'a\u202eb'],
    ['a zero-width joiner', 'a\u200db'],
    ['a variation selector', 'a\ufe0fb'],
    ['a lone surrogate', 'a\udc00b'],
    ['more than 4096 characters', 'a'.repeat(4097)],
  ])('does not write %s', (_what, value) => {
    expect(quoteWord(value, 'linux')).toBeNull();
  });

  it('refuses a character the caller names, such as a backtick in Markdown', () => {
    expect(quoteWord('a`b', 'linux', '`')).toBeNull();
    expect(quoteWord('ab', 'linux', '`')).toBe('ab');
    expect(quoteWord('a`b', 'linux')).toBe("'a`b'");
  });
});

describe('quoteWord for cmd.exe and PowerShell', () => {
  it.each([
    ['a path', 'C:\\Users\\me\\proj', 'C:\\Users\\me\\proj'],
    ['spaces', 'C:\\My Files\\x', '"C:\\My Files\\x"'],
    [
      'parentheses and a colon in quotes',
      'C:\\Program Files (x86)\\a',
      '"C:\\Program Files (x86)\\a"',
    ],
    ['a single quote, which is literal in double quotes', "it's here", `"it's here"`],
    ['a dash first', '-x', '"-x"'],
    ['the empty string', '', '""'],
  ])('writes %s', (_what, value, expected) => {
    expect(quoteWord(value, 'win32')).toBe(expected);
  });

  it.each([
    ['a variable of cmd', '%PATH%'],
    ['a caret', 'a^b'],
    ['a bang', 'a!b'],
    ['an ampersand', 'a & b'],
    ['a pipe', 'a|b'],
    ['an angle bracket', 'a>b'],
    ['an angle bracket the other way', 'a<b'],
    ['a dollar, which PowerShell expands', '$(id)'],
    ['a backtick, which PowerShell escapes with', 'a`b'],
    ['a double quote', 'a"b'],
    ['a newline', 'a\nb'],
    ['a trailing backslash after a space, which would escape the closing quote', 'C:\\My Files\\'],
  ])('does not write %s', (_what, value) => {
    expect(quoteWord(value, 'win32')).toBeNull();
  });

  it('writes a line with the quotes of Windows', () => {
    expect(
      commandLine(['stroq', 'vet', { flag: '--from', value: 'C:\\My Files' }], {
        platform: 'win32',
      }),
    ).toBe('stroq vet --from="C:\\My Files"');
  });
});

describe('commandLine', () => {
  it('keeps a positional where it was written', () => {
    expect(
      commandLine(['stroq', 'add', { positional: 'demo' }, '--kind', 'mcp'], { platform: 'linux' }),
    ).toBe('stroq add demo --kind mcp');
  });

  it('writes the value of an option as --flag=value, and quotes it', () => {
    expect(
      commandLine(['stroq', 'vet', { flag: '--from', value: '/my dir' }, '--json'], {
        platform: 'linux',
      }),
    ).toBe(`stroq vet --from='/my dir' --json`);
  });

  it('writes the value of an option that begins with a dash after the equals sign', () => {
    expect(
      commandLine(['stroq', 'vet', { flag: '--from', value: '-x y' }, '--json'], {
        platform: 'linux',
      }),
    ).toBe(`stroq vet --from='-x y' --json`);
    expect(
      commandLine(['stroq', 'vet', { flag: '--from', value: '--help' }], { platform: 'linux' }),
    ).toBe("stroq vet --from='--help'");
  });

  it('prints no command for a positional that begins with a dash, and no -- before it', () => {
    const line = commandLine(
      ['stroq', 'add', { positional: '-x', what: 'name' }, '--kind', 'mcp'],
      {
        platform: 'linux',
      },
    );

    expect(line).toBe(unprintableSentence('name'));
    expect(line).not.toContain('--');
  });

  it('writes the words after a -- that hands the rest to another program as they are', () => {
    expect(
      commandLine(['stroq', 'run', '--', { word: 'claude' }, { word: '-p' }, { word: 'a b' }], {
        platform: 'linux',
      }),
    ).toBe(`stroq run -- claude '-p' 'a b'`);
  });

  it('prints a sentence, and no command, when one value cannot be quoted', () => {
    const line = commandLine(
      [
        'stroq',
        'add',
        { positional: 'a', what: 'path' },
        { flag: '--name', value: "it's", what: 'name' },
      ],
      { platform: 'linux' },
    );

    expect(line).toBe(unprintableSentence('name'));
    expect(line).toMatch(SENTENCE);
    expect(line).not.toContain('stroq add');
  });

  it('says which value it was, and where to look for a name or an id', () => {
    expect(unprintableSentence('name')).toContain('stroq doctor lists the installed names');
    expect(unprintableSentence('id')).toContain('stroq log lists the sessions');
    for (const what of ['name', 'path', 'source', 'id', 'value'] as const)
      expect(unprintableSentence(what)).toMatch(SENTENCE);
  });

  it('reports what kind of value could not be printed', () => {
    expect(
      tryCommandLine(['stroq', { positional: 'a\nb', what: 'source' }], { platform: 'linux' }),
    ).toEqual({ line: null, unprintable: 'source' });
  });
});

describe('the parsers of the commands that print lines', () => {
  it.each([
    ['add', ADD_OPTIONS, '--name'],
    ['add', ADD_OPTIONS, '--config'],
    ['add', ADD_OPTIONS, '--entrypoint'],
    ['add', ADD_OPTIONS, '--cwd'],
    ['add', ADD_OPTIONS, '--pass-env'],
    ['add', ADD_OPTIONS, '--client'],
    ['vet', VET_OPTIONS, '--from'],
    ['vet', VET_OPTIONS, '--online'],
    ['vet', VET_OPTIONS, '--expect'],
    ['untaint', UNTAINT_OPTIONS, '--session'],
  ] as const)('%s reads %s=<anything> as the value of the option', (command, options, flag) => {
    for (const value of ['-x', '--help', '--force', '-', '--', '-h', '@file', '~/x', 'a=b', '=x']) {
      const rest = [`${flag}=${value}`];
      expect(wantsHelp(command, rest), `${flag}=${value}`).toBe(false);
      expect(unknownOption(command, rest), `${flag}=${value}`).toBeNull();
      const { values } = parseArgs({ args: rest, allowPositionals: true, options });
      expect((values as Record<string, unknown>)[flag.slice(2)]).toBe(value);
    }
  });

  it('does not read the same values after a space as a value, which is why they are not printed that way', () => {
    for (const value of ['-x', '--force', '-h']) {
      expect(() => parseArgs({ args: ['--session', value], options: UNTAINT_OPTIONS })).toThrow();
    }
  });

  it('does not take a -- before a positional that begins with a dash as enough: Stroq looks at it first', () => {
    // `stroq add --kind mcp -- -x` stops at the check for an option `add` does not have; `-h` shows the help.
    expect(unknownOption('add', ['--kind', 'mcp', '--', '-x'])).toBe('-x');
    expect(wantsHelp('add', ['--kind', 'mcp', '--', '-h'])).toBe(true);
  });

  it('has no response file and no tilde of its own in the arguments it prints', () => {
    // `@file` and `~/x` are values like any other to the parsers; the shell expands a tilde only when it is bare.
    const { positionals } = parseArgs({
      args: ['@file', '~/x'],
      allowPositionals: true,
      options: ADD_OPTIONS,
    });
    expect(positionals).toEqual(['@file', '~/x']);
    expect(quoteWord('~/x', 'linux')).toBe("'~/x'");
    expect(quoteWord('@file', 'linux')).toBe('@file');
  });
});
