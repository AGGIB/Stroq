import {
  applyPreparedPlanUnderManifestLock,
  applyPreparedUndoUnderManifestLock,
  prepareApply,
  prepareUndo,
  type PreparedApply,
  type PreparedUndo,
  type HardenEnv,
} from '../../packages/cli/src/harden/index.ts';
import { readTargetSnapshot } from '../../packages/cli/src/harden/read.ts';
import { assertPreparedBinding } from '../../packages/cli/src/harden/prepared-state.ts';
import { needsOf } from '../../packages/cli/src/commands/harden-view.ts';
import {
  CREDENTIAL_FILTER_LIMITATIONS,
  CREDENTIAL_FILTER_RETENTION,
  CREDENTIAL_FILTER_TARGETS,
  type CredentialFilterTarget,
  type CredentialFilterAction,
  type CredentialFilterPreview,
  type CredentialFilterReceipt,
  type CredentialFiltersState,
} from '../lib/credential-filters.ts';
import {
  hash,
  resolveCredentialTargets,
  assertTargetContext,
} from './credential-filter-targets.mjs';
import {
  inspectFilter,
  unavailableRow,
  safeError,
  presentItems,
} from './credential-filter-inspect.ts';
import type { CredentialResolverOptions, CredentialResolution } from './credential-filter-types.ts';

export type Options = CredentialResolverOptions & { version: string; deadline: number };
export type PrivatePlan = {
  action: CredentialFilterAction;
  target: CredentialFilterTarget;
  resolved: CredentialResolution;
  prepared: PreparedApply | PreparedUndo;
  body: CredentialFilterPreview;
};
const deadline = (options: Options) => {
  if (Date.now() >= options.deadline) throw new Error('deadline-exceeded');
};
const envOf = (options: Options): HardenEnv => ({
  home: options.home,
  now: () => new Date(),
  version: options.version,
});
const targetOf = (resolved: CredentialResolution, id: CredentialFilterTarget) => {
  const target = resolved.targets.find((value) => value.id === id);
  if (!target || !Object.hasOwn(CREDENTIAL_FILTER_TARGETS, id)) throw new Error('invalid-request');
  return target;
};
export async function filterState(
  options: Options,
  runtimeAvailable: boolean,
): Promise<CredentialFiltersState> {
  const resolved = await resolveCredentialTargets(options),
    env = envOf(options),
    targets = [];
  for (const target of resolved.targets) {
    deadline(options);
    try {
      targets.push((await inspectFilter(target, resolved, env)).row);
    } catch (error) {
      targets.push(unavailableRow(target, safeError(error)));
    }
  }
  return {
    schema: 'stroq-credential-filters/1',
    source: 'local',
    workspaceId: resolved.workspaceId,
    generatedAt: new Date().toISOString(),
    available: runtimeAvailable,
    reason: runtimeAvailable ? null : 'credential-filter-engine-unavailable',
    targets,
    limitations: CREDENTIAL_FILTER_LIMITATIONS,
  };
}
export async function prepareFilter(
  options: Options,
  input: { action: CredentialFilterAction; target: CredentialFilterTarget },
  id: string,
  expiresAt: string,
) {
  deadline(options);
  if (
    !['apply-filter', 'undo-filter'].includes(input.action) ||
    !Object.hasOwn(CREDENTIAL_FILTER_TARGETS, input.target)
  )
    throw new Error('invalid-request');
  const resolved = await resolveCredentialTargets(options),
    target = targetOf(resolved, input.target),
    env = envOf(options);
  const inspected = await inspectFilter(target, resolved, env);
  if (inspected.row.reason) throw new Error(inspected.row.reason);
  const base = {
    schema: 'stroq-credential-filter-preview/1' as const,
    id,
    expiresAt,
    workspaceId: resolved.workspaceId,
    target: input.target,
    action: input.action,
    location: target.location,
    context: target.context,
    sourceSha256: inspected.row.sourceSha256,
    bytes: inspected.row.bytes,
    required: target.required,
    present: inspected.row.present,
    applications: inspected.entries.length,
    evidence: 'configuration' as const,
    hostEnforcement: false as const,
    limitations: CREDENTIAL_FILTER_LIMITATIONS,
    retention: CREDENTIAL_FILTER_RETENTION,
  };
  let prepared: PreparedApply | PreparedUndo, body: CredentialFilterPreview;
  if (input.action === 'apply-filter') {
    prepared = prepareApply(inspected.made.plan, env);
    const needs = needsOf(inspected.made.plan);
    body = {
      ...base,
      operation: !inspected.made.plan.changed
        ? 'unchanged'
        : inspected.made.plan.existed
          ? 'update'
          : 'create',
      candidateSha256: hash(Buffer.from(inspected.made.plan.after)),
      added: inspected.made.plan.changed ? target.required - inspected.row.present : 0,
      removed: 0,
      kept: inspected.row.present,
      backup: inspected.made.plan.changed ? inspected.made.plan.backup : 'none',
      reformatted: needs.acknowledgeReformat,
      needs: { ...needs, acknowledgeSharedScope: target.context !== 'workspace' },
    };
  } else {
    if (!inspected.entries.length) throw new Error('credential-filter-conflict');
    prepared = prepareUndo(env, target.file, { root: target.root });
    if (prepared.result.status === 'blocked') throw new Error('credential-filter-conflict');
    const beforeItems = presentItems(target, inspected.made.plan.before).present;
    const afterItems =
      prepared.candidateText === null
        ? new Set<string>()
        : presentItems(target, prepared.candidateText).present;
    const removed = [...beforeItems].filter((item) => !afterItems.has(item)).length;
    const kept = [...beforeItems].filter((item) => afterItems.has(item)).length;
    body = {
      ...base,
      operation: !prepared.changed
        ? 'clear-history'
        : prepared.removesFile
          ? 'remove-created-file'
          : prepared.result.status === 'restored'
            ? 'restore-copy'
            : 'remove-managed',
      candidateSha256: prepared.candidateSha256,
      added: 0,
      removed,
      kept,
      backup: prepared.removesFile
        ? 'none-new-file'
        : prepared.result.status === 'restored'
          ? 'copy'
          : prepared.changed
            ? 'surgical'
            : 'none',
      reformatted: prepared.result.reformatted,
      needs: {
        acknowledgeReformat: prepared.result.reformatted,
        acknowledgeLink: false,
        acknowledgeCredentialLoss: false,
        acknowledgeSharedScope: target.context !== 'workspace',
      },
    };
  }
  await assertTargetContext(options, resolved);
  deadline(options);
  const plan: PrivatePlan = {
    action: input.action,
    target: input.target,
    resolved,
    prepared,
    body,
  };
  return { body, plan };
}
export async function applyFilter(
  options: Options,
  plan: PrivatePlan,
  fault: string | null,
): Promise<CredentialFilterReceipt> {
  deadline(options);
  await assertTargetContext(options, plan.resolved);
  // Resolve the fixed target and recipe anew under the parent-held engine lock.
  // Core then compares the approved private binding, allowing only directories
  // the engine itself legitimately creates for an absent config/store.
  const fresh = await prepareFilter(
    options,
    { action: plan.action, target: plan.target },
    plan.body.id,
    plan.body.expiresAt,
  );
  if (JSON.stringify(fresh.body) !== JSON.stringify(plan.body))
    throw new Error('credential-filter-preview-stale');
  assertPreparedBinding(plan.prepared.binding, fresh.plan.prepared.binding);
  const target = targetOf(fresh.plan.resolved, plan.target),
    env = envOf(options);
  const assertCurrent = async () => {
    deadline(options);
    await assertTargetContext(options, plan.resolved);
  };
  if (fault === 'pause-before-engine') await new Promise((done) => setTimeout(done, 15000));
  let applications = 0;
  try {
    if (plan.action === 'apply-filter') {
      const result = await applyPreparedPlanUnderManifestLock(plan.prepared as PreparedApply, env, {
        ...plan.body.needs,
        assertCurrent,
      });
      applications = result.entry ? 1 : 0;
    } else {
      const result = await applyPreparedUndoUnderManifestLock(plan.prepared as PreparedUndo, env, {
        assertCurrent,
      });
      applications = result.applications;
    }
    if (fault === 'after-engine') throw new Error('fixture-interruption');
    if (fault === 'pause-before-final-evidence')
      await new Promise((done) => setTimeout(done, 2000));
    await assertCurrent();
    const after = readTargetSnapshot(target.file),
      sha = after.bytes === null ? null : hash(after.bytes);
    if (sha !== plan.body.candidateSha256) throw new Error('credential-filter-recovery-required');
    const state = await inspectFilter(target, fresh.plan.resolved, env);
    if (
      (plan.action === 'apply-filter' && (state.row.reason || state.row.status !== 'configured')) ||
      (plan.action === 'undo-filter' && (state.entries.length !== 0 || state.row.reason))
    )
      throw new Error('credential-filter-recovery-required');
  } catch (error) {
    // No automatic undo: it would reverse every historical application to this
    // file, including changes outside the approved operation.
    throw new Error('credential-filter-recovery-required');
  }
  return {
    schema: 'stroq-credential-filter-receipt/1',
    status:
      plan.body.operation === 'unchanged'
        ? 'unchanged'
        : plan.action === 'apply-filter'
          ? 'configured'
          : 'undone',
    action: plan.action,
    target: plan.target,
    workspaceId: plan.body.workspaceId,
    previewId: plan.body.id,
    candidateSha256: plan.body.candidateSha256,
    completedAt: new Date().toISOString(),
    applications,
    backup: plan.body.backup,
    evidence: 'configuration',
    hostEnforcement: false,
    requiresClientRestart: true,
  };
}
