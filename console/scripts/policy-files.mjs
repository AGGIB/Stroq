import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rootIdentity, snapshotFile, atomicWrite } from './agent-setup-files.mjs';

export const MAX_POLICY_BYTES = 256 * 1024;
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const owned = (stat) => uid === null || stat.uid === uid;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw new Error(code);
};

async function directory(path) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    !owned(stat) ||
    (stat.mode & 0o022) !== 0 ||
    (await realpath(path)) !== path
  )
    fail('policy-unavailable');
  return stat;
}

async function privateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return directory(path);
}

async function homeLocation(root) {
  const missing = [];
  let current = root;
  for (;;) {
    try {
      const stat = await directory(current);
      return missing.length
        ? { rootStat: null, anchor: current, anchorStat: stat, missing }
        : { rootStat: stat };
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(current) === current) throw error;
      missing.unshift(current);
      current = dirname(current);
    }
  }
}

export function samePolicyRevision(before, after) {
  return (
    before.root === after.root &&
    before.rawSha === after.rawSha &&
    isDeepStrictEqual(before.capture, after.capture) &&
    (before.bytes === null || after.bytes === null || before.bytes.equals(after.bytes))
  );
}

/** One fixed file, with exact raw bytes, source identity/mode/times and parent pins. */
export async function readPolicyState(home) {
  try {
    const root = resolve(home),
      location = await homeLocation(root);
    const captureRoot = await rootIdentity(location.rootStat === null ? location.anchor : root);
    const path = join(root, 'policy.yaml'),
      capture = await snapshotFile(captureRoot, path, MAX_POLICY_BYTES);
    if (
      capture.directories.some((s) => !owned(s) || (s.mode & 0o022) !== 0) ||
      (capture.file && (!owned(capture.file) || (capture.file.mode & 0o022) !== 0))
    )
      fail('policy-unavailable');
    const text =
      capture.bytes === null
        ? null
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(capture.bytes);
    return {
      root,
      ...location,
      path,
      bytes: capture.bytes,
      text,
      rawSha: capture.bytes === null ? null : bytesHash(capture.bytes),
      mode: capture.mode,
      capture,
      captureRoot,
    };
  } catch {
    fail('policy-unavailable');
  }
}

async function unchanged(before) {
  const current = await readPolicyState(before.root).catch(() => fail('stale-policy'));
  if (!samePolicyRevision(before, current)) fail('stale-policy');
  return current;
}

async function createHome(before) {
  if (before.rootStat !== null) return before;
  await unchanged(before);
  try {
    for (const path of before.missing) {
      await mkdir(path, { mode: 0o700 });
      await directory(path);
    }
  } catch {
    fail('stale-policy');
  }
  const current = await readPolicyState(before.root);
  if (current.rawSha !== null) fail('stale-policy');
  return current;
}

async function writeExclusive(path, bytes, mode = 0o600) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The same exclusive lock is used by ordinary policy writes and guarded recovery. */
async function withPolicyLock(before, action) {
  before = await createHome(before);
  await unchanged(before);
  const lock = join(before.root, '.console-policy.lock');
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    fail(error.code === 'EEXIST' ? 'busy' : 'write-failed');
  }
  const stat = await handle.stat();
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return await action(before);
  } finally {
    await handle.close();
    const current = await lstat(lock).catch(() => null);
    if (current && same(stat, current)) await unlink(lock).catch(() => undefined);
  }
}

async function recoveryRecord(before, bytes, fingerprint, now, version) {
  const receiptId = randomUUID(),
    appliedAt = new Date(now).toISOString(),
    rawSha = bytes === null ? null : bytesHash(bytes);
  let backupId = null;
  try {
    for (const path of [
      join(before.root, 'backups'),
      join(before.root, 'backups', 'console-policy'),
    ]) {
      const found = await privateDirectory(path);
      if ((found.mode & 0o777) !== 0o700) fail('backup-unavailable');
    }
    const store = join(before.root, 'backups', 'console-policy');
    const root = await rootIdentity(before.root);
    const checkedWrite = async (path, payload) => {
      const initial = await snapshotFile(root, path, MAX_POLICY_BYTES);
      if (initial.bytes !== null) fail('backup-unavailable');
      await writeExclusive(path, payload);
      const after = await snapshotFile(root, path, MAX_POLICY_BYTES);
      if (
        after.sha256 !== bytesHash(payload) ||
        after.mode !== 0o600 ||
        !owned(after.file) ||
        !isDeepStrictEqual(initial.directories, after.directories)
      )
        fail('backup-unavailable');
      return { path, capture: after };
    };
    const copies = [];
    if (before.bytes !== null) {
      copies.push(await checkedWrite(join(store, `${receiptId}.yaml`), before.bytes));
      backupId = receiptId;
    }
    copies.push(
      await checkedWrite(
        join(store, `${receiptId}.json`),
        Buffer.from(
          JSON.stringify({
            schema: `stroq-policy-write/${version}`,
            receiptId,
            appliedAt,
            beforeRawSha: before.rawSha,
            afterRawSha: rawSha,
            policyFingerprint: fingerprint,
            backupId,
          }),
        ),
      ),
    );
    for (const copy of copies)
      if (!isDeepStrictEqual(copy.capture, await snapshotFile(root, copy.path, MAX_POLICY_BYTES)))
        fail('backup-unavailable');
    return {
      applied: true,
      receiptId,
      appliedAt,
      policyFingerprint: fingerprint,
      rawSha,
      backupId,
    };
  } catch {
    fail('backup-unavailable');
  }
}

/** No rollback: a post-publish discrepancy is uncertain and preserves newer foreign bytes. */
async function commitPolicy(before, bytes, fingerprint, now, options = {}) {
  if (bytes !== null && (!bytes.length || bytes.length > MAX_POLICY_BYTES)) fail('write-failed');
  return withPolicyLock(before, async (bound) => {
    let committed = false;
    try {
      const current = await unchanged(bound);
      if (current.bytes !== null && (current.mode & 0o200) === 0) fail('write-failed');
      await options.assertCurrent?.();
      const receipt = await recoveryRecord(current, bytes, fingerprint, now, options.version ?? 1);
      await options.fault?.('after-backup', { receiptId: receipt.receiptId });
      await options.assertCurrent?.();
      await unchanged(current);
      if (bytes === null) {
        if (current.bytes === null) fail('no-changes');
        await options.fault?.('before-rename', {});
        await options.assertCurrent?.();
        await unchanged(current);
        await unlink(current.path);
        committed = true;
        await options.fault?.('after-rename', {});
      } else {
        await atomicWrite(current.captureRoot, current.path, bytes, current.capture, current.mode, {
          fault: async (stage, details) => {
            if (stage === 'after-rename') committed = true;
            await options.fault?.(stage, details);
            if (stage === 'before-rename') {
              await options.assertCurrent?.();
              await unchanged(current);
            }
          },
        });
      }
      const after = await readPolicyState(current.root);
      if (after.rawSha !== receipt.rawSha) fail('write-failed');
      await options.verifySemantic?.(after.text, fingerprint);
      await options.assertCurrent?.();
      if (!samePolicyRevision(after, await readPolicyState(current.root))) fail('write-failed');
      return options.captureReceipt ? { ...receipt, sourceSnapshot: after } : receipt;
    } catch (error) {
      if (committed) fail(options.unknownCode ?? 'write-failed');
      if (
        [
          'stale-policy',
          'policy-unavailable',
          'busy',
          'backup-unavailable',
          'write-failed',
          'policy-history-stale',
          'stale-runtime',
          'policy-cases-stale',
          'policy-cases-unavailable',
          'no-changes',
        ].includes(error?.message)
      )
        throw error;
      fail('write-failed');
    }
  });
}

/** Existing tightening writer keeps the legacy receipt and v1 intent format. */
export async function applyPolicyBytes(before, candidateText, policyFingerprint, now) {
  return commitPolicy(before, Buffer.from(candidateText, 'utf8'), policyFingerprint, now);
}

/** Caller holds the saved-case lock; null removes the active file for CURRENT built-in defaults. */
export async function restorePolicyBytes(
  before,
  candidateBytes,
  policyFingerprint,
  now,
  options = {},
) {
  if (typeof options.verifySemantic !== 'function') fail('engine-unavailable');
  return commitPolicy(before, candidateBytes, policyFingerprint, now, {
    ...options,
    version: 2,
    unknownCode: 'policy-restore-unknown',
    captureReceipt: true,
  });
}
