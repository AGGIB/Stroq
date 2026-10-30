import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export const MAX_CONFIG = 1024 * 1024;
export const digest = (bytes) =>
  bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex');
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const owned = (value) => typeof process.getuid !== 'function' || value.uid === process.getuid();
// Directory timestamps change when our lock, backup or staged files are created.
const identity = (value) => ({ dev: value.dev, ino: value.ino, uid: value.uid, mode: value.mode });
const fileIdentity = (value) => ({
  ...identity(value),
  nlink: value.nlink,
  size: value.size,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
});
const renamedIdentity = (value) => ({
  ...identity(value),
  nlink: value.nlink,
  size: value.size,
  mtimeMs: value.mtimeMs,
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** @returns {never} */
const fail = (code) => {
  throw new Error(code);
};

export async function rootIdentity(path) {
  const canonical = await realpath(path);
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-config');
  return { path: canonical, ...identity(stat) };
}

/** Capture every existing ancestor without following links below the selected root. */
export async function inspectPath(root, file) {
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
    at = join(at, parts[i]);
    let stat;
    try {
      stat = await lstat(at);
    } catch (error) {
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

export async function snapshotFile(root, file, maxBytes = MAX_CONFIG) {
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
  let handle;
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
  } catch (error) {
    if (['unsafe-config', 'preview-stale'].includes(error.message)) throw error;
    fail('unsafe-config');
  } finally {
    await handle?.close();
  }
}

function sameAncestors(current, before) {
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
export async function assertUnchanged(root, file, before) {
  let current;
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

function writable(captured) {
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
async function ensureParent(root, file, before) {
  await assertUnchanged(root, file, before);
  let at = root.path;
  for (const part of relative(root.path, dirname(file)).split(sep).filter(Boolean)) {
    at = join(at, part);
    try {
      await mkdir(at, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') fail('write-failed');
    }
    const stat = await lstat(at);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) fail('unsafe-config');
    await assertUnchanged(root, file, before);
  }
}

/** Return the exact published inode/capture; never treat identical foreign bytes as our write. */
export async function atomicWrite(
  root,
  file,
  bytes,
  before,
  mode,
  {
    fault = /** @type {(stage: string, details: {temporary: string}) => Promise<void>} */ (
      async () => {}
    ),
  } = {},
) {
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
  const directory = expected.directories.at(-1);
  const temporary = join(dirname(file), `.stroq-${randomUUID()}.tmp`);
  let handle, staged;
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

/** Restore only the exact inode returned by our writer, including its unchanged permissions. */
async function rollback(change, after) {
  if (!after?.file) fail('rollback-incomplete');
  await assertUnchanged(change.root, change.file, after);
  if (change.before.bytes === null) {
    await unlink(change.file);
    if ((await snapshotFile(change.root, change.file)).file !== null) fail('rollback-incomplete');
  } else
    await atomicWrite(change.root, change.file, change.before.bytes, after, change.before.mode);
}

/** Backups finish first; return final captures for exact service postchecks. */
export async function commitSetup(plan, write = atomicWrite) {
  const changes = [plan.config, plan.record];
  const initial = await Promise.all(
    changes.map((change) => assertUnchanged(change.root, change.file, change.before)),
  );
  if (changes.every((change) => digest(change.next) === change.before.sha256))
    return { config: initial[0], record: initial[1] };
  initial.forEach(writable);
  const backupDir = join(plan.userRoot.path, '.stroq', 'backups', 'console-setup');
  const manifest = Buffer.from(
    `${JSON.stringify({ version: 1, agent: plan.agent, scope: plan.scope, configExisted: plan.config.before.bytes !== null, recordExisted: plan.record.before.bytes !== null, configSha256: plan.config.before.sha256, configuredSha256: digest(plan.config.next) }, null, 2)}\n`,
  );
  const backups = [];
  for (const [suffix, bytes] of [
    ['config', plan.config.before.bytes],
    ['record', plan.record.before.bytes],
    ['manifest', manifest],
  ]) {
    if (bytes === null) continue;
    const file = join(backupDir, `${plan.id}.${suffix}.json`);
    const absent = await snapshotFile(plan.userRoot, file);
    if (absent.file !== null) fail('write-failed');
    const after = await write(plan.userRoot, file, bytes, absent, 0o600);
    if (!after?.file || after.sha256 !== digest(bytes)) fail('write-failed');
    backups.push({ file, after });
  }
  for (const backup of backups) await assertUnchanged(plan.userRoot, backup.file, backup.after);
  for (const change of changes) await assertUnchanged(change.root, change.file, change.before);
  const written = [];
  const captures = [];
  let attempted = null;
  try {
    for (const change of changes) {
      if (digest(change.next) === change.before.sha256) {
        captures.push(await assertUnchanged(change.root, change.file, change.before));
        continue;
      }
      attempted = change;
      const after = await write(
        change.root,
        change.file,
        change.next,
        change.before,
        change.before.mode,
      );
      if (!after?.file || after.sha256 !== digest(change.next)) fail('write-failed');
      written.push({ change, after });
      captures.push(after);
      attempted = null;
    }
    for (let index = 0; index < changes.length; index += 1)
      await assertUnchanged(changes[index].root, changes[index].file, captures[index]);
    return { config: captures[0], record: captures[1] };
  } catch (error) {
    let incomplete = false;
    if (attempted) {
      try {
        await assertUnchanged(attempted.root, attempted.file, attempted.before);
      } catch {
        incomplete = true;
      }
    }
    for (const { change, after } of [...written].reverse()) {
      try {
        await rollback(change, after);
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) fail('rollback-incomplete');
    throw error;
  }
}
