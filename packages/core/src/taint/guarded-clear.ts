import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionState } from '../types.js';
import { parseStrictJson } from '../scope/strict-json.js';
import { withLock } from '../util/lock.js';
import { sessionKey } from './session-store.js';

export const SESSION_TAINT_MAX_BYTES = 256 * 1024;
export interface SessionTaintPin {
  dev: string;
  ino: string;
  uid: string;
  mode: string;
  size: string;
  nlink: string;
  mtimeNs: string;
  ctimeNs: string;
}
export interface SessionTaintDirectory {
  path: string;
  dev: string;
  ino: string;
  uid: string;
  mode: string;
}
export interface SessionTaintSnapshot {
  sessionId: string;
  path: string;
  directory: SessionTaintDirectory;
  pin: SessionTaintPin | null;
  bytes: Buffer | null;
  sha256: string | null;
  state: SessionState | null;
}
export interface SessionTaintStaged {
  sha256: string;
  pin: Omit<SessionTaintPin, 'ctimeNs'>;
  bytes: Buffer;
}
/**
 * A person's confirmation of the clear, as the console collects it before it asks for one: both
 * acknowledgements given on the preview the person was shown. The clear cannot itself prove that a person
 * gave it; it refuses any clear that does not carry it, and hands it to the audit sink with the clear.
 */
export interface SessionTaintClearConfirmation {
  /** The person acknowledged that the clear lifts the restrictions the taint imposes. */
  weakensRestrictions: true;
  /** The person acknowledged that a private recovery record of the session is kept. */
  recoveryRetention: true;
  /** The preview the person confirmed. */
  previewId: string;
}
/** What the audit sink records, durably, before the clear is published. */
export interface SessionTaintClearRecord {
  sessionId: string;
  /** The tainted native state the clear replaces. */
  beforeSha256: string;
  /** The clear native state that replaces it. */
  afterSha256: string;
  at: string;
  confirmation: SessionTaintClearConfirmation;
}
/**
 * Every callback runs while the session lock is free: a callback that waits (a durable write, a slow disk)
 * never holds back a hook that marks the session suspect. The lock is held only to read the session again,
 * publish the clear of what it reads, and confirm it.
 */
export interface SessionTaintClearHooks {
  /** Required: a clear without a person's confirmation is refused. */
  confirmation: SessionTaintClearConfirmation;
  guard: () => Promise<void>;
  /** Durable recovery intent must finish before this callback returns. */
  beforePublish: (staged: SessionTaintStaged) => Promise<void>;
  /** Required: the clear is recorded durably before it is published; a clear without a sink is refused. */
  audit: (record: SessionTaintClearRecord) => Promise<void>;
  now?: () => Date;
  fault?: (stage: 'before-rename' | 'after-rename') => void | Promise<void>;
}
const PREVIEW_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const fail = (code: string): never => {
  throw new Error(code);
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Info = {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  size: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
};
const pin = (s: Info): SessionTaintPin => ({
  dev: String(s.dev),
  ino: String(s.ino),
  uid: String(s.uid),
  mode: String(s.mode),
  size: String(s.size),
  nlink: String(s.nlink),
  mtimeNs: String(s.mtimeNs),
  ctimeNs: String(s.ctimeNs),
});
const owned = (s: { uid: bigint }) =>
  typeof process.getuid !== 'function' || s.uid === BigInt(process.getuid());
const iso = (s: unknown): s is string =>
  typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const confirmed = (v: unknown): v is SessionTaintClearConfirmation =>
  exact(v, ['weakensRestrictions', 'recoveryRetention', 'previewId']) &&
  v.weakensRestrictions === true &&
  v.recoveryRetention === true &&
  typeof v.previewId === 'string' &&
  PREVIEW_ID.test(v.previewId);
function taintSource(s: unknown): boolean {
  if (s === null || typeof s !== 'object') return false;
  const source = s as Record<string, unknown>;
  return (
    exact(source, [
      'tool',
      'at',
      'ruleIds',
      ...(Object.hasOwn(source, 'source') ? ['source'] : []),
    ]) &&
    typeof source.tool === 'string' &&
    source.tool.length <= 4096 &&
    iso(source.at) &&
    Array.isArray(source.ruleIds) &&
    source.ruleIds.length <= 4096 &&
    source.ruleIds.every((r) => typeof r === 'string' && r.length <= 4096) &&
    (source.source === undefined ||
      (typeof source.source === 'string' && source.source.length <= 4096))
  );
}
/** The note of flags on the developer's own text (`OwnTextFlag`), which a clear of the taint keeps. */
const ownFlag = (v: unknown): boolean =>
  exact(v, ['since', 'count', 'last']) &&
  iso(v.since) &&
  Number.isSafeInteger(v.count) &&
  v.count > 0 &&
  taintSource(v.last);
/** The files the session downloaded (`SessionState.fetched`), which a clear of the taint keeps. */
const fetchedList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length <= 64 &&
  v.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 4096);
function state(value: unknown, id: string): value is SessionState {
  const has = (key: string) =>
    value !== null && typeof value === 'object' && Object.hasOwn(value, key);
  const flagged = has('flagged'),
    fetched = has('fetched');
  if (
    !exact(value, [
      'sessionId',
      'taint',
      'updatedAt',
      ...(flagged ? ['flagged'] : []),
      ...(fetched ? ['fetched'] : []),
    ]) ||
    value.sessionId !== id ||
    !iso(value.updatedAt) ||
    (flagged && !ownFlag(value.flagged)) ||
    (fetched && !fetchedList(value.fetched))
  )
    return false;
  if (value.taint === null) return true;
  return (
    exact(value.taint, ['level', 'since', 'sources']) &&
    value.taint.level === 'suspect' &&
    iso(value.taint.since) &&
    Array.isArray(value.taint.sources) &&
    value.taint.sources.length <= 4096 &&
    value.taint.sources.every(taintSource)
  );
}
async function directory(path: string): Promise<SessionTaintDirectory> {
  const canonical = resolve(path),
    s = await lstat(canonical, { bigint: true });
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    !owned(s) ||
    (s.mode & 0o777n) !== 0o700n ||
    (await realpath(canonical)) !== canonical
  )
    fail('session-taint-source-unavailable');
  return {
    path: canonical,
    dev: String(s.dev),
    ino: String(s.ino),
    uid: String(s.uid),
    mode: String(s.mode),
  };
}
/** Bounded private snapshot. It neither creates a session nor changes its native files. */
export async function captureSessionTaint(
  dir: string,
  sessionId: string,
): Promise<SessionTaintSnapshot> {
  if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 512)
    fail('session-taint-source-unavailable');
  const root = await directory(dir),
    path = join(root.path, `${sessionKey(sessionId)}.json`);
  let s: Info;
  try {
    s = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {
        sessionId,
        path,
        directory: root,
        pin: null,
        bytes: null,
        sha256: null,
        state: null,
      };
    throw error;
  }
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    !owned(s) ||
    s.nlink !== 1n ||
    (s.mode & 0o777n) !== 0o600n ||
    s.size > BigInt(SESSION_TAINT_MAX_BYTES)
  )
    fail('session-taint-source-unavailable');
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!isDeepStrictEqual(pin(await handle.stat({ bigint: true })), pin(s)))
      fail('session-taint-stale');
    const bytes = Buffer.alloc(Number(s.size));
    let filled = 0;
    while (filled < bytes.length) {
      const n = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!n.bytesRead) break;
      filled += n.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (
      filled !== bytes.length ||
      extra.bytesRead ||
      !isDeepStrictEqual(pin(await handle.stat({ bigint: true })), pin(s)) ||
      !isDeepStrictEqual(pin(await lstat(path, { bigint: true })), pin(s)) ||
      !isDeepStrictEqual(await directory(dir), root)
    )
      fail('session-taint-stale');
    const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed.ok) return fail('session-taint-source-unavailable');
    if (!state(parsed.value, sessionId)) return fail('session-taint-source-unavailable');
    return {
      sessionId,
      path,
      directory: root,
      pin: pin(s),
      bytes,
      sha256: hash(bytes),
      state: parsed.value,
    };
  } finally {
    await handle.close();
  }
}
function same(a: SessionTaintSnapshot, b: SessionTaintSnapshot) {
  return (
    a.path === b.path &&
    a.sessionId === b.sessionId &&
    a.sha256 === b.sha256 &&
    isDeepStrictEqual(a.pin, b.pin) &&
    isDeepStrictEqual(a.directory, b.directory)
  );
}
export function sessionTaintPublishedPin(value: SessionTaintPin): Omit<SessionTaintPin, 'ctimeNs'> {
  const { ctimeNs, ...rest } = value;
  return rest;
}
/**
 * Only taint is reset; provenance, trust, audit and other sessions are never written.
 *
 * A clear is refused without a person's confirmation and an audit sink. Out of the lock: the guard, the
 * staging of the clear, the durable recovery intent, the audit record, and the guard again. Under the lock
 * only: the session is read again, the clear published is the one of that read, and it is confirmed. A
 * hook that marked the session suspect in the meantime changed what is read under the lock, so the clear
 * is refused and the newer mark stands.
 */
export async function clearStoredSessionTaint(
  expected: SessionTaintSnapshot,
  hooks: SessionTaintClearHooks,
): Promise<SessionTaintSnapshot> {
  if (
    !expected.state?.taint ||
    !expected.bytes ||
    !expected.pin ||
    !expected.sha256 ||
    typeof hooks?.guard !== 'function' ||
    typeof hooks.beforePublish !== 'function'
  )
    fail('session-taint-stale');
  // Read once, then checked: what is checked is what is recorded.
  const given: unknown = hooks.confirmation,
    copy: unknown = given !== null && typeof given === 'object' ? { ...given } : given;
  if (typeof hooks.audit !== 'function' || !confirmed(copy)) fail('session-taint-unconfirmed');
  const confirmation = copy as SessionTaintClearConfirmation,
    beforeSha256 = expected.sha256 as string;
  const read = () => captureSessionTaint(expected.directory.path, expected.sessionId);
  const assert = async () => {
    await hooks.guard();
    if (!same(expected, await read())) fail('session-taint-stale');
  };
  await assert();
  try {
    const lock = await lstat(`${expected.path}.lock`, { bigint: true });
    if (!lock.isDirectory() || lock.isSymbolicLink() || !owned(lock))
      fail('session-taint-source-unavailable');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const at = (hooks.now ?? (() => new Date()))().toISOString(),
    bytes = Buffer.from(JSON.stringify({ ...expected.state, taint: null, updatedAt: at })),
    afterSha256 = hash(bytes);
  const temporary = join(
    expected.directory.path,
    `.${sessionKey(expected.sessionId)}.taint-clear-${randomUUID()}.tmp`,
  );
  let staged: SessionTaintPin | null = null,
    handle,
    renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    staged = pin(await handle.stat({ bigint: true }));
    await handle.writeFile(bytes);
    await handle.sync();
    staged = pin(await handle.stat({ bigint: true }));
    await handle.close();
    handle = undefined;
    const published: SessionTaintPin = staged;
    await assert();
    await hooks.beforePublish({
      sha256: afterSha256,
      pin: sessionTaintPublishedPin(published),
      bytes,
    });
    await hooks.audit({
      sessionId: expected.sessionId,
      beforeSha256,
      afterSha256,
      at,
      confirmation: { ...confirmation },
    });
    await assert();
    await hooks.fault?.('before-rename');
    const result = await withLock(`${expected.path}.lock`, async () => {
      const current = await read();
      if (!same(expected, current) || !current.state?.taint) fail('session-taint-stale');
      // The clear published is the one of the state read under the lock, not of an earlier read.
      const replacement = Buffer.from(
        JSON.stringify({ ...current.state, taint: null, updatedAt: at }),
      );
      if (!replacement.equals(bytes)) fail('session-taint-stale');
      if (!isDeepStrictEqual(pin(await lstat(temporary, { bigint: true })), published))
        fail('session-taint-stale');
      await rename(temporary, expected.path);
      renamed = true;
      const dir = await open(
        expected.directory.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      const after = await read();
      if (
        after.state?.taint !== null ||
        after.sha256 !== afterSha256 ||
        !after.pin ||
        !isDeepStrictEqual(sessionTaintPublishedPin(after.pin), sessionTaintPublishedPin(published))
      )
        fail('session-taint-write-unconfirmed');
      return after;
    });
    await hooks.fault?.('after-rename');
    await hooks.guard();
    return result;
  } catch (error) {
    if (renamed) fail('session-taint-write-unconfirmed');
    throw error;
  } finally {
    if (handle) {
      try {
        staged = pin(await handle.stat({ bigint: true }));
      } catch {
        /* Unknown descriptor state is not cleanup authority. */
      }
      await handle.close();
    }
    if (staged) {
      try {
        if (isDeepStrictEqual(pin(await lstat(temporary, { bigint: true })), staged))
          await unlink(temporary);
      } catch {
        /* Preserve foreign cleanup paths. */
      }
    }
  }
}
