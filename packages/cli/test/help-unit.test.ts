import { describe, expect, it } from 'vitest';
import {
  commandHelp,
  commandHint,
  parseArgsProblem,
  suggestCommand,
  unknownOption,
  usage,
  usageError,
  wantsHelp,
} from '../src/help.js';

// help.test.ts runs these through the built CLI, which is what a user runs but not
// what coverage sees; this file pins the same functions in-process.

describe('usage', () => {
  it('lists every command once, with help and --version', () => {
    const text = usage();
    expect(text.startsWith('stroq <command>\n')).toBe(true);
    for (const name of ['init', 'uninstall', 'hook', 'sent', 'coverage'])
      expect(text).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    expect(text).toContain('help [<command>]');
    expect(text).toContain('--version');
  });

  it('starts a newcomer with three commands, before the list', () => {
    const text = usage();
    const start = text.indexOf('Start here:');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(text.indexOf('Commands:'));
    const block = text.slice(start, text.indexOf('Commands:'));
    expect(block).toMatch(/^ {2}stroq init\s+guard the agents on this machine/m);
    expect(block).toMatch(/^ {2}stroq sent --last\s+which of your keys/m);
    expect(block).toMatch(/^ {2}stroq doctor\s+are the hooks in place/m);
  });

  it('keeps the newcomer block within 80 columns', () => {
    const text = usage();
    const block = text.slice(text.indexOf('Start here:'), text.indexOf('Commands:'));
    for (const line of block.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
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
    expect(unknownOption('doctor', ['--all', '--json'])).toBe('--json');
    expect(unknownOption('log', ['--bogus=1'])).toBe('--bogus');
  });

  it('accepts known options, their values, positionals and --help', () => {
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
