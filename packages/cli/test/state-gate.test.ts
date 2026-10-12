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
  // Starts the program after the `--`, which is judged by the command it names.
  run: ['stroq run -- stroq uninstall', 'stroq run --sandbox -- npx @stroq/cli init'],
  mcp: ['stroq mcp --server s -- stroq untaint --all'],
  // Starts every stdio server the project's `.mcp.json` names, which an agent can have written.
  exposure: ['stroq exposure --probe', 'stroq exposure --json --probe'],
  // Plants a file with a first line it chooses, wherever it chooses, and adds a canary to the secret index.
  canary: ['stroq canary', 'stroq canary --file ~/.zprofile --name x'],
  // Edits an agent's settings or ignore file, and takes the change back. `plan` and `status` only read.
  harden: [
    'stroq harden apply',
    'stroq harden apply --yes',
    'stroq harden --scope user apply',
    'stroq harden undo --agent cursor --yes',
    'stroq harden forget',
  ],
  // Starts the host on the owner's login and spends their requests, and writes the result `doctor` reads.
  prove: ['stroq prove', 'stroq prove --yes --max-requests 6'],
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

/**
 * `stroq harden` is the one command whose reading forms and writing forms are one command line apart,
 * and the writing forms are a person's: an agent that could run `stroq harden undo --yes` could take
 * the protections off again, or `stroq harden apply --yes` could write into a settings file of its
 * choosing. The command itself cannot tell an agent from a person (a shell is a shell), so the gate is
 * what stops it, and these are the forms that matter most.
 */
describe('stroq harden and the state gate', () => {
  it.each([
    'stroq harden',
    'stroq harden plan',
    'stroq harden plan --agent cursor --json',
    'stroq harden --scope project',
    'stroq harden status',
    'stroq harden status --json',
    'stroq harden apply --help',
    'stroq harden undo -h',
  ])('leaves %s open: it only reads', (form) => {
    expect(isDenied(form), form).toBe(false);
  });

  it.each([
    'stroq harden apply --yes --acknowledge-link',
    // A plan that is given the flag prints the file a link leads to: that is the owner's to ask for.
    'stroq harden plan --acknowledge-link',
    'stroq harden --scope project --acknowledge-link',
    'stroq harden --yes apply',
    'stroq harden --agent claude-code --scope user undo --yes',
    'npx @stroq/cli harden apply --yes',
    'npx -y @stroq/cli harden undo --yes',
    'stroq run -- stroq harden apply --yes',
    'FOO=1 stroq harden undo --yes',
    'env stroq harden undo --yes',
    'sh -c "stroq harden apply --yes"',
    'node packages/cli/dist/index.js harden apply --yes',
  ])('denies %s: it writes', (form) => {
    expect(isDenied(form), form).toBe(true);
  });
});
