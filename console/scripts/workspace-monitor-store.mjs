import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { acquireWorkspaceMonitorLease } from './workspace-monitor-lease.mjs';

export const MAX_MONITOR_INTENTS = 64;
export const MAX_MONITOR_INTENT_BYTES = 8192;
export const MAX_MONITOR_INTENT_TOTAL_BYTES = 1024 * 1024;
const SCHEMA = 'stroq-workspace-monitor-intent/1';
const SHA = /^[a-f0-9]{64}$/;
const hash = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const owned = (v) => typeof process.getuid !== 'function' || v.uid === process.getuid();
const closed = (v, keys) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype &&
  Reflect.ownKeys(v).length === keys.length &&
  Reflect.ownKeys(v).every((key) => typeof key === 'string' && keys.includes(key));
const text = (v, max) =>
  typeof v === 'string' &&
  v.length > 0 &&
  Buffer.byteLength(v) <= max &&
  v.isWellFormed() &&
  !/[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(v);
const pathValue = (v) => text(v, 4096) && isAbsolute(v) && resolve(v) === v;
const rootValue = (v) =>
  closed(v, ['path', 'dev', 'ino', 'uid', 'mode']) &&
  pathValue(v.path) &&
  ['dev', 'ino', 'uid', 'mode'].every((key) => Number.isSafeInteger(v[key]) && v[key] >= 0) &&
  v.mode <= 0xffff &&
  (v.mode & 0o170000) === 0o040000;
const stamp = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const validBound = (v) =>
  closed(v, ['engineVersion', 'runtimeSha256']) &&
  text(v.engineVersion, 100) &&
  typeof v.runtimeSha256 === 'string' &&
  SHA.test(v.runtimeSha256);
const ids = (roots) => ({
  workspaceId: `workspace-${hash(roots.project.path).slice(0, 24)}`,
  storeId: hash(
    `stroq-workspace/1\0${roots.project.path}\0${roots.project.dev}\0${roots.project.ino}`,
  ),
});
function validRecord(v) {
  return (
    closed(v, [
      'schema',
      'workspaceId',
      'storeId',
      'home',
      'roots',
      'engineVersion',
      'runtimeSha256',
      'configuredAt',
      'enabled',
    ]) &&
    v.schema === SCHEMA &&
    pathValue(v.home) &&
    closed(v.roots, ['project', 'user']) &&
    rootValue(v.roots.project) &&
    rootValue(v.roots.user) &&
    v.workspaceId === ids(v.roots).workspaceId &&
    v.storeId === ids(v.roots).storeId &&
    validBound({ engineVersion: v.engineVersion, runtimeSha256: v.runtimeSha256 }) &&
    stamp(v.configuredAt) &&
    typeof v.enabled === 'boolean'
  );
}

/** Reject duplicate decoded keys, invalid Unicode and lossy numeric spellings before use. */
function parse(bytes, storeId) {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(source),
      stack = [];
    for (let at = 0; at < source.length; at++) {
      const char = source[at];
      if (char === '"') {
        const start = at;
        while (++at < source.length) {
          if (source[at] === '\\') at++;
          else if (source[at] === '"') break;
        }
        const decoded = JSON.parse(source.slice(start, at + 1)),
          top = stack.at(-1);
        if (!decoded.isWellFormed() || /\ufffd/u.test(decoded)) fail('monitor-store-invalid');
        if (top?.keys && top.key) {
          if (top.keys.has(decoded) || ['__proto__', 'constructor', 'prototype'].includes(decoded))
            fail('monitor-store-invalid');
          top.keys.add(decoded);
          top.key = false;
        }
      } else if (char === '{' || char === '[') {
        if (stack.length >= 8) fail('monitor-store-invalid');
        stack.push(char === '{' ? { keys: new Set(), key: true } : {});
      } else if (char === '}' || char === ']') stack.pop();
      else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
      else if (char === '-' || /[0-9]/.test(char)) {
        const start = at;
        while (at + 1 < source.length && /[0-9.eE+-]/.test(source[at + 1])) at++;
        const token = source.slice(start, at + 1);
        if (JSON.stringify(Number(token)) !== token) fail('monitor-store-invalid');
      }
    }
    if (!validRecord(value) || value.storeId !== storeId) fail('monitor-store-invalid');
    return value;
  } catch {
    fail('monitor-store-invalid');
  }
}

/** Resolve an absent home against its nearest existing canonical directory, without mkdir. */
async function location(selectedHome, storeId) {
  let anchor = selectedHome;
  for (;;) {
    try {
      const info = await lstat(anchor);
      if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) || (info.mode & 0o022) !== 0)
        fail('monitor-store-unavailable');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(anchor) === anchor) throw error;
      anchor = dirname(anchor);
    }
  }
  const root = await rootIdentity(anchor);
  const home = join(root.path, relative(anchor, selectedHome));
  const directory = join(home, 'console', 'workspace-monitor');
  return { root, home, directory, file: join(directory, `${storeId}.json`) };
}
function safeSnapshot(capture, home) {
  if (
    capture.directories.some(
      (d) =>
        !owned(d) ||
        (d.mode & 0o022) !== 0 ||
        ((d.path === home || d.path.startsWith(`${home}/`)) && (d.mode & 0o777) !== 0o700),
    ) ||
    (capture.file && (!owned(capture.file) || (capture.file.mode & 0o777) !== 0o600))
  )
    fail('monitor-store-unavailable');
  return capture;
}
async function snapshot(where, file = where.file) {
  try {
    const stat = await lstat(file);
    if (stat.isFile() && stat.size > MAX_MONITOR_INTENT_BYTES) fail('monitor-store-limit');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return safeSnapshot(await snapshotFile(where.root, file, MAX_MONITOR_INTENT_BYTES), where.home);
}
async function captureAll(where, ignoredTemporary = null) {
  const before = await snapshot(where);
  if (!before.directories.some((d) => d.path === where.directory))
    return { before, records: new Map(), total: 0 };
  const records = new Map();
  let total = 0;
  const directory = await opendir(where.directory, { bufferSize: 16 });
  for await (const item of directory) {
    if (join(where.directory, item.name) === ignoredTemporary) continue;
    if (records.size >= MAX_MONITOR_INTENTS) fail('monitor-store-limit');
    if (!/^[a-f0-9]{64}\.json$/.test(item.name)) fail('monitor-store-invalid');
    const storeId = item.name.slice(0, -5),
      current = await snapshot(where, join(where.directory, item.name));
    if (current.bytes === null) fail('monitor-store-stale');
    total += current.bytes.length;
    if (total > MAX_MONITOR_INTENT_TOTAL_BYTES) fail('monitor-store-limit');
    records.set(storeId, { record: parse(current.bytes, storeId), revision: hash(current.bytes) });
  }
  const after = await snapshot(where);
  if (!isDeepStrictEqual(before, after)) fail('monitor-store-stale');
  return { before, records, total };
}
function codeOf(error) {
  if (
    typeof error?.message === 'string' &&
    /^monitor-store-(?:invalid|unavailable|stale|limit|write-unconfirmed)$/.test(error.message)
  )
    return error;
  return new Error(
    error?.message === 'preview-stale' ? 'monitor-store-stale' : 'monitor-store-unavailable',
  );
}

/** The caller holds the shared agent configuration lock. Only explicit configuration writes. */
export function createWorkspaceMonitorStore({
  home,
  roots,
  storeId,
  workspaceId,
  fault = async () => {},
} = {}) {
  if (
    !pathValue(home) ||
    !closed(roots, ['project', 'user']) ||
    !rootValue(roots.project) ||
    !rootValue(roots.user) ||
    !isDeepStrictEqual(ids(roots), { workspaceId, storeId }) ||
    typeof fault !== 'function'
  )
    throw new TypeError('monitor-store-unavailable');
  const selectedHome = resolve(home),
    configuredRoots = structuredClone(roots);
  async function context() {
    try {
      const where = await location(selectedHome, storeId);
      await snapshot(where);
      return { home: where.home, roots: structuredClone(configuredRoots), storeId, workspaceId };
    } catch (error) {
      throw codeOf(error);
    }
  }
  async function read() {
    try {
      const all = await captureAll(await location(selectedHome, storeId));
      return structuredClone(all.records.get(storeId) ?? null);
    } catch (error) {
      throw codeOf(error);
    }
  }
  async function update(bound, input, { beforeCommit = async () => {} } = {}) {
    if (
      !validBound(bound) ||
      !closed(input, ['enabled', 'expectedRevision', 'configuredAt']) ||
      typeof input.enabled !== 'boolean' ||
      !stamp(input.configuredAt) ||
      (input.expectedRevision !== null &&
        (typeof input.expectedRevision !== 'string' || !SHA.test(input.expectedRevision))) ||
      typeof beforeCommit !== 'function'
    )
      fail('monitor-store-invalid');
    input = structuredClone(input);
    bound = structuredClone(bound);
    let committed = false,
      guardError;
    try {
      const where = await location(selectedHome, storeId),
        all = await captureAll(where);
      const prior = all.records.get(storeId) ?? null;
      if ((prior?.revision ?? null) !== input.expectedRevision) fail('monitor-store-stale');
      if (!prior && all.records.size >= MAX_MONITOR_INTENTS) fail('monitor-store-limit');
      const record =
        !input.enabled && prior
          ? { ...prior.record, enabled: false, configuredAt: input.configuredAt }
          : {
              schema: SCHEMA,
              workspaceId,
              storeId,
              home: where.home,
              roots: structuredClone(configuredRoots),
              ...bound,
              configuredAt: input.configuredAt,
              enabled: input.enabled,
            };
      if (!validRecord(record)) fail('monitor-store-invalid');
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`),
        revision = hash(bytes);
      if (
        bytes.length > MAX_MONITOR_INTENT_BYTES ||
        all.total - (all.before.bytes?.length ?? 0) + bytes.length > MAX_MONITOR_INTENT_TOTAL_BYTES
      )
        fail('monitor-store-limit');
      const assertRoots = async () => {
        if (!input.enabled) return;
        try {
          const current = {
            project: await rootIdentity(configuredRoots.project.path),
            user: await rootIdentity(configuredRoots.user.path),
          };
          if (!isDeepStrictEqual(current, configuredRoots)) fail('monitor-store-stale');
        } catch {
          fail('monitor-store-stale');
        }
      };
      await assertRoots();
      await atomicWrite(where.root, where.file, bytes, all.before, 0o600, {
        async fault(stage, details) {
          if (stage === 'after-rename') committed = true;
          const staged =
            stage === 'before-rename' ? await snapshot(where, details.temporary) : null;
          await fault(stage, details);
          if (stage === 'before-rename') {
            await assertRoots();
            if (!isDeepStrictEqual(staged, await snapshot(where, details.temporary)))
              fail('monitor-store-stale');
            // Ignore only the exact temporary path supplied by our protected atomic writer.
            const current = await captureAll(where, details.temporary);
            if (
              current.records.size !== all.records.size ||
              [...all.records].some(
                ([id, kept]) => current.records.get(id)?.revision !== kept.revision,
              )
            )
              fail('monitor-store-stale');
            // The shared configuration lock excludes cooperative writers; the runtime and
            // consent guard is the final asynchronous action before atomicWrite's own CAS.
            try {
              await beforeCommit();
            } catch (error) {
              guardError = error;
              throw error;
            }
          }
        },
      });
      const after = await snapshot(where);
      if (after.sha256 !== revision) fail('monitor-store-write-unconfirmed');
      return { record: structuredClone(record), revision };
    } catch (error) {
      if (committed) fail('monitor-store-write-unconfirmed');
      if (error === guardError) throw error;
      throw codeOf(error);
    }
  }
  async function acquireLease() {
    if ((await read())?.record.enabled !== true) fail('monitor-store-unavailable');
    return acquireWorkspaceMonitorLease({ home: (await context()).home, storeId });
  }
  return { context, read, update, acquireLease };
}
