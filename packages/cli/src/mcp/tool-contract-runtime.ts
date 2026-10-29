import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

const fail = (): never => {
  throw new Error('tool-contract-unavailable');
};
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.mode === b.mode;
const regular = (s: Stats) =>
  s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o022) === 0;

/** Bind every adjacent split-bundle file, not only the entry loader. No code is executed. */
export async function hashToolContractRuntime(entry: string): Promise<string> {
  try {
    if (!isAbsolute(entry) || entry.includes('\0')) return fail();
    const directory = dirname(entry),
      root = await lstat(directory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o022) !== 0 ||
      (await realpath(directory)) !== directory
    )
      return fail();
    const names = (await readdir(directory)).sort();
    if (
      !names.includes(basename(entry)) ||
      names.length === 0 ||
      names.length > 256 ||
      names.some((name) => !/^[\w.-]+\.(?:js|json)$/.test(name))
    )
      return fail();
    const hash = createHash('sha256').update('stroq-mcp-runtime/1\0');
    const captures: { name: string; stat: Stats }[] = [];
    let total = 0;
    for (const name of names) {
      const path = join(directory, name),
        named = await lstat(path);
      if (
        !regular(named) ||
        named.size > 16 * 1024 * 1024 ||
        (total += named.size) > 32 * 1024 * 1024
      )
        return fail();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat();
        if (!regular(before) || !same(named, before)) return fail();
        const bytes = Buffer.alloc(before.size);
        let at = 0;
        while (at < bytes.length) {
          const read = await handle.read(bytes, at, bytes.length - at, at);
          if (!read.bytesRead) return fail();
          at += read.bytesRead;
        }
        if (
          (await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead ||
          !same(before, await handle.stat()) ||
          !same(before, await lstat(path))
        )
          return fail();
        hash.update(name).update('\0').update(bytes).update('\0');
        captures.push({ name, stat: before });
      } finally {
        await handle.close();
      }
    }
    if (
      !same(root, await lstat(directory)) ||
      JSON.stringify(names) !== JSON.stringify((await readdir(directory)).sort())
    )
      return fail();
    for (const capture of captures)
      if (!same(capture.stat, await lstat(join(directory, capture.name)))) return fail();
    return hash.digest('hex');
  } catch {
    return fail();
  }
}
