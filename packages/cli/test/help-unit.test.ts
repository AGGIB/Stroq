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
import { ATTACK_COUNT } from '../src/help-listing.js';
import { SCENARIOS } from '../src/attack/scenarios/index.js';

// help.test.ts runs these through the built CLI, which is what a user runs but not
// what coverage sees; this file pins the same functions in-process.

/** The commands on the first screen, in the order it lists them. The bare `stroq` is above them. */
const CORE = ['init', 'why', 'attack', 'uninstall'];
/** What Stroq writes into an agent's config (no person runs these), and the card, which `stroq` runs. */
const HIDDEN = ['hook', 'mcp', 'card', 'show'];

/** The commands a screen lists: one per line that starts with `stroq <name>`, indented or not. */
const listed = (text: string): string[] =>
  [...text.matchAll(/^ {0,2}stroq ([a-z][a-z-]*)/gm)].map((match) => match[1] ?? '');

const linesOf = (text: string): string[] => text.trimEnd().split('\n');

describe('usage: the first screen', () => {
  it('is the owner’s five lines and a pointer to the rest, and nothing else', () => {
    expect(usage()).toBe(
      [
        'stroq            who is really in charge of your agent? A card of your sessions',
        'stroq init       stop it next time: guard your agent',
        'stroq why        why an action was stopped',
        'stroq attack     watch Stroq stop 36 known attacks, in a sandbox',
        'stroq uninstall  remove Stroq',
        '',
        'More commands: stroq help --all',
        '',
      ].join('\n'),
    );
  });

  it('lists exactly the core commands, after the bare `stroq`', () => {
    const text = usage();
    expect(listed(text)).toEqual(CORE);
    expect(linesOf(text)[0]).toMatch(/^stroq {2,}who is really in charge of your agent\?/);
  });

  it('says how many attacks `stroq attack` replays, and that is the corpus', () => {
    expect(usage()).toContain(`stop ${SCENARIOS.length} known attacks`);
    expect(ATTACK_COUNT).toBe(SCENARIOS.length);
  });

  it('stays under 20 lines, within 80 columns', () => {
    const lines = linesOf(usage());
    expect(lines.length).toBeLessThan(20);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('ends by saying where the other commands are', () => {
    expect(usage()).toMatch(/\n\nMore commands: stroq help --all\n$/);
  });
});

describe('usageAll: stroq help --all', () => {
  const TITLES = [
    'Start here:',
    'Check past sessions:',
    'Check before you open or install:',
    'Guard your agent:',
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

  it('groups them by job, in this order, the five of the first screen first', () => {
    const text = usageAll();
    const at = TITLES.map((title) => text.indexOf(`\n${title}\n`));
    for (const [i, where] of at.entries()) expect(where, TITLES[i]).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const groups = at.map((start, i) => listed(text.slice(start, at[i + 1] ?? text.length)));
    expect(groups).toEqual([
      CORE,
      ['sent', 'replay'],
      ['inspect', 'vet', 'exposure'],
      ['console', 'doctor', 'untaint', 'trust', 'log', 'verify', 'policy', 'canary'],
    ]);
  });

  it('opens with what Stroq is for, keeps within 80 columns, and names --help and --version', () => {
    const text = usageAll();
    expect(text).toMatch(
      /^stroq: see what your AI coding agent saw, ran and installed\.\nRuns on your machine, no telemetry\.\n\n/,
    );
    for (const line of linesOf(text)) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(text).toMatch(/^One command: +stroq <command> --help$/m);
    expect(text).toMatch(/stroq --version/);
  });

  it('puts the bare `stroq` first under "Start here"', () => {
    expect(usageAll()).toMatch(/\nStart here:\n {2}stroq {2,}A card from your own sessions/);
  });
});

describe('tierOf', () => {
  it('gives every command a tier', () => {
    for (const name of commandNames()) expect(tierOf(name), name).not.toBeNull();
  });

  it('puts the first-screen commands in core, the rest of the list in more, the plumbing in hidden', () => {
    const tier = (which: string): string[] => commandNames().filter((n) => tierOf(n) === which);
    expect(tier('core')).toEqual(expect.arrayContaining(CORE));
    expect(tier('core')).toHaveLength(CORE.length);
    expect(tier('hidden')).toEqual(expect.arrayContaining(HIDDEN));
    expect(tier('hidden')).toHaveLength(HIDDEN.length);
    expect(tier('more').sort()).toEqual(
      [
        'sent',
        'replay',
        'inspect',
        'vet',
        'exposure',
        'console',
        'doctor',
        'untaint',
        'trust',
        'log',
        'verify',
        'policy',
        'canary',
      ].sort(),
    );
  });

  it('is null for a name that is not a command, a property name included', () => {
    for (const word of ['nope', 'help', 'stroq', 'constructor', '__proto__'])
      expect(tierOf(word)).toBeNull();
  });
});

describe('commandHelp', () => {
  it('explains the strict tool-approval opt-in and its environment requirement', () => {
    const help = commandHelp('mcp') ?? '';
    expect(help).toContain('--tool-approval');
    expect(help).toContain('explicit --pass-env');
    expect(help).toContain('not with --cloak');
  });

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

  it('leaves the Windows quoting of init to the guide', () => {
    expect(commandHelp('init')).not.toMatch(/cmd\.exe|quote/);
  });
});

describe('wantsHelp', () => {
  it('answers --help and -h anywhere in the command’s own arguments', () => {
    expect(wantsHelp('log', ['--json', '--help'])).toBe(true);
    expect(wantsHelp('log', ['-h'])).toBe(true);
    expect(wantsHelp('log', ['--json'])).toBe(false);
  });

  it('leaves a --help after `--` to the program run or wrapped', () => {
    expect(wantsHelp('mcp', ['--server', 'x', '--', 'node', 's.js', '-h'])).toBe(false);
    expect(wantsHelp('mcp', ['--help', '--', 'node', 's.js'])).toBe(true);
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
    expect(unknownOption('policy', ['check', '--json'])).toBeNull();
    expect(unknownOption('sent', ['--help'])).toBeNull();
    expect(unknownOption('log', ['-'])).toBeNull();
  });

  it('does not read past `--` for a pass-through command', () => {
    expect(
      unknownOption('mcp', ['--server', 'x', '--', 'node', 's.js', '--dangerously-anything']),
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
      'stroq has no install: `stroq init` guards an agent, `stroq vet` checks a skill or MCP server before you add it.',
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
