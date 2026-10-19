import { describe, expect, it } from 'vitest';
import {
  commandHelp,
  commandHint,
  commandNames,
  parseArgsProblem,
  suggestCommand,
  tierOf,
  unknownOption,
  usage,
  usageAll,
  usageError,
  wantsHelp,
} from '../src/help.js';

// help.test.ts runs these through the built CLI, which is what a user runs but not
// what coverage sees; this file pins the same functions in-process.

/** The commands on the first screen, in the order it lists them. */
const CORE = ['sent', 'inspect', 'vet', 'init', 'doctor', 'why', 'uninstall'];
/** What Stroq writes into an agent's config: no person runs these, so no list shows them. */
const HIDDEN = ['hook', 'mcp'];

/** The commands a screen lists: one per line that starts with `  stroq <name>`. */
const listed = (text: string): string[] =>
  [...text.matchAll(/^ {2}stroq ([a-z][a-z-]*)/gm)].map((match) => match[1] ?? '');

const linesOf = (text: string): string[] => text.trimEnd().split('\n');

describe('usage: the first screen', () => {
  it('opens with what Stroq is for, in two lines', () => {
    expect(usage()).toMatch(
      /^stroq: see what your AI coding agent saw, ran and installed\.\nRuns on your machine, no telemetry\.\n\n/,
    );
  });

  it('lists exactly the core commands: three that read under Check, four under Guard', () => {
    const text = usage();
    expect(listed(text)).toEqual(CORE);
    const check = text.indexOf('\nCheck (reads only):\n');
    const guard = text.indexOf('\nGuard (');
    expect(check).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(check);
    expect(listed(text.slice(check, guard))).toEqual(['sent', 'inspect', 'vet']);
    expect(listed(text.slice(guard))).toEqual(['init', 'doctor', 'why', 'uninstall']);
  });

  it('stays under 20 lines, within 80 columns', () => {
    const lines = linesOf(usage());
    expect(lines.length).toBeLessThan(20);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('ends by saying where the other commands and the options are', () => {
    expect(usage()).toMatch(
      /\n\nAll commands: +stroq help --all\nOne command: +stroq <command> --help\n$/,
    );
  });
});

describe('usageAll: stroq help --all', () => {
  const TITLES = [
    'Check past sessions:',
    'Guard your agent:',
    'Check before you open or install:',
    'Test Stroq itself:',
    'Experimental:',
  ];

  it('lists every command but the hidden ones, each once', () => {
    const names = listed(usageAll());
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(
      commandNames()
        .filter((n) => !HIDDEN.includes(n))
        .sort(),
    );
    for (const name of HIDDEN) expect(names).not.toContain(name);
  });

  it('groups them by job, in this order', () => {
    const text = usageAll();
    const at = TITLES.map((title) => text.indexOf(`\n${title}\n`));
    for (const [i, where] of at.entries()) expect(where, TITLES[i]).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const groups = at.map((start, i) => listed(text.slice(start, at[i + 1] ?? text.length)));
    expect(groups).toEqual([
      ['sent', 'replay'],
      ['init', 'doctor', 'why', 'uninstall', 'untaint', 'trust', 'log', 'verify', 'policy'],
      ['inspect', 'vet', 'add', 'remove', 'exposure', 'run'],
      ['attack', 'bench', 'coverage', 'prove', 'canary'],
      ['task', 'permit', 'harden'],
    ]);
  });

  it('opens like the first screen, keeps within 80 columns, and names --help and --version', () => {
    const text = usageAll();
    expect(text.startsWith(linesOf(usage()).slice(0, 2).join('\n'))).toBe(true);
    for (const line of linesOf(text)) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(text).toMatch(/^One command: +stroq <command> --help$/m);
    expect(text).toMatch(/stroq --version/);
  });
});

describe('tierOf', () => {
  it('gives every command a tier', () => {
    for (const name of commandNames()) expect(tierOf(name), name).not.toBeNull();
  });

  it('puts the first-screen commands in core and the plumbing in hidden', () => {
    expect(commandNames().filter((n) => tierOf(n) === 'core')).toEqual(
      expect.arrayContaining(CORE),
    );
    expect(commandNames().filter((n) => tierOf(n) === 'core')).toHaveLength(CORE.length);
    expect(commandNames().filter((n) => tierOf(n) === 'hidden')).toEqual(
      expect.arrayContaining(HIDDEN),
    );
    expect(commandNames().filter((n) => tierOf(n) === 'hidden')).toHaveLength(HIDDEN.length);
  });

  it('is null for a name that is not a command, a property name included', () => {
    for (const word of ['nope', 'help', 'constructor', '__proto__'])
      expect(tierOf(word)).toBeNull();
  });
});

describe('commandHelp', () => {
  it('prints the synopsis, what the command does, and its options', () => {
    const text = commandHelp('log') ?? '';
    expect(text.startsWith('stroq log [--count 20] [--json]\n')).toBe(true);
    expect(text).toContain('Options:');
    expect(text).toMatch(/--count <n>\s+how many entries/);
  });

  it('prints no options block for a command without any', () => {
    expect(commandHelp('verify')).not.toContain('Options:');
  });

  it('is null for a name that is not a command', () => {
    expect(commandHelp('nope')).toBeNull();
  });

  it('still prints the full text of a hidden command', () => {
    expect(commandHelp('hook')).toMatch(/^stroq hook <agent>/);
    expect(commandHelp('mcp')).toMatch(/^stroq mcp --server <name>/);
  });

  it('says how add is confirmed in plain words: a report, then 12 characters of a fingerprint', () => {
    const text = commandHelp('add') ?? '';
    expect(text).not.toMatch(/passport|hex digits/);
    expect(text).toMatch(/report/);
    expect(text).toMatch(/first 12 characters of (?:its|that) fingerprint/);
  });

  it('leaves the Windows quoting of init to the guide', () => {
    expect(commandHelp('init')).not.toMatch(/cmd\.exe|quote/);
  });

  it('says what prove checks, what it costs and that it asks first', () => {
    const text = commandHelp('prove') ?? '';
    expect(text).toMatch(/^ {2}check that blocking really works/m);
    expect(text).toContain('up to 3');
    expect(text).toContain('asks first');
    expect(text).toMatch(/Exit 0/);
    expect(text).not.toContain('evidence the model does not write');
  });
});

describe('wantsHelp', () => {
  it('answers --help and -h anywhere in the command’s own arguments', () => {
    expect(wantsHelp('log', ['--json', '--help'])).toBe(true);
    expect(wantsHelp('log', ['-h'])).toBe(true);
    expect(wantsHelp('log', ['--json'])).toBe(false);
  });

  it('leaves a --help after `--` to the program run or wrapped', () => {
    expect(wantsHelp('run', ['--', 'claude', '--help'])).toBe(false);
    expect(wantsHelp('mcp', ['--server', 'x', '--', 'node', 's.js', '-h'])).toBe(false);
    expect(wantsHelp('run', ['--help', '--', 'claude'])).toBe(true);
  });
});

describe('unknownOption', () => {
  it('finds the first option a command does not have', () => {
    expect(unknownOption('doctor', ['--all', '--json', '--bogus'])).toBe('--bogus');
    expect(unknownOption('log', ['--bogus=1'])).toBe('--bogus');
  });

  it('accepts known options, their values, positionals and --help', () => {
    expect(unknownOption('doctor', ['--all', '--json'])).toBeNull();
    expect(unknownOption('log', ['--count', '5', '--json'])).toBeNull();
    expect(unknownOption('log', ['--count=5'])).toBeNull();
    expect(unknownOption('trust', ['README.md', '--json'])).toBeNull();
    expect(unknownOption('coverage', ['--format', 'navigator'])).toBeNull();
    expect(unknownOption('sent', ['--help'])).toBeNull();
    expect(unknownOption('log', ['-'])).toBeNull();
  });

  it('does not read past `--` for a pass-through command', () => {
    expect(
      unknownOption('run', ['--sandbox', '--', 'claude', '--dangerously-anything']),
    ).toBeNull();
  });

  it('has nothing to say about a name that is not a command', () => {
    expect(unknownOption('nope', ['--x'])).toBeNull();
  });
});

describe('usageError', () => {
  it('names the command, the problem and where to look', () => {
    expect(usageError('log', 'unknown option --x')).toBe(
      'stroq log: unknown option --x\nRun "stroq log --help" to see its options.\n',
    );
  });
});

describe('parseArgsProblem', () => {
  it('keeps the first sentence of a parseArgs error', () => {
    const err = Object.assign(
      new Error(
        "Option '--agent <value>' argument missing. To specify a positional argument starting with a '-', place it at the end.",
      ),
      { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' },
    );
    expect(parseArgsProblem(err)).toBe("Option '--agent <value>' argument missing");
  });

  it('is null for any other error', () => {
    expect(parseArgsProblem(new Error('disk full'))).toBeNull();
    expect(parseArgsProblem(null)).toBeNull();
  });
});

describe('suggestCommand', () => {
  it.each([
    ['snet', 'sent'],
    ['doctr', 'doctor'],
    ['unintsall', 'uninstall'],
    ['INIT', 'init'],
  ])('%s → %s', (typed, meant) => expect(suggestCommand(typed)).toBe(meant));

  it('suggests nothing for a word that is not close to any command', () => {
    expect(suggestCommand('kubernetes')).toBeNull();
  });

  // "install" is two letters from "uninstall", and a person who types it wants to add something, not to
  // take Stroq out: the wrong suggestion is the one command that undoes what they came to do.
  it.each(['install', 'INSTALL', 'Install'])('does not suggest uninstall for %s', (typed) => {
    expect(suggestCommand(typed)).not.toBe('uninstall');
    expect(suggestCommand(typed)).toBeNull();
  });
});

describe('commandHint', () => {
  it('says what to run instead of install, in one line that names both commands', () => {
    const hint = commandHint('install');
    expect(hint).toBe(
      'stroq has no install: `stroq init` guards an agent, `stroq add` adds a local skill after a check.',
    );
    expect(hint).not.toContain('\n');
  });

  it('answers a different spelling of the case, and nothing for a word that has no hint', () => {
    expect(commandHint('INSTALL')).toBe(commandHint('install'));
    expect(commandHint('uninstall')).toBeNull();
    expect(commandHint('kubernetes')).toBeNull();
    expect(commandHint('')).toBeNull();
  });

  it('is not fooled by a name that only looks like an own property of the table', () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
      expect(commandHint(word), word).toBeNull();
  });
});
