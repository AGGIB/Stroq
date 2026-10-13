import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PassportSchema } from '../../src/install/types.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { removeTempRoots, tempRoot } from '../helpers/install-dir.js';
import {
  archive,
  folder,
  HOSTILE_SKILL,
  RAW_UNSAFE,
  skillArchive,
  skillFolder,
} from '../helpers/vet-world.js';

afterEach(removeTempRoots);

/**
 * The CLI as a person runs it: the bundle `pnpm build` writes, in a process of its own, with a home that is
 * a throwaway folder. It is the one place that sees the wiring of the command (the registration, the
 * help, the neutralizing of everything printed) and not only the function.
 */
function stroq(...args: string[]) {
  const home = tempRoot('home');
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home, STROQ_HOME: join(home, '.stroq') },
  });
}

describe('the built CLI: stroq vet, with an archive', () => {
  it('reads a .tgz: exit 0, the same digest as the folder it was made from, no note of the platform', () => {
    const run = stroq('vet', '--from', skillArchive());
    const lines = run.stdout.split('\n');

    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(lines[1]).toBe(
      'stroq-tree/1 sha256:32bb90d578d8f26224c2f87ec67ce6672c92091d108eb655a652feda5076d3f6  4 files, 945 bytes',
    );
  });

  it('exits 3 for an archive that holds a link, in a fixed phrase and without the path', () => {
    const file = archive('with-link.tgz', [
      { name: 'package/SKILL.md', data: '# s\n' },
      { name: 'package/link', typeflag: '2', linkname: '/etc/passwd' },
    ]);

    const run = stroq('vet', '--from', file);

    expect(run.status).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('an archive with a link is not read');
    expect(run.stderr).not.toContain(file);
    expect(RAW_UNSAFE.test(run.stderr)).toBe(false);
  });

  it('takes --expect for an archive and exits 1, with both digests, on a digest that is not its own', () => {
    const run = stroq('vet', '--from', skillArchive(), '--expect', 'a'.repeat(64));

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`expected: sha256:${'a'.repeat(64)}`);
  });
});

describe('the built CLI: stroq vet', () => {
  it('reads a skill folder: exit 0, the kind and the name first, then the digest', () => {
    const run = stroq('vet', '--from', skillFolder());
    const lines = run.stdout.split('\n');

    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(lines[0]).toBe(
      'skill pdf-forms 1.2.0 (name and version declared by the artifact, not checked)',
    );
    expect(lines[1]).toMatch(/^stroq-tree\/1 sha256:[0-9a-f]{64} {2}4 files, 945 bytes( \(.*\))?$/);
    expect(lines.at(-2)).toBe(
      'This is a reading of the files, not a security certificate: an absent line means nothing was seen, not that nothing is there.',
    );
  });

  it('prints the passport for --json, as one object and a newline, with the version of the package', () => {
    const run = stroq('vet', '--from', skillFolder(), '--json');
    const passport = PassportSchema.parse(JSON.parse(run.stdout));

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.endsWith('}\n')).toBe(true);
    expect(passport.analysis.stroq).toMatch(/^\d+\.\d+\.\d+/);
    expect(RAW_UNSAFE.test(run.stdout)).toBe(false);
  });

  it.each([
    ['the screen', [] as string[]],
    ['--json', ['--json']],
    ['--card', ['--card']],
  ])('prints no raw control or direction character in %s, for a hostile skill', (_label, flags) => {
    const run = stroq(
      'vet',
      '--from',
      folder('hostile-skill', { 'SKILL.md': HOSTILE_SKILL }),
      ...flags,
    );

    expect(run.status, run.stderr).toBe(0);
    expect(RAW_UNSAFE.test(run.stdout)).toBe(false);
    expect(RAW_UNSAFE.test(run.stderr)).toBe(false);
  });

  it('exits 2 with no folder, and 2 for an option that is not its own, in the words of every command', () => {
    const none = stroq('vet');
    const unknown = stroq('vet', '--from', skillFolder(), '--bogus');

    expect(none.status).toBe(2);
    expect(none.stderr).toContain('--from <dir or .tgz>');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option --bogus');
  });

  it('exits 3 for a folder that is not there, and prints nothing on stdout', () => {
    const run = stroq('vet', '--from', join(tempRoot('empty'), 'not-there'));

    expect(run.status).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('there is nothing at the path to read');
  });

  it('has a help that names every flag, and is listed among the commands', () => {
    const help = stroq('vet', '--help');
    const list = stroq('--help');

    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^stroq vet --from <dir or \.tgz>/);
    for (const flag of ['--from', '--online', '--kind', '--json', '--expect', '--card', '--out'])
      expect(help.stdout, flag).toContain(flag);
    expect(list.stdout).toMatch(/^ {2}vet --from <dir or \.tgz>/m);
  });
});

describe('the built CLI: stroq install', () => {
  it('says what to run instead, and does not suggest the command that takes Stroq out', () => {
    const run = stroq('install');

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(
      'stroq has no install: `stroq init` guards an agent, `stroq vet --from <dir>` reads a skill or MCP server before you add it.\n',
    );
    expect(run.stderr).not.toContain('uninstall');
  });

  it('says it too when it is given something to install, and when it is asked for help', () => {
    for (const args of [
      ['install', 'some-skill'],
      ['install', '--help'],
      ['help', 'install'],
    ]) {
      const run = stroq(...args);
      expect(run.status, args.join(' ')).toBe(1);
      expect(run.stderr, args.join(' ')).toContain('stroq has no install');
    }
  });
});
