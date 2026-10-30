import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  deepEqual,
  isObject,
  parseJsonDocument,
  removeAt,
  serializeJson,
  setAt,
} from '../../packages/cli/src/harden/json-doc.ts';
import { mcpEntryMetadata, readMcpSource, type McpSource } from './mcp-sources.ts';
import { deadline, hash, inspect, MAX_CONFIG, same } from './mcp-containment-files.mjs';
import type { Context, Located } from './mcp-containment-vault.ts';
import { payloads } from './mcp-containment-vault.ts';
import { changeOf, changedEntrySha } from './mcp-containment-manifest.ts';
import { strictProxyEntry, type StoredProxy } from './mcp-containment-proxy.ts';

export type Capture = Awaited<ReturnType<typeof readMcpSource>>;
export async function inject(fault: string | null, point: string) {
  if (fault === 'pause-before-final-evidence' && point === 'before-final-evidence')
    await new Promise((done) => setTimeout(done, 2000));
  if (fault === 'pause-after-intent' && point === 'after-intent')
    await new Promise((done) => setTimeout(done, 15_000));
  if (fault === point) throw new Error('fixture-interruption');
}
export async function assertWritable(source: McpSource, capture: Capture) {
  const stat = await lstat(source.file);
  if (
    !same(stat, capture.fileIdentity) ||
    (stat.mode & 0o777) !== capture.mode ||
    !(capture.mode & 0o200) ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('mcp-containment-conflict');
}
export function sameCapture(a: Capture, b: Capture) {
  return (
    a.sha256 === b.sha256 &&
    a.mode === b.mode &&
    JSON.stringify(a.fileIdentity) === JSON.stringify(b.fileIdentity)
  );
}
function checked(
  candidate: Buffer,
  before: Capture,
  name: string,
  restoring: boolean,
  expectedEntrySha: string,
) {
  if (!candidate.length || candidate.length > MAX_CONFIG)
    throw new Error('mcp-containment-unsupported');
  const parsed = parseJsonDocument(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(candidate),
  );
  if (
    !parsed.ok ||
    !Object.hasOwn(parsed.doc, 'mcpServers') ||
    !isObject(parsed.doc.mcpServers) ||
    !deepEqual(
      removeAt(before.doc, ['mcpServers', name]),
      removeAt(parsed.doc, ['mcpServers', name]),
    ) ||
    (restoring
      ? !Object.hasOwn(parsed.doc.mcpServers, name) ||
        mcpEntryMetadata(parsed.doc.mcpServers[name]).sha256 !== expectedEntrySha
      : Object.hasOwn(parsed.doc.mcpServers, name))
  )
    throw new Error('mcp-containment-unavailable');
  return candidate;
}
export function removalCandidate(capture: Capture, name: string, sha256: string) {
  if (
    !Object.hasOwn(capture.doc, 'mcpServers') ||
    !isObject(capture.doc.mcpServers) ||
    !Object.hasOwn(capture.doc.mcpServers, name)
  )
    throw new Error('mcp-containment-conflict');
  const siblings = Object.keys(capture.doc.mcpServers).length - 1;
  if (siblings > 512) throw new Error('mcp-containment-unsupported');
  const bytes = checked(
    Buffer.from(serializeJson(removeAt(capture.doc, ['mcpServers', name]), capture.layout)),
    capture,
    name,
    false,
    sha256,
  );
  return {
    bytes,
    sha256: hash(bytes),
    mode: capture.mode,
    siblings,
    reformatted: !capture.roundTrips,
  };
}
export function protectionCandidate(
  capture: Capture,
  name: string,
  client: string,
  proxy: StoredProxy,
) {
  if (!isObject(capture.doc.mcpServers) || !Object.hasOwn(capture.doc.mcpServers, name))
    throw new Error('mcp-containment-conflict');
  const siblings = Object.keys(capture.doc.mcpServers).length - 1;
  if (siblings > 512) throw new Error('mcp-containment-unsupported');
  const guarded = strictProxyEntry(capture.doc.mcpServers[name], name, client, proxy);
  const bytes = checked(
    Buffer.from(
      serializeJson(setAt(capture.doc, ['mcpServers', name], guarded.entry), capture.layout),
    ),
    capture,
    name,
    true,
    guarded.sha256,
  );
  return {
    bytes,
    sha256: hash(bytes),
    mode: capture.mode,
    siblings,
    reformatted: !capture.roundTrips,
    changedEntrySha256: guarded.sha256,
  };
}
export async function restoreCandidate(ctx: Context, record: Located, capture: Capture) {
  const m = record.manifest;
  if (
    !Object.hasOwn(capture.doc, 'mcpServers') ||
    !isObject(capture.doc.mcpServers) ||
    (changeOf(m) === 'remove-registration'
      ? Object.hasOwn(capture.doc.mcpServers, m.name)
      : !Object.hasOwn(capture.doc.mcpServers, m.name) ||
        mcpEntryMetadata(capture.doc.mcpServers[m.name]).sha256 !== changedEntrySha(m))
  )
    throw new Error('mcp-containment-conflict');
  const siblings =
    Object.keys(capture.doc.mcpServers).length - Number(changeOf(m) === 'protect-registration');
  if (siblings > 512) throw new Error('mcp-containment-unsupported');
  const retained = await payloads(ctx, record);
  if (retained.status !== 'match' || !retained.before || !retained.removed)
    throw new Error('mcp-containment-conflict');
  const exact = capture.bytes.equals(retained.removed.bytes);
  const entry = retained.before.parsed.doc.mcpServers;
  if (!isObject(entry) || !Object.hasOwn(entry, m.name))
    throw new Error('mcp-containment-conflict');
  const bytes = exact
    ? retained.before.bytes
    : Buffer.from(
        serializeJson(setAt(capture.doc, ['mcpServers', m.name], entry[m.name]!), capture.layout),
      );
  return {
    bytes: checked(bytes, capture, m.name, true, m.artifact.sha256),
    sha256: hash(bytes),
    mode: exact ? m.mode : capture.mode,
    siblings,
    reformatted: exact ? false : !capture.roundTrips,
  };
}
/** Recheck before staging and immediately before rename; never roll a changed source back. */
export async function replaceConfig(
  ctx: Context,
  source: McpSource,
  before: Capture,
  candidate: { bytes: Buffer; mode: number },
  fault: string | null,
) {
  await assertWritable(source, before);
  if (!sameCapture(before, await readMcpSource(source)))
    throw new Error('mcp-containment-preview-stale');
  const parent = await inspect(source.root, dirname(source.file));
  if (!parent) throw new Error('mcp-containment-conflict');
  const temporary = join(dirname(source.file), `.stroq-mcp-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(candidate.bytes);
    await handle.chmod(candidate.mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await inject(fault, 'before-rename');
    deadline(ctx.deadline);
    if (
      !sameCapture(before, await readMcpSource(source)) ||
      !same(parent, await inspect(source.root, dirname(source.file)))
    )
      throw new Error('mcp-containment-preview-stale');
    await rename(temporary, source.file);
    await inject(fault, 'after-rename');
    const after = await readMcpSource(source);
    if (!after.bytes.equals(candidate.bytes) || after.mode !== candidate.mode)
      throw new Error('mcp-containment-recovery-required');
  } finally {
    await handle?.close();
    try {
      if (
        same(parent, await inspect(source.root, dirname(source.file))) &&
        (await inspect(source.root, temporary, 'file'))
      )
        await unlink(temporary);
    } catch {
      /* Preserve unsafe substituted paths. */
    }
  }
}
