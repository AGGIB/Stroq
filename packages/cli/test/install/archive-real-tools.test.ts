import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readArchiveFile } from '../../src/install/archive-file.js';
import { readTarArchive } from '../../src/install/archive-tar.js';
import { readDirTree } from '../../src/install/read-dir.js';
import { treeDigest } from '../../src/install/tree.js';
import { removeTempRoots, tempRoot, writeFiles } from '../helpers/install-dir.js';
import { gzip } from '../helpers/tar-writer.js';

afterEach(removeTempRoots);

/**
 * The archives that real tools write, read by the reader that has to read them: `npm pack` (what the
 * registry serves), `git archive` (what GitHub's codeload serves), and the tar of this machine in each
 * of the formats it can write. Each archive is made of a folder this test controls, and what it must
 * give is the digest of that folder, read by the directory reader, which shares no code with this one.
 * A tool that is not on this machine skips its tests; a tool that fails to write is a failure.
 *
 * Only on platforms with a POSIX shell's tools and an executable bit: the mode of a file is what a
 * digest is made of, and a Windows disk has none to give.
 */
const isWindows = process.platform === 'win32';
const TOOL_TIMEOUT_MS = 60_000;

function runs(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, [...args], { stdio: 'ignore', timeout: TOOL_TIMEOUT_MS });
  return result.status === 0;
}

const hasNpm = !isWindows && runs('npm', ['--version']);
const hasGit = !isWindows && runs('git', ['--version']);
const tarVersion = isWindows
  ? ''
  : (spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
const tarKind = /GNU tar/.test(tarVersion) ? 'gnu' : /bsdtar/.test(tarVersion) ? 'bsd' : null;

/** The environment of a tool: a home of its own, so that nothing of the real one is read or written. */
function toolEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    // macOS tar would add AppleDouble files for extended attributes.
    COPYFILE_DISABLE: '1',
  };
}

function run(command: string, args: readonly string[], cwd: string, home: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    env: toolEnv(home),
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}${result.error ?? ''}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The folder every tool is given
// ---------------------------------------------------------------------------------------------

const SHORT = {
  'package.json': '{\n  "name": "fixture-skill",\n  "version": "1.0.0",\n  "bin": { "run": "bin/run.sh" }\n}\n',
  'README.md': '# fixture\n\nA skill for the tests of the archive reader.\n',
  'index.js': 'module.exports = 1;\n',
  'bin/run.sh': '#!/bin/sh\necho hi\n',
  'docs/guide.md': 'guide\n',
  'docs/über/café.md': 'unicode names are bytes\n',
  'data/empty.txt': '',
};
const DEEP = `${'folder-with-a-longish-name/'.repeat(5)}deep.txt`;
const LONG_BASENAME = `${'n'.repeat(130)}.txt`;

/** A folder of files for a tool to pack, with `bin/run.sh` executable. */
function fixtureFolder(extra: Readonly<Record<string, string>> = {}): string {
  const folder = join(tempRoot('real-tools'), 'fixture');
  mkdirSync(folder);
  writeFiles(folder, { ...SHORT, ...extra });
  chmodSync(join(folder, 'bin', 'run.sh'), 0o755);
  return folder;
}

/** What the archive must give: the digest of the folder it was made from, and its paths. */
async function folderTree(folder: string) {
  return (await readDirTree(folder)).tree;
}

async function expectSameAsFolder(archive: string, folder: string, top?: string): Promise<void> {
  const read = await readArchiveFile(archive);
  const expected = await folderTree(folder);

  expect(read.tree.entries.map((entry) => [entry.path, entry.kind, entry.exec, entry.size])).toEqual(
    expected.entries.map((entry) => [entry.path, entry.kind, entry.exec, entry.size]),
  );
  expect(treeDigest(read.tree)).toBe(treeDigest(expected));
  expect(read.blindSpots).toEqual([]);
  if (top !== undefined) expect(read.topFolder).toBe(top);
}

// ---------------------------------------------------------------------------------------------
// npm pack
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasNpm)('an archive from npm pack', () => {
  it('gives the digest of the folder it was packed from, with the executable bit as npm wrote it', async () => {
    const folder = fixtureFolder();
    const out = tempRoot('npm-out');
    const home = tempRoot('npm-home');

    run('npm', ['pack', '--pack-destination', out, '--silent'], folder, home);

    const archive = join(out, 'fixture-skill-1.0.0.tgz');
    await expectSameAsFolder(archive, folder, 'package');
    const read = await readArchiveFile(archive);
    expect(read.tree.entries.find((entry) => entry.path === 'bin/run.sh')?.exec).toBe(true);
    expect(read.tree.entries.find((entry) => entry.path === 'index.js')?.exec).toBe(false);
  });

  it('is gzip by its bytes, one member, and a plain tar inside', () => {
    const folder = fixtureFolder();
    const out = tempRoot('npm-out');
    run('npm', ['pack', '--pack-destination', out, '--silent'], folder, tempRoot('npm-home'));

    const bytes = new Uint8Array(readFileSync(join(out, 'fixture-skill-1.0.0.tgz')));

    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(readTarArchive(bytes).tree.entries.length).toBe(Object.keys(SHORT).length);
  });
});

// ---------------------------------------------------------------------------------------------
// git archive
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasGit)('an archive from git archive', () => {
  const COMMIT_PREFIX = 'owner-repo-0123abc/';

  /** A repository with the fixture committed, and the work tree that holds the same files. */
  function repository(): { work: string; home: string } {
    const work = fixtureFolder({
      [DEEP]: 'deep\n',
      [LONG_BASENAME]: 'a name too long for the header, which git writes as a pax record\n',
    });
    const home = tempRoot('git-home');
    writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
    run('git', ['init', '--quiet'], work, home);
    run('git', ['add', '--all'], work, home);
    run('git', ['commit', '--quiet', '--message', 'fixture'], work, home);
    return { work, home };
  }

  it.each([
    ['tar.gz', 'archive.tgz'],
    ['tar', 'archive.tar'],
  ])('gives the digest of the work tree for --format=%s, and the folder the commit is wrapped in', async (format, name) => {
    const { work, home } = repository();
    const out = join(tempRoot('git-out'), name);

    run('git', ['archive', `--format=${format}`, `--prefix=${COMMIT_PREFIX}`, `--output=${out}`, 'HEAD'], work, home);

    await expectSameAsFolder(out, work, COMMIT_PREFIX.slice(0, -1));
  });

  it('reads the global header that git writes, which holds the commit, and keeps nothing of it', async () => {
    const { work, home } = repository();
    const out = join(tempRoot('git-out'), 'archive.tar');
    run('git', ['archive', '--format=tar', `--prefix=${COMMIT_PREFIX}`, `--output=${out}`, 'HEAD'], work, home);

    const bytes = new Uint8Array(readFileSync(out));
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));

    expect(text).toMatch(/comment=[0-9a-f]{40}/);
    expect(readTarArchive(bytes).tree.entries.map((entry) => entry.path)).not.toContain('pax_global_header');
  });

  it('reads an archive of a subdirectory, where the prefix is the only wrapper', async () => {
    const { work, home } = repository();
    const out = join(tempRoot('git-out'), 'docs.tgz');

    run('git', ['archive', '--format=tar.gz', `--prefix=${COMMIT_PREFIX}`, `--output=${out}`, 'HEAD:docs'], work, home);

    const read = await readArchiveFile(out);
    expect(read.tree.entries.map((entry) => entry.path)).toEqual(['guide.md', 'über/café.md']);
  });
});

// ---------------------------------------------------------------------------------------------
// tar of this machine
// ---------------------------------------------------------------------------------------------

interface TarFormat {
  readonly id: string;
  readonly flags: readonly string[];
  /** Whether the format can hold a name of more than 100 bytes with no slash to split it at. */
  readonly longNames: boolean;
}

const GNU_FORMATS: readonly TarFormat[] = [
  { id: 'gnu', flags: ['--format=gnu'], longNames: true },
  { id: 'oldgnu', flags: ['--format=oldgnu'], longNames: true },
  { id: 'pax', flags: ['--format=pax'], longNames: true },
  { id: 'ustar', flags: ['--format=ustar'], longNames: false },
  { id: 'v7', flags: ['--format=v7'], longNames: false },
];
const BSD_FORMATS: readonly TarFormat[] = [
  { id: 'pax', flags: ['--format', 'pax'], longNames: true },
  { id: 'ustar', flags: ['--format', 'ustar'], longNames: false },
  { id: 'gnutar', flags: ['--format', 'gnutar'], longNames: true },
  { id: 'v7tar', flags: ['--format', 'v7tar'], longNames: false },
];
const FORMATS = tarKind === 'gnu' ? GNU_FORMATS : tarKind === 'bsd' ? BSD_FORMATS : [];

/** v7 has no prefix, so only names that fit its 100 bytes can be put in one. */
const hasDeepNames = (format: TarFormat): boolean => format.id !== 'v7' && format.id !== 'v7tar';

describe.skipIf(tarKind === null)('an archive from the tar of this machine', () => {
  it.each(FORMATS.map((format) => [format.id, format] as const))(
    'gives the digest of the folder it was made from, in the %s format',
    async (_id, format) => {
      const folder = fixtureFolder({
        ...(hasDeepNames(format) ? { [DEEP]: 'deep\n' } : {}),
        ...(format.longNames ? { [LONG_BASENAME]: 'a long name\n' } : {}),
      });
      const out = join(tempRoot('tar-out'), 'archive.tar');

      run('tar', ['-c', ...format.flags, '-f', out, '-C', join(folder, '..'), 'fixture'], folder, tempRoot('tar-home'));

      await expectSameAsFolder(out, folder, 'fixture');
    },
  );

  it('reads the same archive gzipped by tar itself, and by this test', async () => {
    const folder = fixtureFolder();
    const out = tempRoot('tar-out');
    const home = tempRoot('tar-home');

    run('tar', ['-czf', join(out, 'by-tar.tgz'), '-C', join(folder, '..'), 'fixture'], folder, home);
    run('tar', ['-cf', join(out, 'plain.tar'), '-C', join(folder, '..'), 'fixture'], folder, home);
    writeFileSync(join(out, 'by-test.tgz'), gzip(new Uint8Array(readFileSync(join(out, 'plain.tar')))));

    await expectSameAsFolder(join(out, 'by-tar.tgz'), folder, 'fixture');
    await expectSameAsFolder(join(out, 'by-test.tgz'), folder, 'fixture');
  });

  it('refuses an archive of this machine\'s tar that holds a link, though the files in it are fine', async () => {
    const folder = fixtureFolder();
    spawnSync('ln', ['-s', 'README.md', join(folder, 'link-to-readme')]);
    const out = join(tempRoot('tar-out'), 'with-link.tar');

    run('tar', ['-cf', out, '-C', join(folder, '..'), 'fixture'], folder, tempRoot('tar-home'));

    await expect(readArchiveFile(out)).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/an archive with a link is not read/),
    });
  });

  it('refuses an archive made with the folder\'s own name as dot, which tar writes as ./ for every path', async () => {
    const folder = fixtureFolder();
    const out = join(tempRoot('tar-out'), 'dot.tar');

    run('tar', ['-cf', out, '-C', folder, '.'], folder, tempRoot('tar-home'));

    await expect(readArchiveFile(out)).rejects.toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/'\.' or '\.\.' component/),
    });
  });
});
