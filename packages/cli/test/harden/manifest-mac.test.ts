import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableStringify } from '@stroq/core';
import { backupPath } from '../../src/harden/backup.js';
import { readManifest, readManifestSnapshot } from '../../src/harden/manifest.js';
import { signedManifestText } from '../../src/harden/manifest-seal.js';
import { readStateMacKeySync } from '../../src/state-mac.js';
import { addDeny, applied, engine, jsonText, sha256, undo, type Engine } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';
import { thrownBy } from './manifest-fixtures.js';

/**
 * The manifest tells `stroq harden undo` what to restore and where. It is signed under the home's state
 * key, so a process that can write `<home>/harden` or `<home>/backups` but does not hold the key cannot
 * steer an undo. Every home and project here is a fresh temporary folder.
 */

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';
const BEFORE = jsonText({ model: 'm' });
const PLANTED = jsonText({ planted: 'by someone else' });

const manifestFileOf = (e: Engine): string => join(e.home, 'harden', 'manifest.json');
const keyFileOf = (e: Engine): string => join(e.home, 'keys', 'state-mac.key');

/** What a writer to `backups/` and `harden/` would make undo put back: bytes of its own. */
function forgedFiles(e: Engine, real: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(manifestFileOf(e), 'utf8'));
  const id = '20261027T000000000Z-feed00';
  const copy = backupPath(e.home, id, real);
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, PLANTED);
  const [first] = doc.files[real];
  return { [real]: [{ ...first, shaBefore: sha256(PLANTED), backup: id }] };
}

/** The file, the manifest and the key as they are, to show that a refused undo wrote nothing. */
const snapshotOf = (e: Engine, path: string) => ({
  file: readFileSync(path, 'utf8'),
  manifest: readFileSync(manifestFileOf(e), 'utf8'),
});

describe('the signed harden manifest', () => {
  // The prepared (console) read wants a 0600 manifest, which Windows modes cannot say; `harden apply`
  // and `undo` themselves run there and are tested in their own files.
  it.skipIf(process.platform === 'win32')(
    'signs the manifest under a private home key, and reads and undoes its own record',
    async () => {
      const e = engine();
      const { real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
      const doc = JSON.parse(readFileSync(manifestFileOf(e), 'utf8'));
      expect(doc.version).toBe(2);
      expect(doc.mac).toMatch(/^[a-f0-9]{64}$/);
      if (!onWindows) {
        expect(statSync(keyFileOf(e)).mode & 0o777).toBe(0o600);
        expect(statSync(join(e.home, 'keys')).mode & 0o777).toBe(0o700);
      }
      const manifest = readManifest(e.env);
      expect(manifest.version).toBe(2);
      expect(manifest).not.toHaveProperty('mac');
      expect(manifest.files[real]).toHaveLength(1);
      expect(readManifestSnapshot(e.env).manifest).toEqual(manifest);
      expect((await undo(e, real)).status).toBe('restored');
      expect(readFileSync(path, 'utf8')).toBe(BEFORE);
    },
  );

  it('refuses a manifest rewritten with a plain digest where the signature goes, and writes nothing', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    const files = forgedFiles(e, real);
    const digest = createHash('sha256')
      .update(stableStringify({ version: 2, files }))
      .digest('hex');
    writeFileSync(
      manifestFileOf(e),
      `${JSON.stringify({ version: 2, files, mac: digest }, null, 2)}\n`,
    );
    const before = snapshotOf(e, path);
    expect(thrownBy(() => readManifest(e.env))).toMatchObject({ code: 'manifest-unverified' });
    await expect(undo(e, real)).rejects.toMatchObject({ code: 'manifest-unverified' });
    expect(snapshotOf(e, path)).toEqual(before);
    expect(readFileSync(path, 'utf8')).not.toContain('planted');
  });

  it('refuses a manifest signed with a key of its own', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    writeFileSync(manifestFileOf(e), signedManifestText(forgedFiles(e, real), randomBytes(32)));
    const before = snapshotOf(e, path);
    await expect(undo(e, real)).rejects.toMatchObject({ code: 'manifest-unverified' });
    expect(snapshotOf(e, path)).toEqual(before);
  });

  it('reads the same content when the home key signed it, so the check is the key and not the shape', async () => {
    const e = engine();
    const { real } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    const files = forgedFiles(e, real);
    writeFileSync(manifestFileOf(e), signedManifestText(files, readStateMacKeySync(e.home)!));
    expect(readManifest(e.env).files).toEqual(files);
  });

  it('checks what the manifest says, not how it is laid out', async () => {
    const e = engine();
    const { real } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    const text = readFileSync(manifestFileOf(e), 'utf8');
    writeFileSync(manifestFileOf(e), `${JSON.stringify(JSON.parse(text))}\n\n`);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });

  it('refuses a signed manifest when the key is missing, and makes no new key over it', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    const key = readFileSync(keyFileOf(e));
    rmSync(keyFileOf(e));
    const before = snapshotOf(e, path);
    expect(thrownBy(() => readManifest(e.env))).toMatchObject({
      code: 'manifest-unverified',
      message: expect.stringMatching(/state-mac\.key\) is missing/),
    });
    await expect(undo(e, real)).rejects.toMatchObject({ code: 'manifest-unverified' });
    await expect(applied(e, 'other.json', BEFORE, [addDeny('b')])).rejects.toMatchObject({
      code: 'manifest-unverified',
    });
    expect(existsSync(keyFileOf(e))).toBe(false);
    expect(snapshotOf(e, path)).toEqual(before);
    writeFileSync(keyFileOf(e), key, { mode: 0o600 });
    expect((await undo(e, real)).status).toBe('restored');
  });

  it.skipIf(onWindows)('refuses a manifest when the key is readable by others', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    chmodSync(keyFileOf(e), 0o644);
    const before = snapshotOf(e, path);
    expect(thrownBy(() => readManifest(e.env))).toMatchObject({
      code: 'manifest-unverified',
      message: expect.stringMatching(/is not a private file/),
    });
    await expect(undo(e, real)).rejects.toMatchObject({ code: 'manifest-unverified' });
    expect(snapshotOf(e, path)).toEqual(before);
    chmodSync(keyFileOf(e), 0o600);
    expect((await undo(e, real)).status).toBe('restored');
  });

  it('refuses a version 1 manifest from before signing, says what to do, and works again once it is moved aside', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    const { mac: _mac, ...signed } = JSON.parse(readFileSync(manifestFileOf(e), 'utf8'));
    writeFileSync(manifestFileOf(e), `${JSON.stringify({ ...signed, version: 1 }, null, 2)}\n`);
    const before = snapshotOf(e, path);
    expect(thrownBy(() => readManifest(e.env))).toMatchObject({
      code: 'manifest-unsigned',
      message: expect.stringContaining('stroq harden apply'),
    });
    await expect(undo(e, real)).rejects.toMatchObject({ code: 'manifest-unsigned' });
    await expect(applied(e, 'other.json', BEFORE, [addDeny('b')])).rejects.toMatchObject({
      code: 'manifest-unsigned',
    });
    expect(snapshotOf(e, path)).toEqual(before);
    renameSync(manifestFileOf(e), `${manifestFileOf(e)}.v1`);
    const { real: other } = await applied(e, 'other.json', BEFORE, [addDeny('b')]);
    expect(Object.keys(readManifest(e.env).files)).toEqual([other]);
  });
});

describe('undo and the copy it puts back', () => {
  it('refuses, and writes nothing, when the copy is not the bytes the manifest recorded', async () => {
    const e = engine();
    const { result, real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    writeFileSync(backupPath(e.home, result.backup?.id ?? '', real), PLANTED);
    const before = snapshotOf(e, path);
    await expect(undo(e, real)).rejects.toMatchObject({
      code: 'backup-mismatch',
      message: expect.stringContaining(real),
    });
    expect(snapshotOf(e, path)).toEqual(before);
  });

  it('still takes the entries out when the copy is gone', async () => {
    const e = engine();
    const { result, real, path } = await applied(e, 'settings.json', BEFORE, [addDeny('a')]);
    rmSync(backupPath(e.home, result.backup?.id ?? '', real));
    expect((await undo(e, real)).status).toBe('surgical');
    expect(readFileSync(path, 'utf8')).toBe(BEFORE);
  });
});
