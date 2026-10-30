import { lstat, opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { bytesHash, MAX_POLICY_BYTES } from './policy-files.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  SHA = /^[a-f0-9]{64}$/;
const nullable = (v) => v === null || (typeof v === 'string' && SHA.test(v));
const owned = (v) => typeof process.getuid !== 'function' || v.uid === process.getuid();
const fail = () => {
  throw new Error('policy-history-unavailable');
};
const pin = (v) => ({ dev: v.dev, ino: v.ino, uid: v.uid, mode: v.mode });
const directoryPin = (v) => ({ ...pin(v), size: v.size, mtimeMs: v.mtimeMs, ctimeMs: v.ctimeMs });
async function anchor(home) {
  let at = resolve(home);
  for (;;) {
    try {
      await lstat(at);
      return await rootIdentity(at);
    } catch (e) {
      if (e.code !== 'ENOENT' || dirname(at) === at) throw e;
      at = dirname(at);
    }
  }
}
async function capture(root, path, max) {
  const found = await snapshotFile(root, path, max);
  if (
    found.directories.some((s) => !owned(s) || (s.mode & 0o022) !== 0) ||
    (found.file && (!owned(found.file) || (found.file.mode & 0o777) !== 0o600))
  )
    fail();
  return found;
}
function parseIntent(text, id, parseJson) {
  const parsed = parseJson(text),
    v = parsed?.ok === true ? parsed.value : null;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !==
      'afterRawSha,appliedAt,backupId,beforeRawSha,policyFingerprint,receiptId,schema' ||
    !['stroq-policy-write/1', 'stroq-policy-write/2'].includes(v.schema) ||
    v.receiptId !== id ||
    !UUID.test(id) ||
    typeof v.appliedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.appliedAt)) ||
    new Date(v.appliedAt).toISOString() !== v.appliedAt ||
    !nullable(v.beforeRawSha) ||
    !nullable(v.afterRawSha) ||
    (v.schema === 'stroq-policy-write/1' && v.afterRawSha === null) ||
    (v.beforeRawSha === null && v.afterRawSha === null) ||
    typeof v.policyFingerprint !== 'string' ||
    !SHA.test(v.policyFingerprint) ||
    v.backupId !== (v.beforeRawSha === null ? null : id)
  )
    fail();
  return v;
}

/** Fixed owned private pairs only. Intent records are never promoted into application evidence. */
export async function readPolicyHistory(home, { parseJson } = {}) {
  const entries = [],
    captured = new Map();
  let partial = false,
    limited = false,
    total = 0;
  try {
    if (typeof parseJson !== 'function') fail();
    const root = await anchor(home),
      store = join(resolve(home), 'backups', 'console-policy');
    const chain = await snapshotFile(root, join(store, '.policy-history-boundary'), 0);
    if (
      chain.file !== null ||
      chain.directories.some(
        (s) =>
          !owned(s) ||
          (s.mode & 0o022) !== 0 ||
          ([resolve(home), join(resolve(home), 'backups'), store].includes(s.path) &&
            (s.mode & 0o777) !== 0o700),
      )
    )
      fail();
    let info;
    try {
      info = await lstat(store);
    } catch (e) {
      if (
        e.code === 'ENOENT' &&
        isDeepStrictEqual(
          chain,
          await snapshotFile(root, join(store, '.policy-history-boundary'), 0),
        )
      )
        return { history: { status: 'ready', limited: false }, entries, captured };
      throw e;
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !owned(info) ||
      (info.mode & 0o777) !== 0o700
    )
      fail();
    // Snapshot a missing fixed child to validate every ancestor without reading arbitrary files.
    const budgetedCapture = async (path, max) => {
      const remaining = 8 * 1024 * 1024 - total;
      if (remaining <= 0) {
        limited = true;
        fail();
      }
      const meta = await lstat(path);
      if (meta.size > max) fail();
      if (meta.size > remaining) {
        limited = true;
        fail();
      }
      // Charge before opening, including failed/raced captures; growth cannot increase this cap.
      total += meta.size;
      return capture(root, path, meta.size);
    };
    const names = [],
      dir = await opendir(store);
    try {
      for (;;) {
        const entry = await dir.read();
        if (!entry) break;
        if (names.length === 256) {
          limited = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      await dir.close();
    }
    const manifests = [];
    for (const name of names.sort()) {
      const match = /^([a-f0-9-]{36})\.json$/.exec(name);
      if (!match || !UUID.test(match[1])) {
        if (!/^[a-f0-9-]{36}\.yaml$/.test(name)) partial = true;
        continue;
      }
      try {
        const recordSnapshot = await budgetedCapture(join(store, name), 4096);
        if (recordSnapshot.bytes === null) fail();
        const record = parseIntent(
          new TextDecoder('utf-8', { fatal: true }).decode(recordSnapshot.bytes),
          match[1],
          parseJson,
        );
        manifests.push({ record, recordSnapshot });
      } catch {
        partial = true;
      }
    }
    for (const name of names)
      if (name.endsWith('.yaml') && !names.includes(name.slice(0, -5) + '.json')) partial = true;
    manifests.sort(
      (a, b) =>
        b.record.appliedAt.localeCompare(a.record.appliedAt) ||
        b.record.receiptId.localeCompare(a.record.receiptId),
    );
    if (manifests.length > 32) limited = true;
    for (const { record, recordSnapshot } of manifests.slice(0, 32)) {
      let recovery = record.beforeRawSha === null ? 'current-default' : 'unavailable',
        backupSnapshot = null;
      if (record.beforeRawSha !== null) {
        try {
          backupSnapshot = await budgetedCapture(
            join(store, `${record.receiptId}.yaml`),
            MAX_POLICY_BYTES,
          );
          if (
            backupSnapshot.bytes === null ||
            bytesHash(backupSnapshot.bytes) !== record.beforeRawSha
          )
            fail();
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(backupSnapshot.bytes);
          recovery = 'backup';
        } catch {
          partial = true;
          backupSnapshot = null;
        }
      }
      const row = {
        id: record.receiptId,
        recordedAt: record.appliedAt,
        beforeRawSha: record.beforeRawSha,
        afterRawSha: record.afterRawSha,
        afterPolicyFingerprint: record.policyFingerprint,
        recordSha256: bytesHash(recordSnapshot.bytes),
        recovery,
      };
      entries.push(row);
      captured.set(row.id, { row, record, recordSnapshot, backupSnapshot, root, store, chain });
    }
    if (
      !isDeepStrictEqual(directoryPin(info), directoryPin(await lstat(store))) ||
      !isDeepStrictEqual(
        chain,
        await snapshotFile(root, join(store, '.policy-history-boundary'), 0),
      )
    )
      fail();
    return {
      history: { status: partial || limited ? 'partial' : 'ready', limited },
      entries,
      captured,
    };
  } catch {
    return { history: { status: 'unavailable', limited: false }, entries: [], captured: new Map() };
  }
}

export async function assertPolicyHistoryEntry(entry) {
  try {
    if (
      !entry ||
      !isDeepStrictEqual(
        entry.chain,
        await snapshotFile(entry.root, join(entry.store, '.policy-history-boundary'), 0),
      )
    )
      throw new Error();
    const record = await capture(entry.root, join(entry.store, `${entry.row.id}.json`), 4096);
    if (!isDeepStrictEqual(record, entry.recordSnapshot)) throw new Error();
    if (entry.row.recovery === 'backup') {
      const backup = await capture(
        entry.root,
        join(entry.store, `${entry.row.id}.yaml`),
        MAX_POLICY_BYTES,
      );
      if (!isDeepStrictEqual(backup, entry.backupSnapshot)) throw new Error();
    } else if (entry.row.recovery !== 'current-default') throw new Error();
  } catch {
    throw new Error('policy-history-stale');
  }
}
