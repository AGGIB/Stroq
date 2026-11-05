import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandNames, suggestCommand } from '../src/help.js';
import { removedNames, removedNotice } from '../src/removed-commands.js';
import { CLI_ENTRY } from './helpers/cli-entry.js';

/**
 * 0.30 took nine commands out of the CLI. Whoever types one (from an old README, a script, a search
 * result) is told in one line that it is gone and where to go, not "unknown command".
 */

const GONE = ['add', 'remove', 'run', 'task', 'permit', 'harden', 'prove', 'bench', 'coverage'];

const VET =
  "check a skill or MCP server with `stroq vet`, install it with your agent's own command";
const RUN = 'run your agent as usual; `stroq init` guards it';
const DEV = 'developer tools, in the repository: `pnpm dev:bench`, `pnpm dev:coverage`';

/** What each one says, in full: this is the text the owner approved. */
const SAID: Readonly<Record<string, string>> = {
  add: `stroq add was removed in 0.30: ${VET}.`,
  remove: `stroq remove was removed in 0.30: ${VET}.`,
  run: `stroq run was removed in 0.30: ${RUN}.`,
  task: `stroq task was removed in 0.30: ${RUN}.`,
  permit: `stroq permit was removed in 0.30: ${RUN}.`,
  harden:
    "stroq harden was removed in 0.30: `stroq init` guards your agent; your agent's own deny settings can close key files.",
  prove: 'stroq prove was removed in 0.30: `stroq doctor` shows whether the hook is called.',
  bench: `stroq bench was removed in 0.30: ${DEV}.`,
  coverage: `stroq coverage was removed in 0.30: ${DEV}.`,
};

describe('removedNotice', () => {
  it('names exactly the nine commands that were removed', () => {
    expect([...removedNames()].sort()).toEqual([...GONE].sort());
  });

  it.each(GONE)('says in one line that %s is gone, and what to use', (name) => {
    const notice = removedNotice(name);
    expect(notice).toBe(SAID[name]);
    expect(notice).not.toContain('\n');
  });

  it('is null for a command that is still there and for any other word', () => {
    for (const word of [...commandNames(), 'task-hook', 'help', 'nope', '', 'ADD'])
      expect(removedNotice(word), word).toBeNull();
  });

  it('is not fooled by a name that only looks like an own property of the table', () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
      expect(removedNotice(word), word).toBeNull();
  });

  it('keeps no removed command in the table of commands, so that none is suggested for a typo', () => {
    for (const name of GONE) expect(commandNames()).not.toContain(name);
    expect(suggestCommand('prve')).not.toBe('prove');
  });
});

describe('a removed command, run', () => {
  const home = mkdtempSync(join(tmpdir(), 'stroq-removed-'));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, HOME: home, USERPROFILE: home, STROQ_HOME: join(home, '.stroq') },
    });

  it.each(GONE)('%s prints its one line to stderr and exits 2', (name) => {
    const out = run(name);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(`${SAID[name]}\n`);
  });

  it.each(GONE)('%s --help and help %s say the same and run nothing', (name) => {
    for (const args of [
      [name, '--help'],
      ['help', name],
      [name, 'whatever', '--yes'],
    ]) {
      const out = run(...args);
      expect(out.status, args.join(' ')).toBe(2);
      expect(out.stdout, args.join(' ')).toBe('');
      expect(out.stderr, args.join(' ')).toBe(`${SAID[name]}\n`);
    }
  });

  it('leaves task-hook alone: old settings still call it', () => {
    const out = run('task-hook');
    expect(out.stderr).not.toContain('was removed');
  });
});
