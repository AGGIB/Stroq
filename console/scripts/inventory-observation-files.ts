import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export type Identity = Pick<Stats, 'dev' | 'ino' | 'uid' | 'mode'>;
export type RootIdentity = Identity & { path: string };
export type FileIdentity = Identity & Pick<Stats, 'nlink' | 'size' | 'mtimeMs' | 'ctimeMs'>;
export type FileSnapshot = {
  bytes: Buffer | null;
  sha256: string;
  mode: number;
  file: FileIdentity | null;
  directories: RootIdentity[];
};
type Inspected = { directories: RootIdentity[] } & (
  { exists: false; file: null } | { exists: true; file: FileIdentity }
);
export type WriteFault = (
  stage: 'before-rename' | 'after-rename',
  details: { temporary: string },
) => Promise<void>;

// Same pinned transaction as configuration writes, with the observation history budget.
export const MAX_CONFIG = 8 * 1024 * 1024;
export const digest = (bytes: Buffer | null) =>
  bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex');
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const owned = (value: Identity) =>
  typeof process.getuid !== 'function' || value.uid === process.getuid();
// Directory timestamps change when our lock, backup or staged files are created.
const identity = (value: Identity) => ({
  dev: value.dev,
  ino: value.ino,
  uid: value.uid,
  mode: value.mode,
});
const fileIdentity = (value: FileIdentity) => ({
  ...identity(value),
  nlink: value.nlink,
  size: value.size,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
});
const renamedIdentity = (value: FileIdentity) => ({
  ...identity(value),
  nlink: value.nlink,
  size: value.size,
  mtimeMs: value.mtimeMs,
});
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** @returns {never} */
function fail(code: string): never {
  throw new Error(code);
}

export async function rootIdentity(path: string): Promise<RootIdentity> {
  const canonical = await realpath(path);
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-config');
  return { path: canonical, ...identity(stat) };
}

/** Capture every existing ancestor without following links below the selected root. */
export async function inspectPath(root: RootIdentity, file: string): Promise<Inspected> {
  const rel = relative(root.path, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('unsafe-config');
  const rootStat = await lstat(root.path);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !equal(identity(rootStat), identity(root)) ||
    (await realpath(root.path)) !== root.path
  )
    fail('unsafe-config');
  const parts = rel.split(sep);
  let at = root.path;
  const directories = [{ path: at, ...identity(rootStat) }];
  for (let i = 0; i < parts.length; i += 1) {
    at = join(at, parts[i]!);
    let stat: Stats;
    try {
      stat = await lstat(at);
    } catch (error: any) {
      if (error.code === 'ENOENT') return { exists: false, directories, file: null };
      fail('unsafe-config');
    }
    if (stat.isSymbolicLink()) fail('unsafe-config');
    if (i === parts.length - 1) {
      if (!stat.isFile() || stat.nlink !== 1) fail('unsafe-config');
      return { exists: true, directories, file: fileIdentity(stat) };
    }
    if (!stat.isDirectory()) fail('unsafe-config');
    directories.push({ path: at, ...identity(stat) });
  }
  fail('unsafe-config');
}

export async function snapshotFile(
  root: RootIdentity,
  file: string,
  maxBytes = MAX_CONFIG,
): Promise<FileSnapshot> {
  const inspected = await inspectPath(root, file);
  if (!inspected.exists) {
    if (!equal(inspected, await inspectPath(root, file))) fail('preview-stale');
    return {
      bytes: null,
      sha256: 'absent',
      mode: 0o600,
      file: null,
      directories: inspected.directories,
    };
  }
  if (inspected.file.size > maxBytes) fail('unsafe-config');
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, flags);
    const before = await handle.stat();
    if (!equal(fileIdentity(before), inspected.file)) fail('preview-stale');
    const bytes = Buffer.alloc(before.size);
    let filled = 0;
    while (filled < bytes.length) {
      const result = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!result.bytesRead) break;
      filled += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (
      filled !== bytes.length ||
      extra.bytesRead ||
      !equal(fileIdentity(await handle.stat()), inspected.file) ||
      !equal(inspected, await inspectPath(root, file))
    )
      fail('preview-stale');
    return {
      bytes,
      sha256: digest(bytes),
      mode: before.mode & 0o777,
      file: inspected.file,
      directories: inspected.directories,
    };
  } catch (error: any) {
    if (['unsafe-config', 'preview-stale'].includes(error.message)) throw error;
    return fail('unsafe-config');
  } finally {
    await handle?.close();
  }
}

function sameAncestors(current: FileSnapshot, before: FileSnapshot) {
  if (
    current.directories.length < before.directories.length ||
    !before.directories.every((directory, index) => equal(directory, current.directories[index]))
  )
    return false;
  const extra = current.directories.slice(before.directories.length);
  // An absent file may gain private parents created by setup or the shared harden lock.
  return (
    extra.length === 0 ||
    (before.file === null &&
      extra.every((directory) => owned(directory) && (directory.mode & 0o777) === 0o700))
  );
}
export async function assertUnchanged(
  root: RootIdentity,
  file: string,
  before: FileSnapshot,
): Promise<FileSnapshot> {
  let current: FileSnapshot;
  try {
    current = await snapshotFile(root, file);
  } catch {
    fail('preview-stale');
  }
  if (
    current.sha256 !== before.sha256 ||
    (Object.hasOwn(before, 'file') &&
      (!equal(current.file, before.file) || !sameAncestors(current, before)))
  )
    fail('preview-stale');
  return current;
}

function writable(captured: FileSnapshot) {
  if (
    captured.directories.some(
      (directory) =>
        !owned(directory) || (directory.mode & 0o022) !== 0 || (directory.mode & 0o300) !== 0o300,
    ) ||
    (captured.file &&
      (!owned(captured.file) ||
        (captured.file.mode & 0o022) !== 0 ||
        (captured.file.mode & 0o200) === 0))
  )
    fail('unsafe-config');
}
async function ensureParent(root: RootIdentity, file: string, before: FileSnapshot) {
  await assertUnchanged(root, file, before);
  let at = root.path;
  for (const part of relative(root.path, dirname(file)).split(sep).filter(Boolean)) {
    at = join(at, part);
    try {
      await mkdir(at, { mode: 0o700 });
    } catch (error: any) {
      if (error.code !== 'EEXIST') fail('write-failed');
    }
    const stat = await lstat(at);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) fail('unsafe-config');
    await assertUnchanged(root, file, before);
  }
}

/** Return the exact published inode/capture; never treat identical foreign bytes as our write. */
export async function atomicWrite(
  root: RootIdentity,
  file: string,
  bytes: Buffer,
  before: FileSnapshot,
  mode: number | undefined,
  { fault = async () => {} }: { fault?: WriteFault } = {},
): Promise<FileSnapshot> {
  await inspectPath(root, file);
  const original = await assertUnchanged(root, file, before);
  writable(original);
  const retainedMode = mode ?? original.mode;
  if (
    !Number.isInteger(retainedMode) ||
    retainedMode < 0 ||
    retainedMode > 0o777 ||
    (retainedMode & 0o022) !== 0 ||
    (retainedMode & 0o200) === 0
  )
    fail('unsafe-config');
  await ensureParent(root, file, original);
  const expected = await assertUnchanged(root, file, original);
  writable(expected);
  const directory = expected.directories.at(-1)!;
  const temporary = join(dirname(file), `.stroq-${randomUUID()}.tmp`);
  let handle: FileHandle | null | undefined, staged: FileIdentity | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    staged = fileIdentity(await handle.stat());
    await handle.writeFile(bytes);
    await handle.chmod(retainedMode);
    await handle.sync();
    staged = fileIdentity(await handle.stat());
    await handle.close();
    handle = null;
    await fault('before-rename', { temporary });
    await assertUnchanged(root, file, expected);
    const prepared = await snapshotFile(root, temporary);
    if (
      !equal(prepared.file, staged) ||
      prepared.sha256 !== digest(bytes) ||
      !equal(prepared.directories, expected.directories) ||
      !equal(identity(await lstat(dirname(file))), identity(directory))
    )
      fail('write-failed');
    await rename(temporary, file);
    await fault('after-rename', { temporary });
    const published = await snapshotFile(root, file);
    // Rename can advance ctime; all other staged identity fields must still match.
    if (
      !published.file ||
      !staged ||
      !equal(renamedIdentity(published.file), renamedIdentity(staged)) ||
      published.sha256 !== digest(bytes) ||
      published.mode !== retainedMode ||
      !equal(published.directories, expected.directories)
    )
      fail('write-failed');
    return published;
  } finally {
    await handle?.close();
    try {
      const remaining = await snapshotFile(root, temporary);
      if (
        staged &&
        equal(remaining.file, staged) &&
        equal(identity(await lstat(dirname(file))), identity(directory))
      )
        await unlink(temporary);
    } catch {
      /* Missing after rename or substituted cleanup path: preserve it. */
    }
  }
}
