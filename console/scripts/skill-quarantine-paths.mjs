import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sameIdentity = (a, b) => a?.ino === b?.ino && a?.dev === b?.dev;
export const identity = (stat) => ({ ino: stat.ino, dev: stat.dev });
export const checkDeadline = (deadline) => {
  if (Date.now() >= deadline) throw new Error('deadline-exceeded');
};
export async function canonicalRoot(path) {
  const canonical = await realpath(path);
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('quarantine-unavailable');
  return { path: canonical, ...identity(stat) };
}
export async function inspectLocation(root, path, kind = 'directory', privateMode = false) {
  const rel = relative(root.path, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('quarantine-conflict');
  const base = await lstat(root.path);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    !sameIdentity(root, base) ||
    (await realpath(root.path)) !== root.path
  )
    throw new Error('quarantine-conflict');
  let at = root.path;
  const parts = rel.split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]);
    let stat;
    try {
      stat = await lstat(at);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const directory = i < parts.length - 1 || kind === 'directory';
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    )
      throw new Error('quarantine-conflict');
    if (
      i === parts.length - 1 &&
      privateMode &&
      ((directory ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o077) !== 0) ||
        stat.uid !== process.getuid?.())
    )
      throw new Error('quarantine-conflict');
    if (i === parts.length - 1) return stat;
  }
  return base;
}
export async function privateDirectory(root, path) {
  const rel = relative(root.path, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('quarantine-unavailable');
  let at = root.path;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    await inspectLocation(root, at);
    try {
      await mkdir(at, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await inspectLocation(root, at, 'directory', at === path);
  }
}
export async function readPrivateBytes(root, path) {
  const before = await inspectLocation(root, path, 'file', true);
  if (!before || before.size > 16 * 1024) throw new Error('record-invalid');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (
      !sameIdentity(before, stat) ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 16 * 1024 ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error('record-invalid');
    const bytes = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < bytes.length) {
      const read = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!read.bytesRead) break;
      filled += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    if (
      filled !== bytes.length ||
      extra.bytesRead ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.uid !== process.getuid?.() ||
      (after.mode & 0o777) !== 0o600 ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      !sameIdentity(after, await inspectLocation(root, path, 'file', true))
    )
      throw new Error('record-invalid');
    return { bytes, sha256: hash(bytes) };
  } finally {
    await handle?.close();
  }
}
export async function readPrivateJson(root, path) {
  const read = await readPrivateBytes(root, path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
  return { value: JSON.parse(text), sha256: read.sha256 };
}
export async function ensureVaultMarker(root, bucket) {
  await privateDirectory(root, bucket);
  const path = join(bucket, '.gitignore');
  if (await inspectLocation(root, path, 'file', true)) {
    if (!(await readPrivateBytes(root, path)).bytes.equals(Buffer.from('*\n')))
      throw new Error('quarantine-unavailable');
    return;
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile('*\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!(await readPrivateBytes(root, path)).bytes.equals(Buffer.from('*\n')))
    throw new Error('quarantine-unavailable');
}
/**
 * Rewrites only known private metadata, preserving concurrent outside changes.
 * @param {string|null} [expected=null]
 */
export async function writeManifest(root, path, value, expected = null) {
  const directory = await inspectLocation(root, dirname(path), 'directory', true);
  if (!directory) throw new Error('quarantine-unavailable');
  const before = await inspectLocation(root, path, 'file', true);
  if (
    expected === null
      ? before !== null
      : !before || (await readPrivateJson(root, path)).sha256 !== expected
  )
    throw new Error('quarantine-preview-stale');
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > 16 * 1024) throw new Error('quarantine-unavailable');
  const temporary = join(dirname(path), `.manifest-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    if (!sameIdentity(directory, await inspectLocation(root, dirname(path), 'directory', true)))
      throw new Error('quarantine-preview-stale');
    const current = await inspectLocation(root, path, 'file', true);
    if (
      expected === null
        ? current !== null
        : !current || (await readPrivateJson(root, path)).sha256 !== expected
    )
      throw new Error('quarantine-preview-stale');
    await rename(temporary, path);
    return hash(bytes);
  } finally {
    await handle?.close();
    try {
      if (
        sameIdentity(directory, await inspectLocation(root, dirname(path), 'directory', true)) &&
        (await inspectLocation(root, temporary, 'file', true))
      )
        await unlink(temporary);
    } catch {
      /* Never traverse substituted directories to clean up. */
    }
  }
}
/** A shared per-user main-process lock is created only by explicit apply. */
export async function prepareApplyLock(userHome) {
  const root = await canonicalRoot(userHome);
  const directory = join(root.path, '.claude');
  await inspectLocation(root, directory);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await inspectLocation(root, directory);
  const lock = join(directory, '.stroq-quarantine.apply.lock');
  for (const path of [lock, `${lock}.reaper`]) await inspectLocation(root, path);
  return {
    path: lock,
    fs: {
      mkdir,
      rm,
      stat,
      writeFile,
      async readFile(path, encoding) {
        return (await readPrivateBytes(root, path)).bytes.toString(encoding);
      },
    },
  };
}
