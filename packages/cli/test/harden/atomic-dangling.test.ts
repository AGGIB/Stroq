import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { danglingLinkIn } from '../../src/harden/atomic-support.js';
import { assertWriteAllowed, removeFile, writeFileAtomic } from '../../src/harden/atomic.js';
import { HardenError } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/**
 * A link that points nowhere is how a hostile checkout turns "create the file if it is missing"
 * into "create a file where I say". Renaming onto the link would only replace the link, and
 * making its directory would follow it; the engine refuses both, in the same words, before it
 * touches anything, and says which link it is.
 */
describe.skipIf(process.platform === 'win32')('a link that points nowhere', () => {
  it('is refused by assertWriteAllowed, with a typed error', () => {
    const dir = tempDir();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(join(dir, 'project'));
    symlinkSync(join(elsewhere, 'authorized_keys'), join(dir, 'project', 'settings.json'));

    let error: unknown;
    try {
      assertWriteAllowed(join(dir, 'project', 'settings.json'), { root: join(dir, 'project') });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'dangling-link' });
    expect((error as Error).message).toContain(join(dir, 'project', 'settings.json'));
  });

  it('is not written through, and is not replaced by a regular file either', async () => {
    const dir = tempDir();
    const link = join(dir, 'settings.json');
    const aim = join(dir, 'nowhere', 'file.json');
    symlinkSync(aim, link);

    await expect(writeFileAtomic(link, 'x')).rejects.toMatchObject({ code: 'dangling-link' });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, 'nowhere'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('is refused when it is the directory the file would go in, and nothing is made behind it', async () => {
    const dir = tempDir();
    symlinkSync(join(dir, 'nowhere'), join(dir, '.cursor'));

    await expect(writeFileAtomic(join(dir, '.cursor', 'hooks.json'), 'x')).rejects.toMatchObject({
      code: 'dangling-link',
    });

    expect(existsSync(join(dir, 'nowhere'))).toBe(false);
  });

  it('is refused when two links lead into each other', async () => {
    const dir = tempDir();
    symlinkSync(join(dir, 'b'), join(dir, 'a'));
    symlinkSync(join(dir, 'a'), join(dir, 'b'));

    await expect(writeFileAtomic(join(dir, 'a'), 'x')).rejects.toMatchObject({
      code: 'dangling-link',
    });
  });

  it('is refused when it is a loop of links in a directory the file would go in', async () => {
    const dir = tempDir();
    symlinkSync(join(dir, 'b'), join(dir, 'a'));
    symlinkSync(join(dir, 'a'), join(dir, 'b'));

    await expect(writeFileAtomic(join(dir, 'a', 'settings.json'), 'x')).rejects.toMatchObject({
      code: 'dangling-link',
    });
  });

  // A directory that cannot be searched (or, for root, an ordinary one) has no link in it that
  // points nowhere, and not being able to look is not a reason to refuse.
  it('is not judged a link when the path cannot be looked at', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'sealed'));
    chmodSync(join(dir, 'sealed'), 0o000);
    try {
      expect(danglingLinkIn(join(dir, 'sealed', 'settings.json'))).toBeNull();
    } finally {
      chmodSync(join(dir, 'sealed'), 0o700);
    }
  });

  it('is refused for a removal as well', async () => {
    const dir = tempDir();
    const link = join(dir, 'ignore');
    symlinkSync(join(dir, 'nowhere'), link);

    await expect(removeFile(link)).rejects.toMatchObject({ code: 'dangling-link' });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('does not stand in the way of a link that leads somewhere, or of a path that is just not made yet', async () => {
    const dir = tempDir();
    const real = join(dir, 'dotfiles', 'settings.json');
    mkdirSync(join(dir, 'dotfiles'));
    writeFileSync(real, 'old');
    symlinkSync(real, join(dir, 'link.json'));

    await writeFileAtomic(join(dir, 'link.json'), 'new');
    await writeFileAtomic(join(dir, 'not', 'yet', 'made.json'), 'fresh');

    expect(lstatSync(join(dir, 'link.json')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, 'not', 'yet', 'made.json'))).toBe(true);
  });
});
