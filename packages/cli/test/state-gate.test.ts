import { classifyTool } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { commandNames } from '../src/help.js';

/**
 * Stroq's own commands that change what it enforces, or that write where the caller says, are not for
 * an agent to run through a shell: the gate in `core/src/actions/stroq-state.ts` reads a command line for them
 * and the classifier answers `config.self`. It keeps its list of them by hand, so a command added to the CLI is
 * open to an agent until somebody thinks of the list. This holds the two together: every command in the help
 * is either denied here in a form that changes state, or named in `READS_ONLY` with the reason it does not need
 * to be. The next command fails this until a person has decided which.
 */

/** The forms of each covered command that change state, one at least: each must be denied. */
const DENIED_FORMS: Readonly<Record<string, readonly string[]>> = {
  init: ['stroq init', 'stroq init --agent cursor --user'],
  uninstall: ['stroq uninstall', 'stroq uninstall --agent mcp --client cursor'],
  untaint: ['stroq untaint', 'stroq untaint --all'],
  trust: ['stroq trust README.md', 'stroq trust --remove README.md'],
  // Starts the program after the `--`, which is judged as it would be alone.
  run: ['stroq run -- stroq uninstall', 'stroq run --sandbox -- npx @stroq/cli init'],
  mcp: ['stroq mcp --server s -- stroq untaint --all'],
  // Starts every stdio server the project's `.mcp.json` names, which an agent can have written.
  exposure: ['stroq exposure --probe', 'stroq exposure --json --probe'],
  // Plants a file with a first line it chooses, wherever it chooses, and adds a canary to the secret index.
  canary: ['stroq canary', 'stroq canary --file ~/.zprofile --name x'],
};

/** The commands that only read, or write what no caller chooses the place or the lines of, and why. */
const READS_ONLY: Readonly<Record<string, string>> = {
  hook: "the host's entry point: reads one event on its input, prints a decision, and writes the audit entry and the session of that event",
  doctor: 'prints the state of the installation, and runs its self-test in memory',
  log: 'prints audit entries',
  verify: 'checks the hash chain of the audit log',
  why: 'prints why the last action was denied or asked',
  replay: 'rebuilds a recorded session; --out only creates a page where no file exists',
  sent: 'lists by name the credentials a recorded session saw; --out only creates a card where no file exists',
  attack: 'replays recorded attacks against the policy, in memory',
  inspect: 'reads a repository and prints what it would run',
  bench: 'measures the rules on a corpus and prints the result',
  coverage: 'prints the control mapping',
};

const isDenied = (command: string): boolean =>
  classifyTool('Bash', { command }, '/work').classes.includes('config.self');

describe('every command of the CLI is judged by the state gate, or listed as one that only reads', () => {
  const names = commandNames();

  it('walks the commands of the help, and there are some', () => {
    expect(names.length).toBeGreaterThan(15);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [
      'init',
      'uninstall',
      'untaint',
      'trust',
      'run',
      'mcp',
      'canary',
      'exposure',
    ])
      expect(names, name).toContain(name);
  });

  it.each(commandNames())('%s is in exactly one of the two lists', (name) => {
    const covered = Object.hasOwn(DENIED_FORMS, name);
    const reads = Object.hasOwn(READS_ONLY, name);
    expect(
      covered || reads,
      `"${name}" is a command of the CLI that the state gate does not know and READS_ONLY does not ` +
        'name: decide which, and add it to stroq-state.ts or to READS_ONLY with the reason',
    ).toBe(true);
    expect(covered && reads, `"${name}" is in both lists`).toBe(false);
  });

  it('names no command that the help does not list, in either list', () => {
    for (const name of [...Object.keys(DENIED_FORMS), ...Object.keys(READS_ONLY)])
      expect(names, name).toContain(name);
  });

  it.each(Object.entries(DENIED_FORMS).flatMap(([, forms]) => forms.map((form) => [form])))(
    'denies %s',
    (form) => {
      expect(isDenied(form), form).toBe(true);
    },
  );

  it.each(Object.entries(DENIED_FORMS).map(([name]) => [name]))(
    'leaves a request for help for %s open',
    (name) => {
      for (const flag of ['--help', '-h'])
        expect(isDenied(`stroq ${name} ${flag}`), flag).toBe(false);
    },
  );

  it.each(Object.entries(READS_ONLY))('leaves %s open, as it reads: %s', (name) => {
    expect(isDenied(`stroq ${name}`), name).toBe(false);
    expect(isDenied(`stroq ${name} --help`), name).toBe(false);
  });

  it('gives a reason for each command that only reads, in a line', () => {
    for (const [name, reason] of Object.entries(READS_ONLY)) {
      expect(reason.trim(), name).not.toBe('');
      expect(reason, name).not.toContain('\n');
    }
  });

  it('keeps open the forms that must stay open: stroq exposure, stroq exposure --json, stroq canary --help', () => {
    for (const form of ['stroq exposure', 'stroq exposure --json', 'stroq canary --help'])
      expect(isDenied(form), form).toBe(false);
  });
});
