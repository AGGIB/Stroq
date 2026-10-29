import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeLayout } from './runtime-layout.mjs';

export const MAX_POLICY_CASES = 64;
export const MAX_POLICY_CASE_BYTES = 256 * 1024;
const SCHEMA = 'stroq-policy-cases-store/1';
const SHA = /^[a-f0-9]{64}$/;
const CLASSES = new Set([
  'shell.exec_encoded',
  'shell.network',
  'shell.destructive',
  'shell.unparsed',
  'fs.secrets',
  'fs.canary',
  'git.push_external',
  'config.self',
  'config.self_touch',
  'config.git_exec',
  'config.persistence',
  'config.instructions',
  'config.instructions_payload',
  'network.fetch',
  'mcp.call',
  'mcp.side_effect',
  'origin.untrusted',
  'origin.suspect',
  'secret.egress',
  'secret.unscannable',
]);
const fail = (code) => {
  throw new Error(code);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = (s) => typeof process.getuid !== 'function' || s.uid === process.getuid();
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype &&
  Reflect.ownKeys(v).length === keys.length &&
  Reflect.ownKeys(v).every((key) => typeof key === 'string' && keys.includes(key));
const stamp = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))
    return false;
  const at = new Date(v);
  return Number.isFinite(at.getTime()) && at.toISOString() === v;
};
const effects = (v) =>
  Array.isArray(v) &&
  v.length === 2 &&
  Array.from(v).every(
    (item, i) =>
      closed(item, ['taint', 'effect']) &&
      item.taint === ['none', 'suspect'][i] &&
      ['allow', 'ask', 'deny'].includes(item.effect),
  );
const classes = (v) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= CLASSES.size &&
  Array.from(v).every((item, i) => CLASSES.has(item) && (i === 0 || v[i - 1] < item));
export const policyCaseId = (selected, expected) =>
  `case-${hash(JSON.stringify({ classes: selected, expected }))}`;
export function validatePolicyCaseRecord(v) {
  return (
    closed(v, ['id', 'createdAt', 'source', 'classes', 'expected']) &&
    stamp(v.createdAt) &&
    classes(v.classes) &&
    effects(v.expected) &&
    v.id === policyCaseId(v.classes, v.expected) &&
    closed(v.source, ['incidentId', 'evidenceSha', 'workspaceId']) &&
    typeof v.source.evidenceSha === 'string' &&
    SHA.test(v.source.evidenceSha) &&
    v.source.incidentId === `incident-${v.source.evidenceSha}` &&
    typeof v.source.workspaceId === 'string' &&
    /^workspace-[a-f0-9]{24}$/.test(v.source.workspaceId)
  );
}
function recordsValid(records) {
  return (
    Array.isArray(records) &&
    records.length <= MAX_POLICY_CASES &&
    Array.from(records).every(validatePolicyCaseRecord) &&
    new Set(records.map((r) => r.id)).size === records.length &&
    new Set(records.map((r) => JSON.stringify(r.classes))).size === records.length
  );
}

/** Duplicate decoded object keys are invalid even when JSON.parse would collapse them. */
function parse(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const stack = [];
    for (let at = 0; at < text.length; at += 1) {
      const token = text[at];
      if (token === '"') {
        const start = at;
        while (++at < text.length) {
          if (text[at] === '\\') at += 1;
          else if (text[at] === '"') break;
        }
        const top = stack.at(-1);
        if (top?.keys && top.key) {
          const key = JSON.parse(text.slice(start, at + 1));
          if (top.keys.has(key)) fail('policy-cases-invalid');
          top.keys.add(key);
        }
      } else if (token === '{' || token === '[') {
        if (stack.length >= 8) fail('policy-cases-invalid');
        stack.push(token === '{' ? { keys: new Set(), key: true } : {});
      } else if (token === '}' || token === ']') stack.pop();
      else if (token === ':' && stack.at(-1)?.keys) stack.at(-1).key = false;
      else if (token === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
    }
    const value = JSON.parse(text);
    if (
      !closed(value, ['schema', 'records']) ||
      value.schema !== SCHEMA ||
      !recordsValid(value.records)
    )
      fail('policy-cases-invalid');
    return value.records;
  } catch {
    fail('policy-cases-invalid');
  }
}

async function directory(path, privateMode = false, requireOwner = true) {
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (requireOwner && (!owned(s) || (s.mode & 0o022) !== 0)) ||
    (privateMode && (s.mode & 0o777) !== 0o700) ||
    (await realpath(path)) !== path
  )
    fail('policy-cases-unavailable');
  return s;
}
async function location(root) {
  const missing = [];
  let anchor = root;
  for (;;) {
    try {
      await directory(anchor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(anchor) === anchor) throw error;
      missing.unshift(anchor);
      anchor = dirname(anchor);
    }
  }
  const chain = [];
  for (let path = anchor; ; path = dirname(path)) {
    chain.push({ path, stat: await directory(path, false, false) });
    if (dirname(path) === path) break;
    if (chain.length > 128) fail('policy-cases-unavailable');
  }
  let consoleStat = null;
  if (!missing.length) {
    try {
      consoleStat = await directory(join(root, 'console'), true);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { chain, missing, consoleStat };
}
function sameLocation(a, b) {
  return (
    a.chain.length === b.chain.length &&
    a.chain.every((item, i) => item.path === b.chain[i].path && same(item.stat, b.chain[i].stat)) &&
    a.missing.join('\0') === b.missing.join('\0') &&
    (a.consoleStat === null || b.consoleStat === null
      ? a.consoleStat === b.consoleStat
      : same(a.consoleStat, b.consoleStat))
  );
}
async function assertLocation(root, pinned) {
  if (!sameLocation(pinned, await location(root))) fail('policy-cases-stale');
}
const regular = (s) => s.isFile() && owned(s) && s.nlink === 1 && (s.mode & 0o777) === 0o600;
const sameFile = (a, b) =>
  a === null || b === null
    ? a === b
    : same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function readBytes(root, pinned) {
  await assertLocation(root, pinned);
  let handle;
  try {
    const path = join(root, 'console', 'policy-cases.json');
    let before = null;
    if (pinned.consoleStat !== null) {
      try {
        before = await lstat(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (before === null) {
      await assertLocation(root, pinned);
      return { bytes: null, file: null };
    }
    if (!regular(before)) fail('policy-cases-unavailable');
    if (before.size > MAX_POLICY_CASE_BYTES) fail('policy-cases-invalid');
    handle = await open(path, flags);
    const s = await handle.stat();
    if (!regular(s) || !sameFile(before, s)) fail('policy-cases-unavailable');
    const bytes = Buffer.alloc(s.size);
    let filled = 0;
    while (filled < bytes.length) {
      const read = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!read.bytesRead) break;
      filled += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (
      filled !== bytes.length ||
      extra.bytesRead ||
      !sameFile(s, await handle.stat()) ||
      !sameFile(s, await lstat(path))
    )
      fail('policy-cases-unavailable');
    await assertLocation(root, pinned);
    return { bytes, file: s };
  } finally {
    await handle?.close();
  }
}
async function createLocation(root, pinned, fault) {
  await assertLocation(root, pinned);
  const created = new Map();
  let parent = pinned.chain[0];
  for (const path of [
    ...pinned.missing,
    ...(pinned.consoleStat === null ? [join(root, 'console')] : []),
  ]) {
    if (!same(parent.stat, await directory(parent.path))) fail('policy-cases-stale');
    await mkdir(path, { mode: 0o700 });
    const s = await directory(path, true);
    created.set(path, s);
    if (!same(parent.stat, await directory(parent.path))) fail('policy-cases-stale');
    parent = { path, stat: s };
  }
  for (const item of pinned.chain)
    if (!same(item.stat, await directory(item.path, false, false))) fail('policy-cases-stale');
  await fault('before-location-recapture');
  const current = await location(root);
  for (const [path, stat] of created) {
    const recaptured =
      path === join(root, 'console')
        ? current.consoleStat
        : current.chain.find((item) => item.path === path)?.stat;
    if (!recaptured || !same(stat, recaptured)) fail('policy-cases-stale');
  }
  return current;
}
function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

/** Only fixed derived records cross this API. Snapshots privately pin path and inode identities. */
export function createPolicyCasesStore({
  home,
  lockTimeoutMs = 3000,
  fault = async () => {},
} = {}) {
  if (typeof home !== 'string' || !home.length || home.length > 4096)
    throw new TypeError('home-required');
  const root = resolve(home);
  const snapshots = new WeakMap();
  function snapshot(pinned, read) {
    const value = frozen({
      revision: read.bytes === null ? null : hash(read.bytes),
      records: read.bytes === null ? [] : parse(read.bytes),
    });
    snapshots.set(value, { pinned, file: read.file });
    return value;
  }
  async function capture() {
    try {
      const pinned = await location(root);
      return snapshot(pinned, await readBytes(root, pinned));
    } catch (error) {
      fail(
        ['policy-cases-invalid', 'policy-cases-stale'].includes(error.message)
          ? error.message
          : 'policy-cases-unavailable',
      );
    }
  }
  async function assertSnapshot(before) {
    const binding = snapshots.get(before);
    if (!binding) fail('policy-cases-stale');
    await assertLocation(root, binding.pinned);
    const read = await readBytes(root, binding.pinned);
    if (
      (read.bytes === null ? null : hash(read.bytes)) !== before.revision ||
      !sameFile(read.file, binding.file)
    )
      fail('policy-cases-stale');
  }
  async function withSnapshotLock(before, callback) {
    const binding = snapshots.get(before);
    if (!binding || typeof callback !== 'function') fail('policy-cases-stale');
    let pinned = binding.pinned;
    let callbackError;
    try {
      await assertLocation(root, pinned);
      const initial = await readBytes(root, pinned);
      if (
        (initial.bytes === null ? null : hash(initial.bytes)) !== before.revision ||
        !sameFile(initial.file, binding.file)
      )
        fail('policy-cases-stale');
      if (pinned.missing.length || pinned.consoleStat === null)
        pinned = await createLocation(root, pinned, fault);
      // Only our successful exclusive mkdir sequence can establish this proof.
      // It is private lock metadata, never a public case-store snapshot field.
      const lockMetadata = frozen({
        createdHome: binding.pinned.missing.includes(root)
          ? { dev: pinned.chain[0].stat.dev, ino: pinned.chain[0].stat.ino }
          : null,
      });
      const { withLock } = await import(pathToFileURL(runtimeLayout().core).href);
      const lockPath = join(root, 'console', '.policy-cases.lock');
      const lockIdentities = new Map();
      const lockDirectory = async (path) => {
        if (![lockPath, `${lockPath}.reaper`].includes(path)) fail('policy-cases-unavailable');
        await assertLocation(root, pinned);
        const current = await directory(path, true);
        if (lockIdentities.has(path) && !same(lockIdentities.get(path), current))
          fail('policy-cases-unavailable');
        lockIdentities.set(path, current);
        return current;
      };
      const lockFs = {
        async mkdir(path) {
          await assertLocation(root, pinned);
          await mkdir(path, { mode: 0o700 });
          lockIdentities.delete(path);
          await lockDirectory(path);
        },
        stat: lockDirectory,
        async readFile(path, encoding) {
          await lockDirectory(dirname(path));
          const s = await lstat(path);
          if (!regular(s) || s.size > 1024) fail('policy-cases-unavailable');
          const handle = await open(path, flags);
          try {
            if (!sameFile(s, await handle.stat())) fail('policy-cases-unavailable');
            // Test-only scheduling seam; never selected by an HTTP request.
            await fault('after-lock-owner-stat');
            const bytes = Buffer.alloc(1024);
            const read = await handle.read(bytes, 0, bytes.length, 0);
            const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
            if (
              read.bytesRead !== s.size ||
              extra.bytesRead ||
              !sameFile(s, await handle.stat()) ||
              !sameFile(s, await lstat(path))
            )
              fail('policy-cases-unavailable');
            await lockDirectory(dirname(path));
            return bytes.subarray(0, read.bytesRead).toString(encoding);
          } finally {
            await handle.close();
          }
        },
        async writeFile(path, value, options) {
          await lockDirectory(dirname(path));
          return writeFile(path, value, { ...options, flag: 'wx', mode: 0o600 });
        },
        async rm(path, options) {
          await lockDirectory(path);
          await rm(path, options);
          lockIdentities.delete(path);
        },
      };
      return await withLock(
        lockPath,
        async () => {
          await assertLocation(root, pinned);
          const read = await readBytes(root, pinned);
          if (
            (read.bytes === null ? null : hash(read.bytes)) !== before.revision ||
            !sameFile(read.file, binding.file)
          )
            fail('policy-cases-stale');
          let fresh = snapshot(pinned, read),
            active = true,
            replaced = false;
          const replace = async (records) => {
            if (!active || replaced || !recordsValid(records)) fail('policy-cases-invalid');
            const next = structuredClone(records);
            for (const old of fresh.records) {
              const kept = next.find(
                (item) =>
                  item.id === old.id ||
                  JSON.stringify(item.classes) === JSON.stringify(old.classes),
              );
              if (kept && JSON.stringify(kept) !== JSON.stringify(old))
                fail('policy-cases-invalid');
            }
            const bytes = Buffer.from(`${JSON.stringify({ schema: SCHEMA, records: next })}\n`);
            if (bytes.length > MAX_POLICY_CASE_BYTES) fail('policy-cases-invalid');
            const verify = async () => {
              const latest = await readBytes(root, pinned);
              if (
                (latest.bytes === null ? null : hash(latest.bytes)) !== fresh.revision ||
                !sameFile(latest.file, snapshots.get(fresh).file)
              )
                fail('policy-cases-stale');
            };
            await verify();
            const path = join(root, 'console', 'policy-cases.json');
            const temporary = join(root, 'console', `.policy-cases-${randomUUID()}.tmp`);
            let handle,
              staged = false;
            try {
              handle = await open(
                temporary,
                constants.O_WRONLY |
                  constants.O_CREAT |
                  constants.O_EXCL |
                  (constants.O_NOFOLLOW ?? 0),
                0o600,
              );
              staged = true;
              await handle.writeFile(bytes);
              await handle.chmod(0o600);
              await handle.sync();
              await handle.close();
              handle = null;
              await verify();
              await rename(temporary, path);
              staged = false;
              await fault('after-rename');
              const parent = await open(join(root, 'console'), flags);
              try {
                if (!same(await parent.stat(), pinned.consoleStat)) fail('policy-cases-stale');
                await parent.sync();
              } catch (error) {
                if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
              } finally {
                await parent.close();
              }
              const readback = await readBytes(root, pinned);
              if (readback.bytes === null || !readback.bytes.equals(bytes))
                fail('policy-cases-stale');
              fresh = snapshot(pinned, readback);
              replaced = true;
              return fresh;
            } finally {
              await handle?.close();
              if (staged) {
                try {
                  await assertLocation(root, pinned);
                  await rm(temporary);
                } catch {
                  /* Refuse unsafe cleanup. */
                }
              }
            }
          };
          try {
            const result = await callback(fresh, replace, lockMetadata);
            await assertSnapshot(fresh);
            return result;
          } catch (error) {
            callbackError = error;
            throw error;
          } finally {
            active = false;
          }
        },
        { timeoutMs: lockTimeoutMs, fs: lockFs },
      );
    } catch (error) {
      if (
        error === callbackError ||
        ['policy-cases-invalid', 'policy-cases-stale', 'policy-cases-unavailable'].includes(
          error.message,
        )
      )
        throw error;
      fail(
        error.message?.startsWith('lock timeout:')
          ? 'policy-cases-busy'
          : 'policy-cases-unavailable',
      );
    }
  }
  return { capture, assertSnapshot, withSnapshotLock };
}
