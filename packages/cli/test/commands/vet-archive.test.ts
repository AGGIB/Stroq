import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PassportSchema, type Passport } from '../../src/install/types.js';
import { removeTempRoots, tempRoot } from '../helpers/install-dir.js';
import { gzip, tarOf, type TarEntry } from '../helpers/tar-writer.js';
import {
  archive,
  entriesIn,
  folder,
  RAW_UNSAFE,
  skillArchive,
  skillFolder,
  vet,
} from '../helpers/vet-world.js';

afterEach(removeTempRoots);

const SKILL_DIGEST = '32bb90d578d8f26224c2f87ec67ce6672c92091d108eb655a652feda5076d3f6';
const OTHER_DIGEST = 'f'.repeat(64);
const onWindows = process.platform === 'win32';

async function passportOf(file: string, ...flags: string[]): Promise<Passport> {
  const run = await vet(['--from', file, '--json', ...flags]);
  expect(run.code, run.stderr).toBe(0);
  return PassportSchema.parse(JSON.parse(run.stdout));
}

describe('stroq vet --from <archive>', () => {
  it('reads a .tgz as it reads a folder, with the same digest for the same files', async () => {
    const run = await vet(['--from', skillArchive()]);
    const lines = run.stdout.split('\n');

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(lines[0]).toBe(
      'skill pdf-forms 1.2.0 (name and version declared by the artifact, not checked)',
    );
    // No note of the platform: an archive carries its own modes, whatever machine reads it.
    expect(lines[1]).toBe(`stroq-tree/1 sha256:${SKILL_DIGEST}  4 files, 945 bytes`);
  });

  it.skipIf(onWindows)('prints the same screen as the folder the archive was made from', async () => {
    const fromFolder = await vet(['--from', skillFolder()]);
    const fromArchive = await vet(['--from', skillArchive()]);

    expect(fromArchive.stdout).toBe(fromFolder.stdout);
  });

  it('reads a plain .tar, and a gzip that is not called .tgz, by the bytes', async () => {
    const entries = entriesIn('package', { 'SKILL.md': '---\nname: s\nversion: 2.0.0\n---\n# s\n' });
    const plain = await vet(['--from', archive('skill.tar', entries, false)]);
    const odd = await vet(['--from', archive('skill.bin', entries)]);

    expect(plain.code, plain.stderr).toBe(0);
    expect(odd.code, odd.stderr).toBe(0);
    expect(plain.stdout).toBe(odd.stdout);
  });

  it('records the source as a tarball with the base name of the file, and no path', async () => {
    const file = skillArchive('pdf-forms-1.2.0.tgz');
    const passport = await passportOf(file);

    expect(passport.artifact.source).toEqual({ type: 'tarball', label: 'pdf-forms-1.2.0.tgz' });
    expect(JSON.stringify(passport)).not.toContain(dirname(file));
  });

  it('names an artifact that does not name itself after the archive', async () => {
    const file = archive('plain-notes.tgz', entriesIn('package', { 'SKILL.md': '---\ndescription: notes\n---\n# n\n' }));

    const first = (await vet(['--from', file])).stdout.split('\n')[0];

    expect(first).toBe('skill plain-notes.tgz (named after the archive)');
  });

  it('takes --kind for an archive as for a folder', async () => {
    const file = archive('notes.tgz', entriesIn('package', { 'README.md': '# only prose\n' }));

    const asked = await vet(['--from', file, '--kind', 'skill']);
    const unasked = await vet(['--from', file]);

    expect(asked.code, asked.stderr).toBe(0);
    expect(unasked.code).toBe(3);
    expect(unasked.stderr).toContain('--kind skill, --kind mcp or --kind plugin');
  });

  it('works without a wrapping folder, and with several folders at the top', async () => {
    const bare = archive('bare.tgz', [{ name: 'SKILL.md', data: '---\nname: bare\n---\n# b\n' }]);
    const two = archive('two.tgz', [
      { name: 'SKILL.md', data: '---\nname: two\n---\n# t\n' },
      { name: 'scripts/run.sh', data: 'echo hi\n' },
    ]);

    expect((await vet(['--from', bare])).code).toBe(0);
    expect((await passportOf(two)).artifact.files).toBe(2);
  });
});

describe('the executable bit of an archive', () => {
  it.skipIf(onWindows)('is the digest of the folder that has the same bit', async () => {
    const dir = skillFolder();
    chmodSync(join(dir, 'scripts', 'fill.py'), 0o755);

    const fromFolder = await passportOf(dir);
    const fromArchive = await passportOf(skillArchive('exec.tgz', { 'scripts/fill.py': 0o755 }));

    expect(fromArchive.artifact.digest).toBe(fromFolder.artifact.digest);
    expect(fromArchive.artifact.digest).not.toBe(SKILL_DIGEST);
  });

  it('is part of the digest on every platform, as the archive says it', async () => {
    const plain = await passportOf(skillArchive('plain.tgz'));
    const exec = await passportOf(skillArchive('exec.tgz', { 'scripts/fill.py': 0o755 }));

    expect(plain.artifact.digest).toBe(SKILL_DIGEST);
    expect(exec.artifact.digest).not.toBe(SKILL_DIGEST);
  });
});

describe('stroq vet --expect, with an archive', () => {
  it('exits 0 and says so on the digest line when the digest is the one expected', async () => {
    const run = await vet(['--from', skillArchive(), '--expect', SKILL_DIGEST]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.split('\n')[1]).toBe(
      `stroq-tree/1 sha256:${SKILL_DIGEST}  4 files, 945 bytes (matches --expect)`,
    );
  });

  it('exits 1 with both digests when it is not the one expected', async () => {
    const run = await vet(['--from', skillArchive(), '--expect', `sha256:${OTHER_DIGEST}`]);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`expected: sha256:${OTHER_DIGEST}`);
    expect(run.stderr).toContain(`found:    sha256:${SKILL_DIGEST}`);
  });

  it('works on Windows too, because the archive carries the modes the digest is made of', async () => {
    const run = await vet(['--from', skillArchive(), '--expect', SKILL_DIGEST], { platform: 'win32' });

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.split('\n')[1]).not.toContain('platform-dependent');
  });
});

describe('stroq vet --expect, with a folder, on Windows', () => {
  it('exits 2 for a folder, before it reads it, and says why', async () => {
    const run = await vet(['--from', skillFolder(), '--expect', SKILL_DIGEST], { platform: 'win32' });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Windows');
    expect(run.stderr).toContain('executable bit');
    expect(run.stderr).toContain('an archive');
  });

  it('is told as a usage fault, with the way to the help', async () => {
    const run = await vet(['--from', skillFolder(), '--expect', SKILL_DIGEST], { platform: 'win32' });

    expect(run.stderr).toMatch(/^stroq vet: --expect is not available on Windows for a folder/);
    expect(run.stderr).toContain('Run "stroq vet --help" to see its options.');
  });

  it('says there is nothing there for a path that is not there, which is what is wrong with it', async () => {
    const missing = join(tempRoot('empty'), 'not-there');

    const run = await vet(['--from', missing, '--expect', SKILL_DIGEST], { platform: 'win32' });

    expect(run.code).toBe(3);
    expect(run.stderr).toContain('there is nothing at the path to read');
  });
});

describe('an archive that is refused', () => {
  const GOOD: TarEntry = { name: 'package/SKILL.md', data: '---\nname: s\n---\n# s\n' };

  it.each([
    ['holds a link', [GOOD, { name: 'package/link', typeflag: '2', linkname: '/etc/passwd' }], /an archive with a link is not read/],
    ['holds a path that climbs out', [GOOD, { name: 'package/../escape.txt', data: 'x' }], /path refused: '\.' or '\.\.' component/],
    ['holds an absolute path', [{ name: '/etc/cron.d/x', data: 'x' }, { name: 'SKILL.md', data: 's' }], /absolute path/],
    ['holds .git', [GOOD, { name: 'package/.git/config', data: 'x' }], /\.git/],
    ['holds a path twice', [GOOD, GOOD], /appears twice|twice/],
    ['holds README and readme', [GOOD, { name: 'package/README', data: '1' }, { name: 'package/readme', data: '2' }], /one name on a filesystem/],
    ['holds nothing but folders', [{ name: 'package/', typeflag: '5' }], /no files/],
  ])('exits 3 for an archive that %s, with a fixed phrase', async (_label, entries, phrase) => {
    const file = archive('refused.tgz', entries);

    const run = await vet(['--from', file]);

    expect(run.code).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^stroq vet: /);
    expect(run.stderr).toMatch(phrase);
    expect(run.stderr).not.toContain(dirname(file));
    expect(run.stderr).not.toContain('/etc/passwd');
  });

  it('exits 3 for a zip file, whatever it is called', async () => {
    const root = tempRoot('vet');
    const zip = join(root, 'skill.tgz');
    writeFileSync(zip, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0, 1, 2, 3]));

    const run = await vet(['--from', zip]);

    expect(run.code).toBe(3);
    expect(run.stderr).toMatch(/a zip file is not read/);
  });

  it('exits 3 for a file that is not an archive, and for one that is cut short', async () => {
    const root = tempRoot('vet');
    const notes = join(root, 'notes.tgz');
    const cut = join(root, 'cut.tgz');
    writeFileSync(notes, 'just some notes\n'.repeat(80));
    const whole = gzip(tarOf([GOOD]));
    writeFileSync(cut, whole.subarray(0, whole.length - 9));

    expect((await vet(['--from', notes])).stderr).toMatch(/not a tar archive/);
    const cutRun = await vet(['--from', cut]);
    expect(cutRun.code).toBe(3);
    expect(cutRun.stderr).toMatch(/gzip data is (damaged or )?cut short|damaged/);
  });

  it('exits 3 for a gzip bomb, over the limit, without holding what it expands to', async () => {
    const root = tempRoot('vet');
    const bomb = join(root, 'bomb.tgz');
    writeFileSync(bomb, gzip(new Uint8Array(64 * 1024 * 1024)));

    const run = await vet(['--from', bomb]);

    expect(run.code).toBe(3);
    expect(run.stderr).toMatch(/expands to more than 33554432 bytes/);
  });

  it('exits 3 for a path that is nothing, and prints no path', async () => {
    const root = tempRoot('vet');

    const run = await vet(['--from', join(root, 'not-there.tgz')]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain('there is nothing at the path to read');
    expect(run.stderr).not.toContain(root);
  });

  it('writes a name out when it says it, and prints no raw control character', async () => {
    const file = archive('hostile.tgz', [
      GOOD,
      { name: 'package/a\u001b[2Jb‮txt.sh', data: 'x', via: 'pax' },
    ]);

    const run = await vet(['--from', file]);

    expect(run.code).toBe(3);
    expect(RAW_UNSAFE.test(run.stderr)).toBe(false);
  });

  it('puts nothing on a disk: the folder holds the archive and nothing else afterwards', async () => {
    const file = skillArchive();
    const before = readdirSync(dirname(file));

    await vet(['--from', file]);
    await vet(['--from', file, '--json']);

    expect(readdirSync(dirname(file))).toEqual(before);
  });
});

describe('the other forms of output, for an archive', () => {
  it('prints the card with the command that reproduces the digest from an archive', async () => {
    const run = await vet(['--from', skillArchive(), '--card']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Reproduce: \`stroq vet --from <archive> --expect sha256:${SKILL_DIGEST}\``);
    expect(run.stdout).not.toContain('platform-dependent');
  });

  it('writes --out to a file that does not exist yet, as it does for a folder', async () => {
    const out = join(tempRoot('out'), 'passport.json');

    const first = await vet(['--from', skillArchive(), '--json', '--out', out]);
    const second = await vet(['--from', skillArchive(), '--json', '--out', out]);

    expect(first.code, first.stderr).toBe(0);
    expect(second.code).toBe(2);
  });

  it('reads the same hostile skill from an archive as from a folder, and prints nothing raw', async () => {
    const files = { 'SKILL.md': '---\nname: "evil\\e[31m\\u202ename"\n---\n# s\n' };
    const fromFolder = await vet(['--from', folder('hostile-skill', files)]);
    const fromArchive = await vet(['--from', archive('hostile.tgz', entriesIn('package', files))]);

    expect(RAW_UNSAFE.test(fromArchive.stdout)).toBe(false);
    expect(fromArchive.stdout.split('\n')[0]).toBe(fromFolder.stdout.split('\n')[0]);
  });

  it('is the same passport for the same archive on any day, so that an author can commit it', async () => {
    const one = await vet(['--from', skillArchive('a.tgz'), '--json']);
    const two = await vet(['--from', skillArchive('a.tgz'), '--json']);

    expect(one.stdout).toBe(two.stdout);
    expect(one.stdout.length).toBeGreaterThan(100);
  });
});
