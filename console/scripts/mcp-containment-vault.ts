import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isObject,
  parseJsonDocument,
  removeAt,
  deepEqual,
} from '../../packages/cli/src/harden/json-doc.ts';
import {
  validateMcpContainmentArtifact,
  type McpContainmentArtifact,
  type McpContainmentRecord,
} from '../lib/mcp-containment.ts';
import {
  discoverMcpSources,
  readMcpSource,
  mcpArtifact,
  mcpEntryMetadata,
  type McpRoot,
  type McpSource,
} from './mcp-sources.ts';
import {
  UUID,
  validManifest,
  changeOf,
  proxyOf,
  changedSha,
  changedBytes,
  changedFile,
  changedEntrySha,
  type Manifest,
} from './mcp-containment-manifest.ts';
import {
  strictProxyEntry,
  publicProxy,
  sameRuntime,
  type ProxyRuntime,
} from './mcp-containment-proxy.ts';
export type { Manifest } from './mcp-containment-manifest.ts';
import {
  binding,
  hash,
  inspect,
  readPrivate,
  deadline,
  MAX_STORE,
} from './mcp-containment-files.mjs';

export type Context = {
  project: McpRoot;
  user: McpRoot;
  workspaceId: string;
  platform: NodeJS.Platform;
  deadline: number;
  environment: Readonly<Record<string, string | undefined>>;
  runtime: ProxyRuntime | null;
};
export type Located = {
  manifest: Manifest;
  directory: string;
  manifestPath: string;
  manifestSha: string;
};
export const vaultPath = (ctx: Context) =>
  join(ctx.user.path, '.stroq', 'console', 'mcp-containment');
export const recordPath = (ctx: Context, id: string) => join(vaultPath(ctx), id);
export const sourceConfig = (source: McpSource) =>
  source.source === 'claude-desktop-manual'
    ? ('claude-desktop-user' as const)
    : (source.source as McpContainmentArtifact['configSource']);
export function publicArtifact(
  source: McpSource,
  name: string,
  sha256: string,
): McpContainmentArtifact {
  const artifact = {
    ...mcpArtifact(source, name, sha256),
    kind: 'mcp' as const,
    digestFormat: 'mcp-entry-canonical-json/1' as const,
    configSource: sourceConfig(source),
  };
  if (!validateMcpContainmentArtifact(artifact)) throw new Error('mcp-containment-unsupported');
  return artifact as McpContainmentArtifact;
}
export async function readRecord(ctx: Context, id: string): Promise<Located> {
  if (!UUID.test(id)) throw new Error('mcp-containment-conflict');
  const vault = await inspect(ctx.user, vaultPath(ctx), 'directory', true),
    directory = recordPath(ctx, id);
  if (!vault || !(await inspect(ctx.user, directory, 'directory', true)))
    throw new Error('record-invalid');
  const manifestPath = join(directory, 'manifest.json'),
    read = await readPrivate(ctx.user, manifestPath, 16 * 1024);
  if (!read) throw new Error('record-invalid');
  let manifest: unknown;
  try {
    const parsed = parseJsonDocument(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes),
    );
    if (!parsed.ok) throw new Error('record-invalid');
    manifest = parsed.doc;
  } catch {
    throw new Error('record-invalid');
  }
  if (!validManifest(manifest, ctx, id, { path: vaultPath(ctx), ino: vault.ino, dev: vault.dev }))
    throw new Error('record-invalid');
  const names = await opendir(directory);
  try {
    for await (const entry of names) {
      deadline(ctx.deadline);
      if (!['manifest.json', 'before.json', changedFile(manifest)].includes(entry.name))
        throw new Error('record-invalid');
    }
  } finally {
    await names.close().catch(() => undefined);
  }
  return { manifest, directory, manifestPath, manifestSha: read.sha256 };
}
export async function payloads(ctx: Context, record: Located) {
  try {
    const before = await readPrivate(ctx.user, join(record.directory, 'before.json'));
    const removed = await readPrivate(
      ctx.user,
      join(record.directory, changedFile(record.manifest)),
    );
    if (!before || !removed) return { status: 'missing' as const, before: null, removed: null };
    if (
      before.sha256 !== record.manifest.beforeSha256 ||
      removed.sha256 !== changedSha(record.manifest) ||
      before.bytes.length !== record.manifest.beforeBytes ||
      removed.bytes.length !== changedBytes(record.manifest)
    )
      return { status: 'changed' as const, before: null, removed: null };
    const decode = (bytes: Uint8Array) =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const a = parseJsonDocument(decode(before.bytes)),
      b = parseJsonDocument(decode(removed.bytes));
    if (
      !a.ok ||
      !b.ok ||
      !Object.hasOwn(a.doc, 'mcpServers') ||
      !isObject(a.doc.mcpServers) ||
      !Object.hasOwn(a.doc.mcpServers, record.manifest.name) ||
      !Object.hasOwn(b.doc, 'mcpServers') ||
      !isObject(b.doc.mcpServers) ||
      (changeOf(record.manifest) === 'remove-registration'
        ? Object.hasOwn(b.doc.mcpServers, record.manifest.name)
        : !Object.hasOwn(b.doc.mcpServers, record.manifest.name) ||
          mcpEntryMetadata(b.doc.mcpServers[record.manifest.name]).sha256 !==
            changedEntrySha(record.manifest) ||
          !deepEqual(
            strictProxyEntry(
              a.doc.mcpServers[record.manifest.name],
              record.manifest.name,
              record.manifest.artifact.agent,
              proxyOf(record.manifest)!,
            ).entry,
            b.doc.mcpServers[record.manifest.name]!,
          )) ||
      mcpEntryMetadata(a.doc.mcpServers[record.manifest.name]).sha256 !==
        record.manifest.artifact.sha256 ||
      !deepEqual(
        removeAt(a.doc, ['mcpServers', record.manifest.name]),
        removeAt(b.doc, ['mcpServers', record.manifest.name]),
      )
    )
      return { status: 'changed' as const, before: null, removed: null };
    return {
      status: 'match' as const,
      before: { ...before, parsed: a },
      removed: { ...removed, parsed: b },
    };
  } catch {
    return { status: 'unverifiable' as const, before: null, removed: null };
  }
}
export async function sourceFor(ctx: Context, manifest: Manifest) {
  if (manifest.artifact.scope === 'project' && manifest.originWorkspaceId !== ctx.workspaceId)
    throw new Error('mcp-containment-conflict');
  const sources = await discoverMcpSources({
    project: ctx.project.path,
    userHome: ctx.user.path,
    platform: ctx.platform,
    environment: ctx.environment,
    deadline: ctx.deadline,
  });
  const source = sources.find(
    (s) =>
      s.source === manifest.sourceType &&
      s.relativePath === manifest.relativePath &&
      s.agent === manifest.artifact.agent &&
      s.scope === manifest.artifact.scope,
  );
  if (
    !source ||
    source.applicability !== 'supported' ||
    binding(source.root) !== manifest.sourceRootBinding
  )
    throw new Error('mcp-containment-conflict');
  return source;
}
export async function recordEvidence(ctx: Context, record: Located): Promise<McpContainmentRecord> {
  deadline(ctx.deadline);
  const manifest = record.manifest,
    retained = await payloads(ctx, record);
  let slot: McpContainmentRecord['slot'] = 'unverifiable',
    configSha256: string | null = null,
    sourceMatchesChange: boolean | null = null,
    configMissing = false;
  try {
    const source = await sourceFor(ctx, manifest),
      captured = await readMcpSource(source);
    if (!Object.hasOwn(captured.doc, 'mcpServers') || !isObject(captured.doc.mcpServers))
      throw new Error();
    configSha256 = captured.sha256;
    sourceMatchesChange = configSha256 === changedSha(manifest);
    slot = !Object.hasOwn(captured.doc.mcpServers, manifest.name)
      ? 'absent'
      : mcpEntryMetadata(captured.doc.mcpServers[manifest.name]).sha256 === manifest.artifact.sha256
        ? 'same'
        : changedEntrySha(manifest) !== null &&
            mcpEntryMetadata(captured.doc.mcpServers[manifest.name]).sha256 ===
              changedEntrySha(manifest)
          ? 'guarded'
          : 'different';
  } catch (error) {
    configMissing = (error as Error).message === 'mcp-source-missing';
  }
  const unresolved = manifest.phase === 'prepared' || manifest.phase === 'restoring';
  const foreign =
    manifest.artifact.scope === 'project' && manifest.originWorkspaceId !== ctx.workspaceId;
  const status = foreign
    ? 'unverifiable'
    : unresolved
      ? 'recovery-required'
      : retained.status !== 'match'
        ? 'changed'
        : configMissing
          ? 'config-missing'
          : slot === 'unverifiable'
            ? 'unverifiable'
            : manifest.phase === 'restored'
              ? slot === 'same'
                ? 'restored'
                : 'changed'
              : changeOf(manifest) === 'protect-registration'
                ? slot === 'guarded'
                  ? 'configured'
                  : 'changed'
                : slot === 'absent'
                  ? 'removed'
                  : 'reappeared';
  return {
    id: manifest.id,
    artifact: manifest.artifact,
    change: changeOf(manifest),
    changedEntrySha256: changedEntrySha(manifest),
    proxy:
      proxyOf(manifest) === null
        ? null
        : {
            ...publicProxy(proxyOf(manifest))!,
            runtimeMatches:
              ctx.runtime === null ? null : sameRuntime(ctx.runtime, proxyOf(manifest)!.runtime),
          },
    originWorkspaceId: manifest.originWorkspaceId,
    phase: manifest.phase === 'restoring' ? 'recovery-required' : manifest.phase,
    createdAt: manifest.createdAt,
    restoredAt: manifest.restoredAt,
    checkedAt: new Date().toISOString(),
    status,
    slot,
    payload: retained.status,
    sourceMatchesChange,
    configSha256,
  };
}
export async function readVault(ctx: Context) {
  const records: McpContainmentRecord[] = [],
    located: Located[] = [];
  const gaps: { code: 'vault-unavailable' | 'vault-limit' | 'record-invalid' | 'storage-limit' }[] =
    [];
  let count = 0,
    bytes = 0,
    vaultBinding: string | null = null;
  try {
    const vault = await inspect(ctx.user, vaultPath(ctx), 'directory', true);
    if (!vault) return { records, located, gaps, count, bytes, vaultBinding };
    vaultBinding = binding({ path: vaultPath(ctx), ...vault });
    if (
      !(await readPrivate(ctx.user, join(vaultPath(ctx), '.gitignore'), 16))?.bytes.equals(
        Buffer.from('*\n'),
      )
    )
      throw new Error('record-invalid');
    const names = await opendir(vaultPath(ctx));
    try {
      for await (const entry of names) {
        deadline(ctx.deadline);
        if (entry.name === '.gitignore') continue;
        if (++count > 32) {
          gaps.push({ code: 'vault-limit' });
          break;
        }
        try {
          const record = await readRecord(ctx, entry.name);
          bytes +=
            record.manifest.beforeBytes +
            changedBytes(record.manifest) +
            (await readPrivate(ctx.user, record.manifestPath, 16 * 1024))!.bytes.length;
          if (bytes > MAX_STORE) {
            gaps.push({ code: 'storage-limit' });
            break;
          }
          const evidence = await recordEvidence(ctx, record);
          located.push(record);
          records.push(evidence);
          if (evidence.payload !== 'match') gaps.push({ code: 'record-invalid' });
        } catch (error) {
          if ((error as Error).message === 'deadline-exceeded') throw error;
          gaps.push({ code: 'record-invalid' });
        }
      }
    } finally {
      await names.close().catch(() => undefined);
    }
  } catch (error) {
    if ((error as Error).message === 'deadline-exceeded') throw error;
    gaps.push({ code: 'vault-unavailable' });
  }
  const uniqueGaps = [...new Map(gaps.map((gap) => [gap.code, gap])).values()];
  return { records, located, gaps: uniqueGaps, count, bytes, vaultBinding };
}
