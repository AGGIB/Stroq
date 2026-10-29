import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MCP_CONTAINMENT_LIMITATIONS,
  type McpContainmentArtifact,
  type McpContainmentPreviewRequest,
  type McpContainmentState,
} from '../lib/mcp-containment.ts';
import { resolveMcpArtifactById, readMcpSource, type McpSource } from './mcp-sources.ts';
import {
  canonicalRoot,
  binding,
  deadline,
  ensureMarker,
  hash,
  inspect,
  MAX_STORE,
  writeExclusive,
  writeManifest,
} from './mcp-containment-files.mjs';
import {
  payloads,
  publicArtifact,
  readRecord,
  readVault,
  recordEvidence,
  recordPath,
  sourceFor,
  vaultPath,
  type Context,
} from './mcp-containment-vault.ts';
import {
  assertWritable,
  inject,
  removalCandidate,
  protectionCandidate,
  replaceConfig,
  restoreCandidate,
  type Capture,
} from './mcp-containment-config.ts';

import {
  changeOf,
  proxyOf,
  changedEntrySha,
  type CurrentManifest,
} from './mcp-containment-manifest.ts';
import {
  publicProxy,
  strictProxyEntry,
  type StoredProxy,
  type ProxyRuntime,
} from './mcp-containment-proxy.ts';
import { assertUniqueToolReviewBinding } from './mcp-tool-contract-unique.ts';

export type Plan = {
  action: McpContainmentPreviewRequest['action'];
  change: 'remove-registration' | 'protect-registration';
  proxy: StoredProxy | null;
  changedEntrySha256: string | null;
  recordId: string;
  createdAt: string;
  workspaceId: string;
  artifact: McpContainmentArtifact;
  name: string;
  sourceType: McpSource['source'];
  relativePath: string;
  sourceRootBinding: string;
  userBinding: string;
  vaultBinding: string | null;
  manifestSha: string | null;
  configSha256: string;
  fileIdentity: Capture['fileIdentity'];
  mode: number;
  candidateMode: number;
  candidateSha256: string;
  bytes: number;
  siblings: number;
  reformatted: boolean;
};
export async function context(
  project: string,
  userHome: string,
  platform: NodeJS.Platform,
  until: number,
  environment: Readonly<Record<string, string | undefined>> = {},
  runtime: ProxyRuntime | null = null,
): Promise<Context> {
  const a = await canonicalRoot(project),
    b = await canonicalRoot(userHome);
  return {
    project: a,
    user: b,
    workspaceId: `workspace-${hash(a.path).slice(0, 24)}`,
    platform,
    deadline: until,
    environment,
    runtime,
  };
}
export async function readState(
  ctx: Context,
  runtimeAvailable: boolean,
): Promise<McpContainmentState> {
  const retained = await readVault(ctx);
  const reason = !['darwin', 'linux'].includes(ctx.platform)
    ? 'platform-unsupported'
    : retained.gaps.length
      ? 'storage-unavailable'
      : !runtimeAvailable
        ? 'runtime-unavailable'
        : null;
  return {
    schema: 'stroq-mcp-containment/2',
    source: 'local',
    generatedAt: new Date().toISOString(),
    workspaceId: ctx.workspaceId,
    available: reason === null,
    reason,
    records: retained.records,
    gaps: retained.gaps,
    limitations: [...MCP_CONTAINMENT_LIMITATIONS],
  };
}
async function registration(
  ctx: Context,
  input: Extract<
    McpContainmentPreviewRequest,
    { action: 'remove-registration' | 'protect-registration' }
  >,
) {
  const captured = await resolveMcpArtifactById({
    project: ctx.project.path,
    userHome: ctx.user.path,
    platform: ctx.platform,
    environment: ctx.environment,
    id: input.id,
    expectedSha256: input.expectedSha256,
    deadline: ctx.deadline,
  });
  if (captured.applicability !== 'supported') throw new Error('mcp-containment-unsupported');
  if (!captured.name.length || captured.name.length > 512)
    throw new Error('mcp-containment-unsupported');
  await assertWritable(captured, captured);
  const artifact = publicArtifact(captured, captured.name, captured.entrySha256);
  const proxy: StoredProxy | null =
    input.action === 'protect-registration'
      ? {
          mode: 'strict',
          policyWorkspaceId: ctx.workspaceId,
          cwd: ctx.project.path,
          runtime: ctx.runtime!,
          ...(input.toolApproval ? { toolApproval: true as const } : {}),
        }
      : null;
  if (proxy && (!ctx.runtime || artifact.name !== captured.name))
    throw new Error('mcp-containment-unsupported');
  if (proxy?.toolApproval)
    await assertUniqueToolReviewBinding(
      {
        project: ctx.project.path,
        userHome: ctx.user.path,
        home: proxy.runtime.home,
        cli: proxy.runtime.entry,
        platform: ctx.platform,
        mcpEnvironment: ctx.environment,
      },
      strictProxyEntry(captured.entry, captured.name, captured.agent, proxy).entry,
      captured.file,
    );
  return {
    source: captured,
    captured,
    artifact,
    name: captured.name,
    candidate: proxy
      ? protectionCandidate(captured, captured.name, captured.agent, proxy)
      : removalCandidate(captured, captured.name, artifact.sha256),
    proxy,
    record: null,
  };
}
async function restoration(ctx: Context, id: string) {
  const record = await readRecord(ctx, id),
    source = await sourceFor(ctx, record.manifest);
  const retained = await payloads(ctx, record);
  if (retained.status !== 'match') throw new Error('mcp-containment-conflict');
  const captured = await readMcpSource(source);
  await assertWritable(source, captured);
  return {
    source,
    captured,
    artifact: record.manifest.artifact,
    name: record.manifest.name,
    candidate: await restoreCandidate(ctx, record, captured),
    proxy: proxyOf(record.manifest),
    record,
  };
}
export async function preparePlan(
  ctx: Context,
  input: McpContainmentPreviewRequest,
  id: string,
  createdAt: string,
) {
  deadline(ctx.deadline);
  if (!['darwin', 'linux'].includes(ctx.platform)) throw new Error('mcp-containment-unsupported');
  const retained = await readVault(ctx);
  if (retained.gaps.length || retained.records.some((record) => record.payload !== 'match'))
    throw new Error('mcp-containment-unavailable');
  if (input.action !== 'restore-registration' && retained.count >= 32)
    throw new Error('mcp-containment-full');
  const prepared =
    input.action !== 'restore-registration'
      ? await registration(ctx, input)
      : await restoration(ctx, input.recordId);
  if (
    input.action !== 'restore-registration' &&
    retained.bytes + prepared.captured.byteLength + prepared.candidate.bytes.length + 16 * 1024 >
      MAX_STORE
  )
    throw new Error('mcp-containment-full');
  const { source, captured, artifact, name, candidate, record } = prepared;
  const plan: Plan = {
    action: input.action,
    change: record
      ? changeOf(record.manifest)
      : (input.action as 'remove-registration' | 'protect-registration'),
    proxy: prepared.proxy,
    changedEntrySha256: record
      ? changedEntrySha(record.manifest)
      : 'changedEntrySha256' in candidate
        ? (candidate.changedEntrySha256 as string)
        : null,
    recordId: record?.manifest.id ?? id,
    createdAt,
    workspaceId: ctx.workspaceId,
    artifact,
    name,
    sourceType: source.source,
    relativePath: source.relativePath,
    sourceRootBinding: binding(source.root),
    userBinding: binding(ctx.user),
    vaultBinding: retained.vaultBinding,
    manifestSha: record?.manifestSha ?? null,
    configSha256: captured.sha256,
    fileIdentity: captured.fileIdentity,
    mode: captured.mode,
    candidateMode: candidate.mode,
    candidateSha256: candidate.sha256,
    bytes: captured.byteLength,
    siblings: candidate.siblings,
    reformatted: candidate.reformatted,
  };
  return { plan, prepared };
}
export function publicPreview(ctx: Context, plan: Plan, id: string, expiresAt: string) {
  return {
    schema: 'stroq-mcp-containment-preview/2',
    source: 'local',
    id,
    recordId: plan.recordId,
    workspaceId: ctx.workspaceId,
    action: plan.action,
    proxy: publicProxy(plan.proxy),
    createdAt: plan.createdAt,
    expiresAt,
    artifact: plan.artifact,
    configSha256: plan.configSha256,
    candidateSha256: plan.candidateSha256,
    bytes: plan.bytes,
    siblings: plan.siblings,
    reformatted: plan.reformatted,
    effect: plan.action,
    evidence: 'configuration',
    hostEnforcement: false,
    requiresAcknowledgement: true,
    retention: { unencrypted: true, maxRecords: 32, maxBytes: MAX_STORE, automaticDeletion: false },
    limitations: [...MCP_CONTAINMENT_LIMITATIONS],
  };
}
async function applyChange(
  ctx: Context,
  plan: Plan,
  prepared: Awaited<ReturnType<typeof registration>>,
  fault: string | null,
) {
  const retained = await readVault(ctx);
  if (
    retained.gaps.length ||
    retained.count >= 32 ||
    retained.vaultBinding !== plan.vaultBinding ||
    retained.bytes + prepared.captured.byteLength + prepared.candidate.bytes.length + 16 * 1024 >
      MAX_STORE
  )
    throw new Error('mcp-containment-preview-stale');
  await ensureMarker(ctx.user, vaultPath(ctx));
  const vault = await inspect(ctx.user, vaultPath(ctx), 'directory', true);
  if (!vault) throw new Error('mcp-containment-unavailable');
  const directory = recordPath(ctx, plan.recordId);
  if (await inspect(ctx.user, directory)) throw new Error('mcp-containment-conflict');
  await mkdir(directory, { mode: 0o700 });
  await inspect(ctx.user, directory, 'directory', true);
  const manifest: CurrentManifest = {
    schema: 'stroq-mcp-containment-record/2',
    id: plan.recordId,
    name: plan.name,
    artifact: plan.artifact,
    originWorkspaceId: ctx.workspaceId,
    sourceType: plan.sourceType,
    relativePath: plan.relativePath,
    sourceRootBinding: plan.sourceRootBinding,
    userBinding: binding(ctx.user),
    vaultBinding: binding({ path: vaultPath(ctx), ino: vault.ino, dev: vault.dev }),
    beforeSha256: plan.configSha256,
    changedSha256: plan.candidateSha256,
    change: plan.change,
    changedEntrySha256: plan.changedEntrySha256,
    proxy: plan.proxy,
    beforeBytes: prepared.captured.byteLength,
    changedBytes: prepared.candidate.bytes.length,
    mode: plan.mode,
    createdAt: plan.createdAt,
    restoredAt: null,
    phase: 'prepared',
  };
  let intent = false;
  try {
    await writeExclusive(ctx.user, join(directory, 'before.json'), prepared.captured.bytes);
    await writeExclusive(ctx.user, join(directory, 'changed.json'), prepared.candidate.bytes);
    await inject(fault, 'after-backup');
    const manifestPath = join(directory, 'manifest.json');
    const sha = await writeManifest(ctx.user, manifestPath, manifest);
    intent = true;
    await inject(fault, 'after-intent');
    await replaceConfig(ctx, prepared.source, prepared.captured, prepared.candidate, fault);
    if ((await payloads(ctx, await readRecord(ctx, plan.recordId))).status !== 'match')
      throw new Error('mcp-containment-recovery-required');
    await inject(fault, 'before-final-manifest');
    await writeManifest(
      ctx.user,
      manifestPath,
      { ...manifest, phase: plan.change === 'protect-registration' ? 'configured' : 'removed' },
      sha,
    );
    await inject(fault, 'before-final-evidence');
    const finalEvidence = await recordEvidence(ctx, await readRecord(ctx, plan.recordId));
    if (
      finalEvidence.status !==
        (plan.change === 'protect-registration' ? 'configured' : 'removed') ||
      finalEvidence.configSha256 !== plan.candidateSha256
    )
      throw new Error('mcp-containment-recovery-required');
  } catch (error) {
    if (intent) throw new Error('mcp-containment-recovery-required');
    throw error;
  }
}
async function applyRestore(
  ctx: Context,
  plan: Plan,
  prepared: Awaited<ReturnType<typeof restoration>>,
  fault: string | null,
) {
  const record = prepared.record;
  if (record.manifestSha !== plan.manifestSha) throw new Error('mcp-containment-preview-stale');
  let intent = false;
  try {
    const sha = await writeManifest(
      ctx.user,
      record.manifestPath,
      { ...record.manifest, phase: 'restoring', restoredAt: null },
      record.manifestSha,
    );
    intent = true;
    await inject(fault, 'after-intent');
    await replaceConfig(ctx, prepared.source, prepared.captured, prepared.candidate, fault);
    if ((await payloads(ctx, await readRecord(ctx, plan.recordId))).status !== 'match')
      throw new Error('mcp-containment-recovery-required');
    await inject(fault, 'before-final-manifest');
    await writeManifest(
      ctx.user,
      record.manifestPath,
      { ...record.manifest, phase: 'restored', restoredAt: new Date().toISOString() },
      sha,
    );
    await inject(fault, 'before-final-evidence');
    const finalEvidence = await recordEvidence(ctx, await readRecord(ctx, plan.recordId));
    if (finalEvidence.status !== 'restored' || finalEvidence.configSha256 !== plan.candidateSha256)
      throw new Error('mcp-containment-recovery-required');
  } catch (error) {
    if (intent) throw new Error('mcp-containment-recovery-required');
    throw error;
  }
}
export async function applyPlan(ctx: Context, plan: Plan, previewId: string, fault: string | null) {
  if (!plan || plan.workspaceId !== ctx.workspaceId || plan.userBinding !== binding(ctx.user))
    throw new Error('mcp-containment-preview-stale');
  const request: McpContainmentPreviewRequest =
    plan.action !== 'restore-registration'
      ? {
          action: plan.action,
          id: plan.artifact.id,
          expectedSha256: plan.artifact.sha256,
          ...(plan.action === 'protect-registration' && plan.proxy?.toolApproval
            ? { toolApproval: true as const }
            : {}),
        }
      : { action: 'restore-registration', recordId: plan.recordId };
  const fresh = await preparePlan(ctx, request, plan.recordId, plan.createdAt);
  if (JSON.stringify(fresh.plan) !== JSON.stringify(plan))
    throw new Error('mcp-containment-preview-stale');
  if (plan.action !== 'restore-registration')
    await applyChange(ctx, plan, fresh.prepared as Awaited<ReturnType<typeof registration>>, fault);
  else
    await applyRestore(ctx, plan, fresh.prepared as Awaited<ReturnType<typeof restoration>>, fault);
  return {
    schema: 'stroq-mcp-containment-receipt/2',
    source: 'local',
    previewId,
    recordId: plan.recordId,
    workspaceId: ctx.workspaceId,
    artifact: plan.artifact,
    action: plan.action,
    status:
      plan.action === 'remove-registration'
        ? 'removed'
        : plan.action === 'protect-registration'
          ? 'configured'
          : 'restored',
    proxy: publicProxy(plan.proxy),
    effect: plan.action,
    completedAt: new Date().toISOString(),
    configSha256: plan.candidateSha256,
    evidence: 'configuration',
    hostEnforcement: false,
    reviewBaselineChanged: false,
    requiresClientRestart: true,
  };
}
