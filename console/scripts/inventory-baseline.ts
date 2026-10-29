import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redact } from '@stroq/core';
import { parseJsonDocument } from '../../packages/cli/src/harden/json-doc.ts';
import { validateInventoryEvidence, type InventoryEvidence } from '../lib/inventory-evidence.ts';
import { safeLocation } from './inventory-safe.mjs';
import { safeInventoryName } from './skill-sources.ts';
import { skillSourceOf, type SkillSourceId } from '../lib/skill-sources.ts';

export type InventoryMeta = {
  id: string;
  kind: 'skill' | 'mcp';
  name: string;
  agent: 'claude-code' | 'claude-desktop' | 'cursor' | 'windsurf' | 'codex' | 'shared';
  scope: 'project' | 'user';
  fileType: 'skill-tree' | 'mcp-config';
  skillSource?: SkillSourceId;
};
export type InventoryStored = InventoryMeta & {
  sha256: string;
  reviewedAt: string | null;
  evidence: InventoryEvidence | null;
};
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
  kind: 'missing' | 'text' | 'invalid';
  revision: string | null;
  text?: string;
  location: Location | null;
  file: Pin | null;
};
export type InventoryBaseline = {
  status: 'missing' | 'ready' | 'invalid';
  reviewedAt: string | null;
  entries: InventoryStored[];
  raw: Raw;
};
export const MAX_INVENTORY_BASELINE_BYTES = 8 * 1024 * 1024;
export const MAX_INVENTORY_BASELINE_ENTRIES = 512;
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))
    return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
};
const owned = (v: { uid: number }) =>
  typeof process.getuid !== 'function' || v.uid === process.getuid();
const pin = (s: Pin): Pin => ({
  dev: s.dev,
  ino: s.ino,
  mode: s.mode,
  uid: s.uid,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
  nlink: s.nlink,
});
const sameDirectory = (a: Pin | null, b: Pin | null) =>
  a === null || b === null
    ? a === b
    : a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
const sameFile = (a: Pin | null, b: Pin | null) =>
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
function fail(): never {
  throw new Error('baseline-invalid');
}
function conflict(): never {
  throw new Error('review-conflict');
}

async function location(home: string): Promise<Location> {
  let anchor = home;
  for (;;) {
    try {
      const stat = await lstat(anchor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(anchor)) !== anchor)
        fail();
      const root = anchor === home ? pin(stat) : null;
      if (root && !owned(root)) fail();
      let consolePin: Pin | null = null;
      if (root) {
        try {
          const s = await lstat(join(home, 'console'));
          if (!s.isDirectory() || s.isSymbolicLink() || !owned(s)) fail();
          consolePin = pin(s);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return { anchor, anchorPin: pin(stat), home: root, console: consolePin };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(anchor);
      if (parent === anchor) fail();
      anchor = parent;
    }
  }
}
async function readRaw(home: string, workspace: string): Promise<Raw> {
  let captured: Location | null = null;
  let namedPin: Pin | null = null;
  let handle;
  try {
    captured = await location(home);
    const file = join(home, 'console', `inventory-${workspace}.json`);
    const located = await safeLocation(home, file);
    if (located.kind === 'missing') {
      if (!sameLocation(captured, await location(home))) fail();
      return { kind: 'missing', revision: null, location: captured, file: null };
    }
    if (located.kind !== 'ok' || !located.stat) fail();
    namedPin = pin(located.stat);
    if (!owned(namedPin) || namedPin.size > MAX_INVENTORY_BASELINE_BYTES) fail();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(namedPin, pin(stat))) fail();
    const bytes = Buffer.alloc(stat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    const named = await safeLocation(home, file);
    if (
      read.bytesRead !== bytes.length ||
      extra.bytesRead !== 0 ||
      !sameFile(pin(stat), pin(after)) ||
      named.kind !== 'ok' ||
      !named.stat ||
      !sameFile(pin(stat), pin(named.stat)) ||
      !sameLocation(captured, await location(home))
    )
      fail();
    return {
      kind: 'text',
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      revision: hash(bytes),
      location: captured,
      file: pin(stat),
    };
  } catch {
    return { kind: 'invalid', revision: null, location: captured, file: namedPin };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
const META_KEYS = ['id', 'kind', 'name', 'agent', 'scope', 'fileType', 'sha256'];
function validMeta(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === 'string' &&
    /^item-[a-f0-9]{24}$/.test(v.id) &&
    digest(v.sha256) &&
    ['skill', 'mcp'].includes(String(v.kind)) &&
    (v.kind === 'skill'
      ? skillSourceOf({
          kind: String(v.kind),
          agent: String(v.agent),
          skillSource: v.skillSource,
        }) !== null
      : !Object.hasOwn(v, 'skillSource') &&
        ['claude-code', 'cursor', 'windsurf', 'claude-desktop'].includes(String(v.agent))) &&
    ['project', 'user'].includes(String(v.scope)) &&
    typeof v.name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(v.name) &&
    redact(v.name) === v.name &&
    !/[A-Za-z0-9_-]{32}/.test(v.name) &&
    v.fileType === (v.kind === 'skill' ? 'skill-tree' : 'mcp-config')
  );
}
function validEntry(v: unknown, workspace: string, version: 1 | 2 | 3): v is InventoryStored {
  const keys = version === 1 ? META_KEYS : [...META_KEYS, 'reviewedAt', 'evidence'];
  const withSource = version === 3 && object(v) && Object.hasOwn(v, 'skillSource');
  if (!exact(v, withSource ? [...keys, 'skillSource'] : keys) || !validMeta(v)) return false;
  if (version === 1) return true;
  if (v.evidence === null) return v.reviewedAt === null;
  if (!time(v.reviewedAt) || !validateInventoryEvidence(v.evidence)) return false;
  const evidence = v.evidence;
  if (
    [
      evidence.artifact.name,
      ...evidence.files.map((file) => file.label),
      ...evidence.matches.map((match) => match.title),
    ].some((value) => redact(value) !== value)
  )
    return false;
  return (
    evidence.workspaceId === workspace &&
    skillSourceOf(evidence.artifact) ===
      skillSourceOf({ kind: String(v.kind), agent: String(v.agent), skillSource: v.skillSource }) &&
    evidence.artifact.sha256 === v.sha256 &&
    evidence.capture.completedAt <= v.reviewedAt &&
    ['id', 'kind', 'name', 'agent', 'scope'].every(
      (key) => evidence.artifact[key as keyof typeof evidence.artifact] === v[key],
    ) &&
    evidence.scan.status !== 'incomplete'
  );
}
/** Projection used by inventory snapshots; retained evidence is never spread into public items. */
export function inventoryMeta(v: InventoryMeta): InventoryMeta {
  return {
    id: v.id,
    kind: v.kind,
    name: v.name,
    agent: v.agent,
    scope: v.scope,
    fileType: v.fileType,
    ...(v.skillSource === undefined ? {} : { skillSource: v.skillSource }),
  };
}
export async function readInventoryBaseline(
  home: string,
  workspace: string,
): Promise<InventoryBaseline> {
  const raw = await readRaw(home, workspace);
  if (raw.kind === 'missing') return { status: 'missing', reviewedAt: null, entries: [], raw };
  try {
    if (raw.kind !== 'text' || raw.text === undefined) fail();
    const parsed = parseJsonDocument(raw.text);
    if (!parsed.ok) fail();
    const value = parsed.doc;
    if (
      !exact(value, ['schema', 'workspace', 'reviewedAt', 'entries']) ||
      value.workspace !== workspace ||
      !time(value.reviewedAt) ||
      !Array.isArray(value.entries) ||
      value.entries.length > MAX_INVENTORY_BASELINE_ENTRIES
    )
      fail();
    const version =
      value.schema === 'stroq-inventory-baseline/1'
        ? 1
        : value.schema === 'stroq-inventory-baseline/2'
          ? 2
          : value.schema === 'stroq-inventory-baseline/3'
            ? 3
            : null;
    if (
      version === null ||
      (version >= 2 &&
        (raw.file === null ||
          (raw.file.mode & 0o777) !== 0o600 ||
          value.reviewedAt > new Date().toISOString())) ||
      !value.entries.every(
        (entry) =>
          validEntry(entry, workspace, version) &&
          (version === 1 ||
            entry.reviewedAt === null ||
            entry.reviewedAt <= (value.reviewedAt as string)),
      ) ||
      new Set(value.entries.map((entry) => (entry as InventoryStored).id)).size !==
        value.entries.length
    )
      fail();
    const entries = value.entries.map((entry) => {
      const typed = entry as InventoryStored;
      return {
        ...inventoryMeta(typed),
        sha256: typed.sha256,
        name: safeInventoryName(
          typed.name,
          `${typed.kind === 'skill' ? 'Skill' : 'MCP server'} ${typed.id.slice(-8)}`,
        ),
        reviewedAt: version === 1 ? null : typed.reviewedAt,
        evidence: version === 1 ? null : typed.evidence,
      };
    });
    return { status: 'ready', reviewedAt: value.reviewedAt, entries, raw };
  } catch {
    return { status: 'invalid', reviewedAt: null, entries: [], raw };
  }
}
export async function assertInventoryBaseline(
  home: string,
  workspace: string,
  before: InventoryBaseline,
) {
  const fresh = await readRaw(home, workspace);
  if (
    fresh.kind !== before.raw.kind ||
    fresh.revision !== before.raw.revision ||
    !sameLocation(fresh.location, before.raw.location) ||
    !sameFile(fresh.file, before.raw.file)
  )
    conflict();
}
/** Existing review lock is held by the parent for staging, source recheck, rename and readback. */
export async function writeInventoryBaseline(
  home: string,
  workspace: string,
  before: InventoryBaseline,
  entries: InventoryStored[],
  reviewedAt: string,
  beforeRename: () => Promise<void>,
) {
  if (entries.length > MAX_INVENTORY_BASELINE_ENTRIES) throw new Error('review-incomplete');
  if (
    before.status === 'invalid' ||
    !time(reviewedAt) ||
    !entries.every(
      (entry) =>
        validEntry(entry, workspace, 3) &&
        (entry.reviewedAt === null || entry.reviewedAt <= reviewedAt),
    ) ||
    new Set(entries.map((entry) => entry.id)).size !== entries.length
  )
    fail();
  const bytes = Buffer.from(
    JSON.stringify({ schema: 'stroq-inventory-baseline/3', workspace, reviewedAt, entries }) + '\n',
  );
  if (bytes.length > MAX_INVENTORY_BASELINE_BYTES) throw new Error('review-incomplete');
  if (before.raw.file && (before.raw.file.mode & 0o200) === 0) fail();
  await assertInventoryBaseline(home, workspace, before);
  const pinned = await location(home);
  if (
    pinned.home === null ||
    pinned.console === null ||
    (pinned.home.mode & 0o022) !== 0 ||
    (pinned.console.mode & 0o022) !== 0
  )
    fail();
  const file = join(home, 'console', `inventory-${workspace}.json`);
  const temporary = join(home, 'console', `.inventory-${randomUUID()}.tmp`);
  let handle;
  let created: Pin | null = null;
  let staged: Pin | null = null;
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
    staged = pin(await handle.stat());
    await beforeRename();
    await assertInventoryBaseline(home, workspace, before);
    if (!sameLocation(pinned, await location(home))) conflict();
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !sameFile(staged, pin(stat)) ||
      stat.size !== bytes.length
    )
      conflict();
    // Read only the bounded staged size, through the same descriptor that wrote it.
    const verified = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < verified.length) {
      const read = await handle.read(verified, offset, verified.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const afterRead = await handle.stat();
    const named = await safeLocation(home, temporary);
    if (
      offset !== bytes.length ||
      extra.bytesRead !== 0 ||
      !verified.equals(bytes) ||
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
    const after = await readInventoryBaseline(home, workspace);
    if (
      after.status !== 'ready' ||
      after.raw.revision !== hash(bytes) ||
      !sameDirectory(staged, after.raw.file) ||
      !sameLocation(pinned, after.raw.location)
    )
      conflict();
    return after;
  } finally {
    await handle?.close().catch(() => undefined);
    try {
      if (sameLocation(pinned, await location(home))) {
        const named = await safeLocation(home, temporary);
        if (named.kind === 'ok' && named.stat && sameDirectory(created, pin(named.stat)))
          await unlink(temporary);
      }
    } catch {
      /* A substituted directory or file is never followed during cleanup. */
    }
  }
}
