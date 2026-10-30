import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Only an explicit review creates its store; links are never followed/replaced. */
export async function ensureInventoryStore(home) {
  if ((await realpath(dirname(home))) !== dirname(home)) throw new Error('baseline-invalid');
  try {
    await mkdir(home, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if ((await safeLocation(home, home, true)).kind !== 'ok') throw new Error('baseline-invalid');
  const directory = join(home, 'console');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if ((await safeLocation(home, directory, true)).kind !== 'ok')
    throw new Error('baseline-invalid');
}

/** Refuse links at every component under a server-selected canonical root. */
export async function safeLocation(root, file, directory = false) {
  try {
    const base = resolve(root);
    const rel = relative(base, resolve(file));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return { kind: 'refused' };
    const rootStat = await lstat(base);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (await realpath(base)) !== base)
      return { kind: 'refused' };
    let path = base;
    const parts = rel ? rel.split(/[\\/]/) : [];
    let stat = rootStat;
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]);
      stat = await lstat(path);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
        return { kind: 'refused' };
    }
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      return { kind: 'refused' };
    if ((await realpath(path)) !== path) return { kind: 'refused' };
    return { kind: 'ok', stat };
  } catch (error) {
    return { kind: error?.code === 'ENOENT' ? 'missing' : 'refused' };
  }
}

/**
 * @returns {Promise<{kind: 'missing' | 'refused'} | {kind: 'text', text: string, sha256: string, byteLength: number}>}
 */
export async function safeText(root, file, maxBytes) {
  let handle;
  const before = await safeLocation(root, file);
  if (before.kind !== 'ok') return before;
  if (before.stat.size > maxBytes) return { kind: 'refused' };
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.ino !== before.stat.ino ||
      stat.dev !== before.stat.dev ||
      stat.size > maxBytes
    )
      return { kind: 'refused' };
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const named = await safeLocation(root, file);
    if (
      bytesRead !== bytes.length ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      named.kind !== 'ok' ||
      named.stat.ino !== stat.ino ||
      named.stat.dev !== stat.dev
    )
      return { kind: 'refused' };
    return {
      kind: 'text',
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
    };
  } catch {
    return { kind: 'refused' };
  } finally {
    await handle?.close();
  }
}

export async function safeNames(root, directory, max) {
  const located = await safeLocation(root, directory, true);
  if (located.kind !== 'ok') return { ...located, names: [] };
  let dir;
  try {
    const names = [];
    dir = await opendir(directory);
    for await (const entry of dir) {
      if (names.length >= max) return { kind: 'limit', names: names.sort() };
      names.push(entry.name);
    }
    return { kind: 'ok', names: names.sort() };
  } catch {
    return { kind: 'refused', names: [] };
  } finally {
    await dir?.close().catch(() => undefined);
  }
}
