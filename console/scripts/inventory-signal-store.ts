import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseJsonDocument } from '../../packages/cli/src/harden/json-doc.ts';
import {
  validateInventorySignalRecord,
  type InventorySignalRecord,
} from '../lib/inventory-signal-decision.ts';
import { safeLocation } from './inventory-safe.mjs';

export type SignalRecord = InventorySignalRecord;
type Pin = {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
};
type Location = { anchor: string; anchorPin: Pin; home: Pin | null; console: Pin | null };
type Raw = {
  kind: 'missing' | 'text' | 'unavailable';
  revision: string | null;
  text?: string;
  location: Location | null;
  file: Pin | null;
};
export type SignalStore = {
  status: 'missing' | 'ready' | 'unavailable';
  records: SignalRecord[];
  raw: Raw;
};
export const MAX_SIGNAL_STORE_RECORDS = 512;
export const MAX_SIGNAL_STORE_BYTES = 512 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const workspace = (value: unknown): value is string =>
  typeof value === 'string' && /^workspace-[a-f0-9]{24}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const owned = (value: { uid: number }) =>
  typeof process.getuid !== 'function' || value.uid === process.getuid();
const pin = (value: Pin): Pin => ({
  dev: value.dev,
  ino: value.ino,
  mode: value.mode,
  uid: value.uid,
  size: value.size,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
  nlink: value.nlink,
});
const sameDirectory = (a: Pin | null, b: Pin | null): boolean =>
  a === null || b === null
    ? a === b
    : a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
const sameFile = (a: Pin | null, b: Pin | null): boolean =>
  sameDirectory(a, b) &&
  (a === null ||
    b === null ||
    (a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs &&
      a.nlink === b.nlink));
const sameLocation = (a: Location | null, b: Location | null): boolean =>
  a === null || b === null
    ? a === b
    : a.anchor === b.anchor &&
      sameDirectory(a.anchorPin, b.anchorPin) &&
      sameDirectory(a.home, b.home) &&
      sameDirectory(a.console, b.console);
function unavailable(): never {
  throw new Error('signal-store-unavailable');
}
function conflict(): never {
  throw new Error('signal-conflict');
}
function validRecord(value: unknown, workspaceId: string): value is SignalRecord {
  return (
    validateInventorySignalRecord(value) &&
    value.binding.workspaceId === workspaceId &&
    new Date(value.recordedAt).getTime() <= Date.now()
  );
}
function safeDirectory(value: Stats) {
  return (
    value.isDirectory() && !value.isSymbolicLink() && owned(value) && (value.mode & 0o022) === 0
  );
}
async function location(home: string): Promise<Location> {
  let anchor = home;
  for (;;) {
    try {
      const stat = await lstat(anchor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(anchor)) !== anchor)
        unavailable();
      const root = anchor === home ? pin(stat) : null;
      if (root && !safeDirectory(stat)) unavailable();
      let consolePin: Pin | null = null;
      if (root) {
        try {
          const consoleStat = await lstat(join(home, 'console'));
          if (!safeDirectory(consoleStat)) unavailable();
          consolePin = pin(consoleStat);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return { anchor, anchorPin: pin(stat), home: root, console: consolePin };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(anchor);
      if (parent === anchor) unavailable();
      anchor = parent;
    }
  }
}
async function readBytes(handle: FileHandle, length: number): Promise<Buffer | null> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(bytes, offset, length - offset, offset);
    if (read.bytesRead === 0) return null;
    offset += read.bytesRead;
  }
  const extra = await handle.read(Buffer.alloc(1), 0, 1, length);
  return extra.bytesRead === 0 ? bytes : null;
}
async function readRaw(home: string, workspaceId: string): Promise<Raw> {
  let captured: Location | null = null;
  let namedPin: Pin | null = null;
  let handle: FileHandle | undefined;
  try {
    captured = await location(home);
    const file = join(home, 'console', `inventory-signals-${workspaceId}.json`);
    const located = await safeLocation(home, file);
    if (located.kind === 'missing') {
      if (!sameLocation(captured, await location(home))) unavailable();
      return { kind: 'missing', revision: null, location: captured, file: null };
    }
    if (located.kind !== 'ok' || !located.stat) unavailable();
    namedPin = pin(located.stat);
    if (
      !owned(namedPin) ||
      (namedPin.mode & 0o7777) !== 0o600 ||
      namedPin.size > MAX_SIGNAL_STORE_BYTES
    )
      unavailable();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(namedPin, pin(stat))) unavailable();
    const bytes = await readBytes(handle, stat.size);
    const after = await handle.stat();
    const named = await safeLocation(home, file);
    if (
      !bytes ||
      !sameFile(pin(stat), pin(after)) ||
      named.kind !== 'ok' ||
      !named.stat ||
      !sameFile(pin(stat), pin(named.stat)) ||
      !sameLocation(captured, await location(home))
    )
      unavailable();
    return {
      kind: 'text',
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      revision: hash(bytes),
      location: captured,
      file: pin(stat),
    };
  } catch {
    return { kind: 'unavailable', revision: null, location: captured, file: namedPin };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
/** Read-only: absent stores are observed without creating their parents. */
export async function readSignalStore(
  home: string,
  workspaceId: string,
  contextSha256: string,
): Promise<SignalStore> {
  if (!workspace(workspaceId) || !digest(contextSha256))
    return {
      status: 'unavailable',
      records: [],
      raw: { kind: 'unavailable', revision: null, location: null, file: null },
    };
  const raw = await readRaw(home, workspaceId);
  if (raw.kind === 'missing') return { status: 'missing', records: [], raw };
  try {
    if (raw.kind !== 'text' || raw.text === undefined) unavailable();
    const parsed = parseJsonDocument(raw.text);
    if (!parsed.ok) unavailable();
    const value = parsed.doc;
    if (
      !exact(value, ['schema', 'workspaceId', 'contextSha256', 'records']) ||
      value.schema !== 'stroq-inventory-signal-store/1' ||
      value.workspaceId !== workspaceId ||
      value.contextSha256 !== contextSha256 ||
      !Array.isArray(value.records) ||
      value.records.length > MAX_SIGNAL_STORE_RECORDS ||
      !value.records.every((entry) => validRecord(entry, workspaceId)) ||
      new Set(value.records.map((entry) => (entry as SignalRecord).id)).size !==
        value.records.length
    )
      unavailable();
    return { status: 'ready', records: value.records as SignalRecord[], raw };
  } catch {
    return { status: 'unavailable', records: [], raw };
  }
}
export function storeRevision(store: SignalStore): string | null {
  return store.status === 'ready' ? store.raw.revision : null;
}
/** Append position is authoritative; timestamps never reorder decision history. */
export function latestSignalRecords(store: SignalStore): SignalRecord[] {
  const latest = new Map<string, SignalRecord>();
  for (const record of store.records) latest.set(record.binding.itemId, record);
  return [...latest.values()];
}
async function assertStore(
  home: string,
  workspaceId: string,
  contextSha256: string,
  before: SignalStore,
) {
  const fresh = await readSignalStore(home, workspaceId, contextSha256);
  if (
    fresh.status !== before.status ||
    fresh.raw.kind !== before.raw.kind ||
    fresh.raw.revision !== before.raw.revision ||
    !sameLocation(fresh.raw.location, before.raw.location) ||
    !sameFile(fresh.raw.file, before.raw.file)
  )
    conflict();
  return fresh;
}
/** The parent holds inventory.lock through the source recheck, rename and verified readback. */
export async function appendSignalRecord(
  home: string,
  workspaceId: string,
  contextSha256: string,
  before: SignalStore,
  record: SignalRecord,
  beforeRename: () => Promise<void>,
): Promise<SignalStore> {
  if (
    !workspace(workspaceId) ||
    !digest(contextSha256) ||
    before.status === 'unavailable' ||
    !validRecord(record, workspaceId)
  )
    unavailable();
  const current = await assertStore(home, workspaceId, contextSha256, before);
  if (current.records.some((entry) => entry.id === record.id)) unavailable();
  if (current.records.length >= MAX_SIGNAL_STORE_RECORDS) throw new Error('signal-store-full');
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 'stroq-inventory-signal-store/1',
      workspaceId,
      contextSha256,
      records: [...current.records, record],
    }) + '\n',
  );
  if (bytes.length > MAX_SIGNAL_STORE_BYTES) throw new Error('signal-store-full');
  const pinned = await location(home);
  if (pinned.home === null || pinned.console === null) unavailable();
  const file = join(home, 'console', `inventory-signals-${workspaceId}.json`);
  const temporary = join(home, 'console', `.inventory-signals-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let created: Pin | null = null;
  let sourceError: unknown;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    created = pin(await handle.stat());
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    const staged = pin(await handle.stat());
    try {
      await beforeRename();
    } catch (error) {
      sourceError = error;
      throw error;
    }
    await assertStore(home, workspaceId, contextSha256, before);
    if (!sameLocation(pinned, await location(home))) conflict();
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !sameFile(staged, pin(stat)) ||
      stat.size !== bytes.length
    )
      conflict();
    const verified = await readBytes(handle, bytes.length);
    const afterRead = await handle.stat();
    const named = await safeLocation(home, temporary);
    if (
      !verified?.equals(bytes) ||
      !sameFile(staged, pin(afterRead)) ||
      named.kind !== 'ok' ||
      !named.stat ||
      !sameFile(staged, pin(named.stat)) ||
      !sameLocation(pinned, await location(home))
    )
      conflict();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    const after = await readSignalStore(home, workspaceId, contextSha256);
    if (
      after.status !== 'ready' ||
      after.raw.revision !== hash(bytes) ||
      !sameDirectory(staged, after.raw.file) ||
      !sameLocation(pinned, after.raw.location)
    )
      conflict();
    return after;
  } catch (error) {
    if (
      sourceError === error ||
      (error instanceof Error &&
        ['signal-conflict', 'signal-store-unavailable', 'signal-store-full'].includes(
          error.message,
        ))
    )
      throw error;
    return unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
    try {
      if (sameLocation(pinned, await location(home))) {
        const named = await safeLocation(home, temporary);
        if (named.kind === 'ok' && named.stat && sameDirectory(created, pin(named.stat)))
          await unlink(temporary);
      }
    } catch {
      /* Substituted parents or files are never followed during cleanup. */
    }
  }
}
