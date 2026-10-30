import { opendir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  sessionKey,
  sessionTaintPublishedPin,
  type SessionTaintClearRecord,
  type SessionTaintPin,
} from '@stroq/core';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import {
  validateSessionTaintInspection,
  type SessionTaintInspection,
} from '../lib/session-taint.ts';
import { atomicWrite, rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { hash, fail, same } from './task-lock-files.ts';
import type { TaintBinding, TaintOptions } from './session-taint-inspect.ts';
import { validTaintPrivate } from './session-taint-private.ts';

export interface TaintEntry {
  schema: 'stroq-session-taint-private/1';
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'prepared' | 'cleared' | 'unchanged' | 'uncertain';
  before: SessionTaintInspection;
  binding: TaintBinding;
  staged: { sha256: string; pin: Omit<SessionTaintPin, 'ctimeNs'> };
  published: SessionTaintPin | null;
  /** The clear and the person's confirmation, recorded before publication; null until then. */
  audit: SessionTaintClearRecord | null;
}
export interface TaintStored {
  entry: TaintEntry;
  revision: string;
  path: string;
}
const MAX = 512 * 1024,
  BUDGET = 8 * 1024 * 1024,
  UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const owned = (v: { uid: number }) =>
  typeof process.getuid !== 'function' || v.uid === process.getuid();
const pack = (entry: TaintEntry) => {
  const { bytes, state, ...native } = entry.binding.native;
  return Buffer.from(
    JSON.stringify({
      ...entry,
      binding: { ...entry.binding, native },
      backup: Buffer.from(bytes!).toString('base64'),
    }) + '\n',
  );
};
async function context(options: TaintOptions) {
  const path = join(options.home, 'console', 'session-taint');
  let at = options.home;
  for (;;) {
    try {
      await lstat(at);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw error;
      at = dirname(at);
    }
  }
  const root = await rootIdentity(at),
    marker = await snapshotFile(root, join(path, '.gitignore'), 2);
  if (
    marker.directories.some(
      (d) =>
        !owned(d) ||
        (d.mode & 0o022) !== 0 ||
        ((d.path === options.home || d.path.startsWith(options.home + '/')) &&
          (d.mode & 0o777) !== 0o700),
    ) ||
    (marker.file && (!owned(marker.file) || (marker.file.mode & 0o777) !== 0o600)) ||
    (marker.bytes && !marker.bytes.equals(Buffer.from('*\n')))
  )
    fail('history-unavailable');
  return { path, root, marker };
}
function parse(bytes: Buffer, id: string, options: TaintOptions): TaintEntry {
  const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !parsed.ok ||
    parsed.value === null ||
    typeof parsed.value !== 'object' ||
    Array.isArray(parsed.value)
  )
    fail('history-unavailable');
  const v = (parsed as { ok: true; value: Record<string, any> }).value;
  if (
    Object.keys(v).sort().join(',') !==
      'audit,backup,before,binding,createdAt,id,published,schema,staged,status,updatedAt' ||
    v.schema !== 'stroq-session-taint-private/1' ||
    v.id !== id ||
    !UUID.test(id) ||
    !validateSessionTaintInspection(v.before) ||
    !['prepared', 'cleared', 'unchanged', 'uncertain'].includes(v.status) ||
    typeof v.backup !== 'string' ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    new Date(v.createdAt).toISOString() !== v.createdAt ||
    !Number.isFinite(Date.parse(v.updatedAt)) ||
    new Date(v.updatedAt).toISOString() !== v.updatedAt ||
    v.updatedAt < v.createdAt ||
    v.createdAt < v.before.checkedAt ||
    !v.binding ||
    typeof v.binding.sessionId !== 'string' ||
    !v.binding.native ||
    !v.staged ||
    !v.staged.pin ||
    !v.staged.sha256 ||
    v.binding.native.sessionId !== v.binding.sessionId ||
    `session-${hash(v.binding.sessionId)}` !== v.before.sessionRef ||
    v.binding.native.path !==
      join(options.home, 'sessions', sessionKey(v.binding.sessionId) + '.json') ||
    v.binding.native.sha256 !== v.before.taint.sha256 ||
    v.binding.provenance === null
  )
    fail('history-unavailable');
  const backup = Buffer.from(v.backup, 'base64');
  if (
    backup.length > 256 * 1024 ||
    backup.toString('base64') !== v.backup ||
    hash(backup) !== v.before.taint.sha256
  )
    fail('history-unavailable');
  const native = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(backup));
  if (
    !native.ok ||
    native.value === null ||
    typeof native.value !== 'object' ||
    Array.isArray(native.value) ||
    (native.value as any).sessionId !== v.binding.sessionId ||
    !(native.value as any).taint
  )
    fail('history-unavailable');
  if (!validTaintPrivate(v, backup, (native as { ok: true; value: unknown }).value, options))
    fail('history-unavailable');
  const { backup: _backup, ...entry } = v;
  entry.binding = {
    ...v.binding,
    native: { ...v.binding.native, bytes: backup, state: native.value },
  };
  return entry as TaintEntry;
}
async function privateFile(root: any, path: string, max: number) {
  const s = await snapshotFile(root, path, max);
  if (!s.file || !s.bytes || !owned(s.file) || (s.file.mode & 0o777) !== 0o600)
    fail('history-unavailable');
  return s;
}
export async function readTaintHistory(options: TaintOptions) {
  try {
    const loc = await context(options);
    let listing;
    try {
      listing = await opendir(loc.path, { bufferSize: 4 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          ...loc,
          records: [] as TaintStored[],
          count: 0,
          staging: 0,
          bytes: 0,
          reserved: 0,
        };
      throw error;
    }
    const records: TaintStored[] = [];
    let count = 0,
      staging = 0,
      bytes = loc.marker.bytes?.length ?? 0,
      reserved = bytes;
    for await (const file of listing) {
      if (file.name === '.gitignore') continue;
      if (!file.isFile()) fail('history-unavailable');
      const temporary = /^\.stroq-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/.test(
          file.name,
        ),
        id = file.name.slice(0, -5);
      if (temporary ? ++staging > 32 : ++count > 32) fail('history-unavailable');
      if (!temporary && (!UUID.test(id) || !file.name.endsWith('.json') || !loc.marker.bytes))
        fail('history-unavailable');
      const path = join(loc.path, file.name),
        source = await privateFile(loc.root, path, MAX);
      const entry = temporary ? null : parse(source.bytes!, id, options);
      const reservation = entry
        ? Math.ceil(entry.binding.native.bytes!.length / 3) * 8 + 32768
        : source.bytes!.length;
      // Unpublished temporaries are never updated or adopted. Their exact bounded
      // retained bytes consume capacity without inventing a future metadata reserve.
      if (entry && source.bytes!.length * 2 > reservation) fail('history-unavailable');
      bytes += source.bytes!.length;
      reserved += reservation;
      if (bytes > BUDGET) fail('history-unavailable');
      if (entry) records.push({ entry, revision: source.sha256, path });
    }
    return { ...loc, records, count, staging, bytes, reserved };
  } catch (error) {
    if ((error as Error).message === 'deadline-exceeded') throw error;
    fail('history-unavailable');
  }
}
export async function syncTaintDirectory(path: string) {
  const before = await rootIdentity(path),
    h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const s = await h.stat();
    if (s.dev !== before.dev || s.ino !== before.ino) fail('write-unconfirmed');
    await h.sync();
  } finally {
    await h.close();
  }
}
export async function writeTaintEntry(
  options: TaintOptions,
  entry: TaintEntry,
  expected: string | null,
  guard: () => Promise<void>,
) {
  const vault = await readTaintHistory(options),
    path = join(vault.path, entry.id + '.json'),
    bytes = pack(entry);
  const reserved = Math.ceil(entry.binding.native.bytes!.length / 3) * 8 + 32768;
  if (
    bytes.length > MAX ||
    bytes.length * 2 > reserved ||
    vault.staging >= 32 ||
    vault.bytes + bytes.length + (vault.marker.bytes === null ? 2 : 0) > BUDGET
  )
    fail('recovery-full');
  if (expected === null && (vault.count >= 32 || vault.reserved + reserved + 2 > BUDGET))
    fail('recovery-full');
  if (vault.marker.bytes === null)
    await atomicWrite(
      vault.root,
      join(vault.path, '.gitignore'),
      Buffer.from('*\n'),
      vault.marker,
      0o600,
      {
        fault: async (stage?: string) => {
          if (stage === 'before-rename') await guard();
        },
      },
    );
  const before = await snapshotFile(vault.root, path, MAX);
  if (expected === null ? before.file !== null : before.sha256 !== expected) fail('stale-state');
  parse(bytes, entry.id, options);
  await guard();
  await atomicWrite(vault.root, path, bytes, before, 0o600, {
    fault: async (stage?: string) => {
      if (stage === 'before-rename') await guard();
    },
  });
  await syncTaintDirectory(vault.path);
  const fresh = await privateFile(vault.root, path, MAX);
  if (!fresh.bytes!.equals(bytes)) fail('write-unconfirmed');
  return { entry, revision: fresh.sha256, path };
}
