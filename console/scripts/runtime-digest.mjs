import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';

const MAX_FILES = 128;
// The adapters independently bundle the engine to keep worker loading isolated:
// their current 26 MiB plus the 6 MiB core do not fit the CLI's separate 32 MiB cap.
const MAX_BYTES = 48 * 1024 * 1024;
const closed = (x, keys) =>
  x &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  Object.keys(x).length === keys.length &&
  keys.every((key) => Object.hasOwn(x, key));

/** Bind platform service and worker bytes without allowing subdirectories in the CLI bundle. */
export async function hashPlatformRuntime(hash, paths) {
  if (paths.manifest === undefined) return;
  const root = await rootIdentity(paths.manifestRoot);
  const manifestPath = relative(paths.manifestRoot, paths.manifest).split(sep).join('/');
  const packed = manifestPath === 'platform/runtime-manifest.json';
  if (!packed && manifestPath !== 'console/.local-engine/runtime-manifest.json') throw new Error();
  const prefix = packed ? 'platform' : 'console';
  const core = packed ? 'platform/core/index.js' : 'packages/core/dist/index.js';
  const captured = await snapshotFile(root, join(root.path, manifestPath), 64 * 1024);
  if (captured.bytes === null) throw new Error();
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes));
  if (
    !closed(manifest, ['schema', 'files']) ||
    manifest.schema !== 'stroq-runtime/1' ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > MAX_FILES
  )
    throw new Error();
  const allowed = new RegExp(
    `^${prefix}/(?:scripts/[a-z][\\w.-]*\\.mjs|\\.local-engine/[a-z][\\w.-]*\\.(?:js|json))$`,
  );
  const names = new Set();
  let total = 0;
  for (const entry of manifest.files) {
    if (
      !closed(entry, ['path', 'size', 'sha256']) ||
      typeof entry.path !== 'string' ||
      (entry.path !== core && !allowed.test(entry.path)) ||
      entry.path === manifestPath ||
      names.has(entry.path) ||
      !Number.isInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 16 * 1024 * 1024 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error();
    names.add(entry.path);
    total += entry.size;
    if (total > MAX_BYTES) throw new Error();
    const file = await snapshotFile(root, join(root.path, entry.path), 16 * 1024 * 1024);
    if (
      file.bytes === null ||
      file.bytes.length !== entry.size ||
      createHash('sha256').update(file.bytes).digest('hex') !== entry.sha256
    )
      throw new Error();
    hash.update(entry.path).update('\0').update(file.bytes).update('\0');
  }
  if (
    !names.has(core) ||
    ![...names].some((name) => name.startsWith(`${prefix}/scripts/`)) ||
    ![...names].some((name) => name.startsWith(`${prefix}/.local-engine/`))
  )
    throw new Error();
  hash.update('stroq-runtime/1\0').update(captured.bytes);
}

/** The entry is a split bundle: hash every adjacent runtime file, not just its small loader. */
export async function runtimeDigest(paths) {
  try {
    const root = await rootIdentity(dirname(paths.cli));
    const names = (await readdir(root.path)).sort();
    if (names.length > 256 || names.some((name) => !/^[\w.-]+\.(?:js|json)$/.test(name)))
      throw new Error();
    const hash = createHash('sha256');
    let bytes = 0;
    for (const name of names) {
      const file = await snapshotFile(root, join(root.path, name), 16 * 1024 * 1024);
      if (file.bytes === null || (bytes += file.bytes.length) > 32 * 1024 * 1024) throw new Error();
      hash.update(name).update('\0').update(file.bytes).update('\0');
    }
    const packageRoot = await rootIdentity(dirname(paths.package));
    hash.update(
      (await snapshotFile(packageRoot, join(packageRoot.path, basename(paths.package)), 64 * 1024))
        .bytes,
    );
    await hashPlatformRuntime(hash, paths);
    return hash.digest('hex');
  } catch {
    throw new Error('engine-unavailable');
  }
}
