import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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

export const MAX_CONFIG = 256 * 1024;
export const MAX_STORE = 17 * 1024 * 1024;
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const same = (a, b) => a?.ino === b?.ino && a?.dev === b?.dev;
export const identity = (s) => ({ ino: s.ino, dev: s.dev });
export const binding = (root) => hash(`${root.path}\0${root.dev}\0${root.ino}`);
export const deadline = (until) => {
  if (Date.now() >= until) throw new Error('deadline-exceeded');
};
const owned = (s) => typeof process.getuid !== 'function' || s.uid === process.getuid();
export async function canonicalRoot(path) {
  const canonical = await realpath(path);
  const s = await lstat(canonical);
  if (!s.isDirectory() || s.isSymbolicLink() || !owned(s))
    throw new Error('mcp-containment-unavailable');
  return { path: canonical, ...identity(s) };
}
/** Fixed server-selected roots, no linked components, no hardlinked regular files. */
export async function inspect(root, path, kind = 'directory', privateMode = false) {
  const rel = relative(root.path, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('mcp-containment-conflict');
  const base = await lstat(root.path);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    !same(root, base) ||
    (await realpath(root.path)) !== root.path
  )
    throw new Error('mcp-containment-conflict');
  let at = root.path,
    s = base;
  const parts = rel.split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    at = join(at, parts[index]);
    try {
      s = await lstat(at);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const dir = index < parts.length - 1 || kind === 'directory';
    if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile() || s.nlink !== 1))
      throw new Error('mcp-containment-conflict');
    if (
      index === parts.length - 1 &&
      privateMode &&
      (!owned(s) || (dir ? (s.mode & 0o777) !== 0o700 : (s.mode & 0o777) !== 0o600))
    )
      throw new Error('mcp-containment-conflict');
  }
  return s;
}
export async function privateDirectory(root, path) {
  const rel = relative(root.path, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('mcp-containment-unavailable');
  let at = root.path;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    await inspect(root, at);
    try {
      await mkdir(at, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const s = await inspect(root, at, 'directory', at === path);
    if (!s || !owned(s) || (s.mode & 0o022) !== 0) throw new Error('mcp-containment-unavailable');
  }
}
export async function readPrivate(root, path, maxBytes = MAX_CONFIG) {
  const before = await inspect(root, path, 'file', true);
  if (!before) return null;
  if (before.size > maxBytes) throw new Error('record-invalid');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = await handle.stat();
    if (
      !same(s, before) ||
      !s.isFile() ||
      s.nlink !== 1 ||
      !owned(s) ||
      (s.mode & 0o777) !== 0o600 ||
      s.size > maxBytes
    )
      throw new Error('record-invalid');
    const bytes = Buffer.alloc(s.size);
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
      s.size !== after.size ||
      s.mtimeMs !== after.mtimeMs ||
      s.ctimeMs !== after.ctimeMs ||
      !same(after, await inspect(root, path, 'file', true))
    )
      throw new Error('record-invalid');
    return { bytes, sha256: hash(bytes) };
  } finally {
    await handle?.close();
  }
}
export async function writeExclusive(root, path, bytes) {
  const parent = await inspect(root, dirname(path), 'directory', true);
  if (!parent || (await inspect(root, path, 'file', true)))
    throw new Error('mcp-containment-conflict');
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (
    !same(parent, await inspect(root, dirname(path), 'directory', true)) ||
    !(await readPrivate(root, path, Math.max(MAX_CONFIG, bytes.length)))?.bytes.equals(bytes)
  )
    throw new Error('mcp-containment-unavailable');
}
export async function ensureMarker(root, vault) {
  await privateDirectory(root, vault);
  const path = join(vault, '.gitignore'),
    expected = Buffer.from('*\n');
  const current = await readPrivate(root, path, 16);
  if (!current) await writeExclusive(root, path, expected);
  else if (!current.bytes.equals(expected)) throw new Error('mcp-containment-unavailable');
}
/** @param {string | null} [expected] Exact prior manifest digest, or null for exclusive creation. */
export async function writeManifest(root, path, manifest, expected = null) {
  const parent = await inspect(root, dirname(path), 'directory', true);
  const before = await readPrivate(root, path, 16 * 1024);
  if (!parent || (expected === null ? before !== null : before?.sha256 !== expected))
    throw new Error('mcp-containment-preview-stale');
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (bytes.length > 16 * 1024) throw new Error('mcp-containment-unavailable');
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
    const current = await readPrivate(root, path, 16 * 1024);
    if (
      !same(parent, await inspect(root, dirname(path), 'directory', true)) ||
      (expected === null ? current !== null : current?.sha256 !== expected)
    )
      throw new Error('mcp-containment-preview-stale');
    await rename(temporary, path);
    return hash(bytes);
  } finally {
    await handle?.close();
    try {
      if (
        same(parent, await inspect(root, dirname(path), 'directory', true)) &&
        (await inspect(root, temporary, 'file', true))
      )
        await unlink(temporary);
    } catch {
      /* Preserve substituted paths. */
    }
  }
}
/** The main process retains ownership until its worker has terminated. */
export async function prepareApplyLock(userHome) {
  return prepareUserApplyLock(userHome, '.mcp-containment.apply.lock');
}
/** Shared Codex configuration needs a lock independent of project and STROQ_HOME. */
export async function prepareCodexSkillApplyLock(userHome, expectedUser) {
  try {
    return await prepareUserApplyLock(userHome, '.codex-skill-controls.apply.lock', expectedUser);
  } catch {
    throw new Error('codex-control-unavailable');
  }
}
async function prepareUserApplyLock(userHome, name, expectedUser) {
  const root = await canonicalRoot(userHome),
    directory = join(root.path, '.stroq');
  if (expectedUser) {
    const s = await lstat(root.path);
    if (
      expectedUser.path !== root.path ||
      !same(expectedUser, root) ||
      !same(root, s) ||
      expectedUser.uid !== s.uid ||
      expectedUser.mode !== s.mode
    )
      throw new Error('mcp-containment-unavailable');
  }
  await inspect(root, directory);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const s = await inspect(root, directory);
  if (!s || !owned(s) || (s.mode & 0o022) !== 0) throw new Error('mcp-containment-unavailable');
  const path = join(directory, name);
  for (const candidate of [path, `${path}.reaper`]) await inspect(root, candidate);
  return {
    path,
    fs: {
      mkdir,
      rm,
      stat,
      writeFile,
      async readFile(file, encoding) {
        const read = await readPrivate(root, file, 16 * 1024);
        if (!read) throw new Error('record-invalid');
        return read.bytes.toString(encoding);
      },
    },
  };
}
