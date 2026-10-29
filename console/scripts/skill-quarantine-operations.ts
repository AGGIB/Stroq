import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { captureSkill, type Root, type Scope } from './skill-quarantine-capture.ts';
import {
  canonicalRoot,
  checkDeadline,
  ensureVaultMarker,
  hash,
  inspectLocation,
  sameIdentity,
  writeManifest,
} from './skill-quarantine-paths.mjs';
import {
  LIMITATIONS,
  loadRecord,
  payloadRestoreBlock,
  readVault,
  recordEvidence,
  recordPath,
  rootBinding,
  vaultPath,
  type Manifest,
} from './skill-quarantine-vault.ts';
import { materialize } from './skill-quarantine-restore.ts';
import { inject, type Fault } from './skill-quarantine-faults.ts';
import { skillScopes } from './skill-quarantine-scopes.ts';
import { prepareSkillPlan, type Plan, type SkillPlanRequest } from './skill-quarantine-plan.ts';
export type { Plan } from './skill-quarantine-plan.ts';
import {
  assertSourceParents,
  quarantineEligibility,
  selectedPath,
  sourceFolder,
} from './skill-quarantine-source.ts';

export type Context = {
  roots: { project: Root; user: Root };
  workspaceId: string;
  deadline: number;
  commitGuard?: (strong?: boolean) => Promise<void>;
};
export async function context(
  project: string,
  userHome: string,
  deadline: number,
): Promise<Context> {
  checkDeadline(deadline);
  const roots = { project: await canonicalRoot(project), user: await canonicalRoot(userHome) };
  return { roots, workspaceId: `workspace-${hash(roots.project.path).slice(0, 24)}`, deadline };
}
export async function vaults(ctx: Context) {
  const project = skillScopes(ctx.roots.project.path, ctx.roots.user.path).includes('project')
    ? await readVault(ctx.roots.project, 'project', ctx.deadline)
    : { records: [], located: [], gaps: [], count: 0 };
  const user = await readVault(ctx.roots.user, 'user', ctx.deadline);
  return { project, user };
}
export async function readState(ctx: Context) {
  const result = await vaults(ctx);
  const gaps = [...result.project.gaps, ...result.user.gaps].slice(0, 64);
  const records = [...result.project.records, ...result.user.records];
  return {
    schema: 'stroq-skill-quarantine/2',
    source: 'local',
    generatedAt: new Date().toISOString(),
    workspaceId: ctx.workspaceId,
    available: gaps.length === 0,
    reason: gaps.length ? 'vault-unavailable' : null,
    records,
    gaps,
    limitations: LIMITATIONS,
  };
}
export async function preparePlan(
  ctx: Context,
  input: SkillPlanRequest,
  recordId: string,
  createdAt: string,
) {
  return prepareSkillPlan(ctx, await vaults(ctx), input, recordId, createdAt);
}
export function publicPreview(ctx: Context, plan: Plan, id: string, expiresAt: string) {
  return {
    schema: 'stroq-skill-quarantine-preview/2',
    id,
    source: 'local',
    workspaceId: ctx.workspaceId,
    expiresAt,
    action: plan.action,
    recordId: plan.recordId,
    artifact: plan.artifact,
    files: plan.files,
    bytes: plan.bytes,
    effect: plan.action === 'quarantine' ? 'remove-discovery-path' : 'restore-discovery-path',
    requiresNewSession: true,
    affectsAllWorkspaces: plan.scope === 'user',
    limitations: LIMITATIONS,
  };
}
function assertRoot(ctx: Context, plan: Plan) {
  if (!skillScopes(ctx.roots.project.path, ctx.roots.user.path).includes(plan.scope))
    throw new Error('quarantine-preview-stale');
  const root = ctx.roots[plan.scope];
  if (root.path !== plan.root.path || !sameIdentity(root, plan.root))
    throw new Error('quarantine-preview-stale');
  return root;
}
async function assertAbsent(root: Root, path: string) {
  try {
    if (await inspectLocation(root, path)) throw new Error('quarantine-conflict');
  } catch {
    throw new Error('quarantine-conflict');
  }
}
async function capturedSource(ctx: Context, plan: Plan) {
  const root = assertRoot(ctx, plan);
  let captured;
  try {
    await assertSourceParents(root, plan.scope, plan, plan.sourceParents, ctx.deadline);
    captured = await captureSkill(root, selectedPath(root, plan.scope, plan), ctx.deadline);
    if (
      (await quarantineEligibility(
        sourceFolder(root, plan.scope, plan.skillSource),
        plan.locator,
        captured.tree.entries,
        ctx.deadline,
      )) !== 'supported'
    )
      throw new Error('quarantine-preview-stale');
    await assertSourceParents(root, plan.scope, plan, plan.sourceParents, ctx.deadline);
  } catch (error) {
    if ((error as Error).message === 'deadline-exceeded') throw error;
    throw new Error('quarantine-preview-stale');
  }
  if (
    captured.sha256 !== plan.sha256 ||
    captured.files !== plan.files ||
    captured.bytes !== plan.bytes ||
    captured.sourceSha256 !== plan.sourceSha256 ||
    !sameIdentity(captured.identity, plan.sourceIdentity)
  )
    throw new Error('quarantine-preview-stale');
  return captured;
}
async function quarantine(ctx: Context, plan: Plan, fault: Fault) {
  const root = assertRoot(ctx, plan);
  const state = await readVault(root, plan.scope, ctx.deadline);
  if (state.gaps.length) throw new Error('quarantine-unavailable');
  if (state.count >= 32) throw new Error('quarantine-full');
  const source = selectedPath(root, plan.scope, plan);
  const captured = await capturedSource(ctx, plan);
  await ctx.commitGuard?.();
  await ensureVaultMarker(root, vaultPath(root));
  const directory = recordPath(root, plan.recordId);
  await assertAbsent(root, directory);
  const bucket = await inspectLocation(root, vaultPath(root), 'directory', true);
  if (!bucket) throw new Error('quarantine-unavailable');
  if (bucket.dev !== captured.identity.dev) throw new Error('quarantine-unsupported');
  checkDeadline(ctx.deadline);
  await mkdir(directory, { mode: 0o700 });
  await inspectLocation(root, directory, 'directory', true);
  const manifest: Manifest = {
    schema: 'stroq-skill-quarantine-record/2',
    id: plan.recordId,
    scope: plan.scope,
    name: plan.name,
    skillSource: plan.skillSource,
    locator: plan.locator,
    artifact: plan.artifact,
    createdAt: plan.createdAt,
    restoredAt: null,
    phase: 'prepared',
    files: plan.files,
    bytes: plan.bytes,
    rootBinding: rootBinding(root),
  };
  const manifestPath = join(directory, 'manifest.json');
  let intent = false;
  try {
    const manifestSha = await writeManifest(root, manifestPath, manifest);
    intent = true;
    await inject(fault, 'after-intent');
    await capturedSource(ctx, plan);
    await assertAbsent(root, join(directory, 'payload'));
    await inspectLocation(root, directory, 'directory', true);
    checkDeadline(ctx.deadline);
    await ctx.commitGuard?.();
    await rename(source, join(directory, 'payload'));
    await inject(fault, 'after-move');
    await assertAbsent(root, source);
    const payload = await captureSkill(root, join(directory, 'payload'), ctx.deadline);
    if (
      payload.sha256 !== plan.sha256 ||
      payload.files !== plan.files ||
      payload.bytes !== plan.bytes
    )
      throw new Error('quarantine-recovery-required');
    await inject(fault, 'before-final-manifest');
    checkDeadline(ctx.deadline);
    await ctx.commitGuard?.();
    await writeManifest(root, manifestPath, { ...manifest, phase: 'quarantined' }, manifestSha);
    if (
      (await recordEvidence(await loadRecord(root, plan.scope, plan.recordId), ctx.deadline))
        .status !== 'quarantined'
    )
      throw new Error('quarantine-recovery-required');
  } catch (error) {
    if (intent) throw new Error('quarantine-recovery-required');
    throw error;
  }
}
async function restore(ctx: Context, plan: Plan, fault: Fault) {
  const root = assertRoot(ctx, plan);
  const record = await loadRecord(root, plan.scope, plan.recordId);
  if (record.manifestSha !== plan.manifestSha) throw new Error('quarantine-preview-stale');
  const evidence = await recordEvidence(record, ctx.deadline);
  if (
    evidence.status !== 'quarantined' &&
    !(
      evidence.status === 'recovery-required' &&
      evidence.original === 'absent' &&
      evidence.payload === 'match'
    )
  )
    throw new Error(
      evidence.status === 'recovery-required'
        ? 'quarantine-recovery-required'
        : 'quarantine-conflict',
    );
  const payload = await captureSkill(root, join(record.directory, 'payload'), ctx.deadline);
  if (payloadRestoreBlock(payload.tree.entries)) throw new Error('quarantine-unsupported');
  if (payload.sha256 !== plan.sha256 || payload.sourceSha256 !== plan.sourceSha256)
    throw new Error('quarantine-preview-stale');
  try {
    await assertSourceParents(root, plan.scope, plan, plan.sourceParents, ctx.deadline, true);
  } catch {
    throw new Error('quarantine-preview-stale');
  }
  const source = selectedPath(root, plan.scope, plan);
  await assertAbsent(root, source);
  checkDeadline(ctx.deadline);
  const intent = { ...record.manifest, phase: 'restoring' as const };
  await ctx.commitGuard?.();
  const manifestSha = await writeManifest(root, record.manifestPath, intent, record.manifestSha);
  try {
    await inject(fault, 'after-intent');
    await materialize(
      root,
      source,
      record.directory,
      payload.tree,
      payload.directories,
      ctx.deadline,
      fault,
      { scope: plan.scope, selected: plan, parents: plan.sourceParents },
      ctx.commitGuard,
    );
    const restored = await captureSkill(root, source, ctx.deadline);
    const retained = await captureSkill(root, join(record.directory, 'payload'), ctx.deadline);
    if (restored.sha256 !== plan.sha256 || retained.sha256 !== plan.sha256)
      throw new Error('quarantine-recovery-required');
    await inject(fault, 'before-final-manifest');
    checkDeadline(ctx.deadline);
    await ctx.commitGuard?.();
    await writeManifest(
      root,
      record.manifestPath,
      { ...intent, phase: 'restored', restoredAt: new Date().toISOString() },
      manifestSha,
    );
    if (
      (await recordEvidence(await loadRecord(root, plan.scope, plan.recordId), ctx.deadline))
        .status !== 'restored'
    )
      throw new Error('quarantine-recovery-required');
  } catch {
    throw new Error('quarantine-recovery-required');
  }
}
export async function applyPlan(ctx: Context, plan: Plan, previewId: string, fault: Fault = null) {
  if (plan.action === 'quarantine') await quarantine(ctx, plan, fault);
  else await restore(ctx, plan, fault);
  return {
    schema: 'stroq-skill-quarantine-receipt/2',
    source: 'local',
    workspaceId: ctx.workspaceId,
    id: previewId,
    recordId: plan.recordId,
    action: plan.action,
    artifact: plan.artifact,
    completedAt: new Date().toISOString(),
    status: plan.action === 'quarantine' ? 'quarantined' : 'restored',
    effect: plan.action === 'quarantine' ? 'remove-discovery-path' : 'restore-discovery-path',
    evidence: 'discovery-path',
    requiresNewSession: true,
    reviewBaselineChanged: false,
    hostEnforcement: false,
  };
}
