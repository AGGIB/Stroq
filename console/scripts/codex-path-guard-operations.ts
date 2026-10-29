import { randomUUID } from 'node:crypto';
import { closed } from '../lib/local-guards.ts';
import {
  validateCodexPathGuardSelection,
  validateCodexPathGuardRestoreSelection,
  validateCodexPathGuardRecheckSelection,
  type CodexPathGuardPreview,
  type CodexPathGuardState,
  type CodexPathGuardReceipt,
} from '../lib/codex-path-guard.ts';
import { validateCodexPathGuardPrivatePlan } from '../lib/codex-path-guard-private.ts';
import { planCodexPathGuard } from './codex-path-guard-toml.ts';
import {
  capturePathGuard,
  inspectPathGuard,
  restorePathGuardRecord,
  pathGuardError,
  assertPathGuardDependencies,
} from './codex-path-guard-capture.ts';
import { assertPathGuardSelectorOwnership } from './codex-configuration-ownership.ts';
import { projectPathGuardRecord } from './codex-path-guard-projection.ts';
export { projectPathGuardRecord } from './codex-path-guard-projection.ts';
import { assertPathGuardOwnership } from './codex-path-guard-ownership.ts';
import { assertNoPendingCodexConfiguration } from './codex-configuration-pending.ts';
import {
  controlContext,
  assertRuntime,
  sourceSnapshot,
  controlParents,
  nullableHash,
  same,
  pathFail,
  type GuardOptions,
  type GuardHooks,
  type PathGuardRecord,
  type ControlContext,
  type CodexPathGuardPrivatePlan,
} from './codex-path-guard-binding.ts';
import { readPathGuardVault, getPathGuardRecord } from './codex-path-guard-store.ts';
import { applyPathGuard, recheckPathGuard } from './codex-path-guard-transaction.ts';
export { applyPathGuard, recheckPathGuard } from './codex-path-guard-transaction.ts';
const now = () => new Date().toISOString();
const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
export async function statePathGuard(
  options: GuardOptions,
  hooks: GuardHooks = {},
): Promise<CodexPathGuardState> {
  let context: ControlContext | null = null;
  try {
    context = await controlContext(options);
    const vault = await readPathGuardVault(context),
      blocked = vault.pendingStaging || vault.count > vault.records.length;
    const selected = vault.records.filter(
      (r) => r.manifest.controlContextId === context!.id && r.manifest.target === context!.target,
    );
    let capture = null;
    try {
      capture = await capturePathGuard(options, hooks, 'restore');
      if (!same(capture.context, context)) capture = null;
    } catch {}
    let records = await Promise.all(
      selected.map((r) =>
        projectPathGuardRecord(options, context!, r, vault.records, capture, false),
      ),
    );
    if (capture)
      try {
        await assertPathGuardDependencies(options, capture);
        const current = await sourceSnapshot(context);
        if (!same({ ...current, bytes: null }, { ...capture.before, bytes: null }))
          throw Error('changed');
      } catch {
        records = records.map((r) => ({
          ...r,
          standing: 'unavailable' as const,
          canRestore: false,
        }));
      }
    return {
      schema: 'stroq-codex-path-guard/1',
      controlContextId: context.id,
      generatedAt: now(),
      available: !blocked,
      history: vault.missing ? 'missing' : 'ready',
      records,
      error: blocked ? 'codex-path-guard-recovery-required' : null,
    };
  } catch {
    return {
      schema: 'stroq-codex-path-guard/1',
      controlContextId: context?.id ?? null,
      generatedAt: now(),
      available: false,
      history: 'unavailable',
      records: [],
      error: 'codex-path-guard-store-unavailable',
    };
  }
}
export async function previewPathGuard(
  options: GuardOptions,
  request: unknown,
  hooks: GuardHooks = {},
) {
  if (!validateCodexPathGuardSelection(request) && !validateCodexPathGuardRestoreSelection(request))
    pathFail('codex-path-guard-stale');
  await assertRuntime(options);
  const capture = await capturePathGuard(
      options,
      hooks,
      request.operation === 'guard' ? 'guard' : 'restore',
    ),
    context = capture.context;
  if (context.id !== request.controlContextId) pathFail('codex-path-guard-stale');
  await assertNoPendingCodexConfiguration(context, 'path');
  const id = randomUUID(),
    createdMs = Date.now(),
    createdAt = new Date(createdMs).toISOString(),
    expiresAt = new Date(createdMs + 120000).toISOString();
  let plan: CodexPathGuardPrivatePlan;
  if (request.operation === 'guard') {
    if (capture.binding.captureSha256 !== request.captureSha256) pathFail('codex-path-guard-stale');
    const row = capture.public.presets.find((p) => p.id === request.presetId);
    if (!row?.canGuard || capture.profileName === null)
      pathFail(row?.reason ?? capture.public.reason ?? 'codex-path-guard-unsupported');
    await assertPathGuardSelectorOwnership(context, capture.profileName);
    const recordId = randomUUID(),
      transformed = planCodexPathGuard({
        bytes: capture.before.bytes,
        operationId: recordId,
        targetPath: capture.targets.targets.find((t) => t.id === request.presetId)!.path,
      });
    const preview: CodexPathGuardPreview = {
      schema: 'stroq-codex-path-preview/1',
      id,
      operationId: id,
      controlContextId: context.id,
      operation: 'guard',
      kind: 'profile-path-deny',
      presetId: request.presetId,
      recordId,
      recordRevision: null,
      createdAt,
      expiresAt,
      binding: capture.binding,
      beforeSha256: nullableHash(capture.before.bytes),
      afterSha256: nullableHash(Buffer.from(transformed.bytes)),
      pathEffect: 'deny-read-write',
      filesystemEffect: 'deny-exact-path',
      networkEffect: 'preserved',
      sharedUserConfig: true,
      retainsConfigurationCopies: true,
      formattingPreserved: true,
      hostEnforcement: false,
    };
    plan = {
      schema: 'stroq-codex-path-private-plan/1',
      preview,
      request,
      context,
      before: capture.before,
      candidate: transformed.bytes,
      owned: transformed.owned,
      capture,
    };
  } else {
    const vault = await readPathGuardVault(context),
      record = await getPathGuardRecord(context, request.recordId, request.recordRevision);
    assertPathGuardOwnership(record, vault.records);
    if (
      record.manifest.phase !== 'guarded' ||
      capture.before.bytes === null ||
      !same(controlParents(capture.before), record.manifest.parents)
    )
      pathFail('codex-path-guard-conflict');
    await assertPathGuardSelectorOwnership(context, record.manifest.profileName);
    const candidate = await restorePathGuardRecord(options, capture, record);
    if (candidate === null) pathFail('codex-path-guard-conflict');
    const preview: CodexPathGuardPreview = {
      schema: 'stroq-codex-path-preview/1',
      id,
      operationId: id,
      controlContextId: context.id,
      operation: 'restore',
      kind: record.manifest.kind,
      presetId: record.manifest.presetId,
      recordId: record.manifest.id,
      recordRevision: record.revision,
      createdAt,
      expiresAt,
      binding: null,
      beforeSha256: nullableHash(capture.before.bytes),
      afterSha256: nullableHash(Buffer.from(candidate)),
      filesystemEffect: 'prior-settings',
      pathEffect: 'prior-settings',
      networkEffect: 'preserved',
      sharedUserConfig: true,
      retainsConfigurationCopies: true,
      formattingPreserved: true,
      hostEnforcement: false,
    };
    plan = {
      schema: 'stroq-codex-path-private-plan/1',
      preview,
      request,
      context,
      before: capture.before,
      candidate,
      owned: record.owned,
      capture,
    };
  }
  if (!validateCodexPathGuardPrivatePlan(plan)) pathFail('codex-path-guard-unavailable');
  return { preview: plan.preview, privatePlan: plan };
}
async function receipt(
  options: GuardOptions,
  hooks: GuardHooks,
  context: ControlContext,
  record: PathGuardRecord,
  operation: CodexPathGuardReceipt['operation'],
): Promise<CodexPathGuardReceipt> {
  const vault = await readPathGuardVault(context);
  return {
    schema: 'stroq-codex-path-receipt/1',
    operationId: record.manifest.operationId,
    controlContextId: context.id,
    operation,
    checkedAt: now(),
    writeConfirmed: ['guarded', 'restored'].includes(record.manifest.phase),
    record: await projectPathGuardRecord(
      options,
      context,
      record,
      vault.records,
      await capturePathGuard(options, hooks, 'restore').catch(() => null),
    ),
  };
}
async function dispatch(
  operation: string,
  options: GuardOptions,
  data: unknown,
  hooks: GuardHooks,
) {
  if (operation === 'codex-path-state') {
    if (!exact(data, [])) pathFail('codex-path-guard-stale');
    return statePathGuard(options, hooks);
  }
  if (operation === 'codex-path-capture') {
    if (!exact(data, [])) pathFail('codex-path-guard-stale');
    return inspectPathGuard(options, hooks);
  }
  if (operation === 'codex-path-preview') {
    if (!exact(data, ['request'])) pathFail('codex-path-guard-stale');
    return previewPathGuard(options, data.request, hooks);
  }
  if (operation === 'codex-path-apply') {
    if (
      !closed(data, [
        'privatePlan',
        'acknowledgeSharedUserConfig',
        'acknowledgeRetention',
        'acknowledgeWeakening',
        'writerLockHeld',
      ]) ||
      data.writerLockHeld !== true ||
      data.acknowledgeSharedUserConfig !== true ||
      data.acknowledgeRetention !== true
    )
      pathFail('codex-path-guard-consent-required');
    if (!validateCodexPathGuardPrivatePlan(data.privatePlan)) pathFail('codex-path-guard-stale');
    const plan = data.privatePlan;
    if (
      plan.request.operation === 'restore'
        ? data.acknowledgeWeakening !== true
        : Object.hasOwn(data, 'acknowledgeWeakening')
    )
      pathFail('codex-path-guard-consent-required');
    return receipt(
      options,
      hooks,
      plan.context,
      await applyPathGuard(options, plan, hooks),
      plan.request.operation,
    );
  }
  if (operation === 'codex-path-recheck') {
    if (
      !exact(data, ['request', 'writerLockHeld']) ||
      data.writerLockHeld !== true ||
      !validateCodexPathGuardRecheckSelection(data.request)
    )
      pathFail('codex-path-guard-stale');
    const context = await controlContext(options);
    if (context.id !== data.request.controlContextId) pathFail('codex-path-guard-stale');
    return receipt(
      options,
      hooks,
      context,
      await recheckPathGuard(
        options,
        context,
        data.request.recordId,
        data.request.recordRevision,
        data.request.operationId,
        hooks,
      ),
      'recheck',
    );
  }
  pathFail('codex-path-guard-unavailable');
}
export async function runCodexPathGuardOperation(
  operation: string,
  options: GuardOptions,
  data: unknown,
  hooks: GuardHooks = {},
) {
  try {
    return await dispatch(operation, options, data, hooks);
  } catch (e) {
    pathFail(pathGuardError(e));
  }
}
