import { prepareCodexNetworkCheck } from './codex-network-guard-check-prepare.ts';
import { randomUUID } from 'node:crypto';
import { closed } from '../lib/local-guards.ts';
import {
  CODEX_NETWORK_GUARD_ERRORS,
  validateCodexNetworkGuardSelection,
  validateCodexNetworkGuardRestoreSelection,
  validateCodexNetworkGuardRecheckSelection,
  type CodexNetworkGuardRecord,
  type CodexNetworkGuardPreview,
  type CodexNetworkGuardState,
  type CodexNetworkGuardReceipt,
} from '../lib/codex-network-guard.ts';
import { validateCodexNetworkGuardPrivatePlan } from '../lib/codex-network-guard-private.ts';
import { planCodexNetworkGuard, restoreCodexNetworkGuard } from './codex-network-guard-toml.ts';
import { captureNetworkGuard, inspectNetworkGuard } from './codex-network-guard-capture.ts';
import { parseGuardToml } from './codex-network-guard-parse.ts';
import { guardSuperseded, assertGuardOwnership } from './codex-network-guard-ownership.ts';
import { assertNoPendingCodexConfiguration } from './codex-configuration-pending.ts';
import {
  networkGuardSupersededByPath,
  assertNetworkGuardRestoreOwnership,
} from './codex-configuration-ownership.ts';
import {
  controlContext,
  assertRuntime,
  sourceSnapshot,
  controlParents,
  nullableHash,
  same,
  networkFail,
  type GuardOptions,
  type GuardHooks,
  type GuardRecord,
  type ControlContext,
  type CodexNetworkGuardPrivatePlan,
} from './codex-network-guard-binding.ts';
import { readNetworkGuardVault, getNetworkGuardRecord } from './codex-network-guard-store.ts';
import { applyNetworkGuard, recheckNetworkGuard } from './codex-network-guard-transaction.ts';
const now = () => new Date().toISOString();
const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
export async function projectNetworkGuardRecord(
  context: ControlContext,
  record: GuardRecord,
  records: GuardRecord[],
): Promise<CodexNetworkGuardRecord> {
  const m = record.manifest,
    superseded =
      guardSuperseded(record, records) || (await networkGuardSupersededByPath(context, record));
  let standing: CodexNetworkGuardRecord['standing'] = 'unavailable',
    canRestore = false;
  try {
    const snapshot = await sourceSnapshot(context);
    if (snapshot.bytes === null) networkFail('codex-network-conflict');
    const current = parseGuardToml(snapshot.bytes),
      original = parseGuardToml(record.owned.before);
    const selected =
      m.kind === 'profile-network-off'
        ? current.default_permissions === original.default_permissions &&
          current.permissions?.[original.default_permissions as string]?.network?.enabled === false
        : m.kind === 'profile-child'
          ? current.default_permissions === m.childProfile
          : current.default_permissions === undefined &&
            current.sandbox_mode === 'workspace-write' &&
            current.sandbox_workspace_write?.network_access === false;
    standing = selected ? 'selected' : 'changed';
    if (m.phase === 'guarded' && !superseded && same(controlParents(snapshot), m.parents)) {
      try {
        restoreCodexNetworkGuard({ bytes: snapshot.bytes, owned: record.owned });
        canRestore = true;
      } catch {
        /* Changed owned field stays unrestorable. */
      }
    }
    const recheck = await sourceSnapshot(context);
    if (!same({ ...snapshot, bytes: null }, { ...recheck, bytes: null }))
      networkFail('codex-network-stale');
  } catch {
    standing = 'unavailable';
    canRestore = false;
  }
  return {
    id: m.id,
    operationId: m.operationId,
    revision: record.revision,
    controlContextId: m.controlContextId,
    kind: m.kind,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    operationStatus: ['prepared', 'restoring'].includes(m.phase)
      ? 'unknown'
      : (m.phase as 'guarded' | 'restored'),
    ownership: superseded ? 'superseded' : 'current',
    standing,
    originalSha256: m.originalSha256,
    candidateSha256: m.candidateSha256,
    canRestore,
    retainsInactiveProfile: m.phase === 'restored' && m.kind === 'profile-child',
    sharedUserConfig: true,
    hostEnforcement: false,
  };
}
export async function stateNetworkGuard(options: GuardOptions): Promise<CodexNetworkGuardState> {
  let context: ControlContext | null = null;
  try {
    context = await controlContext(options);
    const vault = await readNetworkGuardVault(context),
      blocked = vault.pendingStaging || vault.count > vault.records.length;
    const selected = vault.records.filter(
      (r) => r.manifest.controlContextId === context!.id && r.manifest.target === context!.target,
    );
    return {
      schema: 'stroq-codex-network-guard/1',
      controlContextId: context.id,
      generatedAt: now(),
      available: !blocked,
      history: vault.missing ? 'missing' : 'ready',
      records: await Promise.all(
        selected.map((r) => projectNetworkGuardRecord(context!, r, vault.records)),
      ),
      error: blocked ? 'codex-network-recovery-required' : null,
    };
  } catch {
    return {
      schema: 'stroq-codex-network-guard/1',
      controlContextId: context?.id ?? null,
      generatedAt: now(),
      available: false,
      history: 'unavailable',
      records: [],
      error: 'codex-network-store-unavailable',
    };
  }
}
export async function previewNetworkGuard(
  options: GuardOptions,
  request: unknown,
  hooks: GuardHooks = {},
) {
  if (
    !validateCodexNetworkGuardSelection(request) &&
    !validateCodexNetworkGuardRestoreSelection(request)
  )
    networkFail('codex-network-stale');
  await assertRuntime(options);
  const capture = await captureNetworkGuard(
      options,
      hooks,
      request.operation === 'guard' ? 'guard' : 'restore',
    ),
    context = capture.context;
  if (context.id !== request.controlContextId) networkFail('codex-network-stale');
  await assertNoPendingCodexConfiguration(context, 'network');
  const id = randomUUID(),
    createdMs = Date.now(),
    createdAt = new Date(createdMs).toISOString(),
    expiresAt = new Date(createdMs + 120000).toISOString();
  let plan: CodexNetworkGuardPrivatePlan;
  if (request.operation === 'guard') {
    if (capture.binding.captureSha256 !== request.captureSha256) networkFail('codex-network-stale');
    if (!capture.public.canGuard || capture.kind === null)
      networkFail(capture.public.reason ?? 'codex-network-unsupported');
    const recordId = randomUUID(),
      transformed = planCodexNetworkGuard({
        bytes: capture.before.bytes,
        operationId: recordId,
        kind: capture.kind,
      });
    const preview: CodexNetworkGuardPreview = {
      schema: 'stroq-codex-network-preview/1',
      id,
      operationId: id,
      controlContextId: context.id,
      operation: 'guard',
      kind: capture.kind,
      recordId,
      recordRevision: null,
      createdAt,
      expiresAt,
      binding: capture.binding,
      beforeSha256: nullableHash(capture.before.bytes),
      afterSha256: nullableHash(Buffer.from(transformed.bytes)),
      filesystemEffect: transformed.effect.filesystem,
      networkEffect: 'off',
      retainsInactiveProfile: false,
      sharedUserConfig: true,
      retainsConfigurationCopies: true,
      formattingPreserved: true,
      hostEnforcement: false,
    };
    plan = {
      schema: 'stroq-codex-network-private-plan/1',
      preview,
      request,
      context,
      before: capture.before,
      candidate: transformed.bytes,
      owned: transformed.owned,
      capture,
    };
  } else {
    const vault = await readNetworkGuardVault(context),
      record = await getNetworkGuardRecord(context, request.recordId, request.recordRevision);
    assertGuardOwnership(record, vault.records);
    await assertNetworkGuardRestoreOwnership(context, record);
    if (
      record.manifest.phase !== 'guarded' ||
      capture.before.bytes === null ||
      !same(controlParents(capture.before), record.manifest.parents)
    )
      networkFail('codex-network-conflict');
    const candidate = restoreCodexNetworkGuard({
      bytes: capture.before.bytes,
      owned: record.owned,
    });
    if (candidate === null) networkFail('codex-network-conflict');
    const preview: CodexNetworkGuardPreview = {
      schema: 'stroq-codex-network-preview/1',
      id,
      operationId: id,
      controlContextId: context.id,
      operation: 'restore',
      kind: record.manifest.kind,
      recordId: record.manifest.id,
      recordRevision: record.revision,
      createdAt,
      expiresAt,
      binding: null,
      beforeSha256: nullableHash(capture.before.bytes),
      afterSha256: nullableHash(Buffer.from(candidate)),
      filesystemEffect: 'prior-settings',
      networkEffect: 'prior-settings',
      retainsInactiveProfile: record.manifest.kind === 'profile-child',
      sharedUserConfig: true,
      retainsConfigurationCopies: true,
      formattingPreserved: true,
      hostEnforcement: false,
    };
    plan = {
      schema: 'stroq-codex-network-private-plan/1',
      preview,
      request,
      context,
      before: capture.before,
      candidate,
      owned: record.owned,
      capture,
    };
  }
  if (!validateCodexNetworkGuardPrivatePlan(plan)) networkFail('codex-network-unavailable');
  return { preview: plan.preview, privatePlan: plan };
}
async function receipt(
  context: ControlContext,
  record: GuardRecord,
  operation: CodexNetworkGuardReceipt['operation'],
): Promise<CodexNetworkGuardReceipt> {
  const vault = await readNetworkGuardVault(context);
  return {
    schema: 'stroq-codex-network-receipt/1',
    operationId: record.manifest.operationId,
    controlContextId: context.id,
    operation,
    checkedAt: now(),
    writeConfirmed: ['guarded', 'restored'].includes(record.manifest.phase),
    record: await projectNetworkGuardRecord(context, record, vault.records),
  };
}
async function dispatch(
  operation: string,
  options: GuardOptions,
  data: unknown,
  hooks: GuardHooks,
) {
  if (operation === 'codex-network-state') {
    if (!exact(data, [])) networkFail('codex-network-stale');
    return stateNetworkGuard(options);
  }
  if (operation === 'codex-network-capture') {
    if (!exact(data, [])) networkFail('codex-network-stale');
    return inspectNetworkGuard(options, hooks);
  }
  if (operation === 'codex-network-check-prepare') {
    if (!exact(data, ['request'])) networkFail('codex-network-stale');
    return prepareCodexNetworkCheck(options, data.request, hooks);
  }
  if (operation === 'codex-network-preview') {
    if (!exact(data, ['request'])) networkFail('codex-network-stale');
    return previewNetworkGuard(options, data.request, hooks);
  }
  if (operation === 'codex-network-apply') {
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
      networkFail('codex-network-consent-required');
    if (!validateCodexNetworkGuardPrivatePlan(data.privatePlan)) networkFail('codex-network-stale');
    const plan = data.privatePlan;
    if (
      plan.request.operation === 'restore'
        ? data.acknowledgeWeakening !== true
        : Object.hasOwn(data, 'acknowledgeWeakening')
    )
      networkFail('codex-network-consent-required');
    return receipt(
      plan.context,
      await applyNetworkGuard(options, plan, hooks),
      plan.request.operation,
    );
  }
  if (operation === 'codex-network-recheck') {
    if (
      !exact(data, ['request', 'writerLockHeld']) ||
      data.writerLockHeld !== true ||
      !validateCodexNetworkGuardRecheckSelection(data.request)
    )
      networkFail('codex-network-stale');
    const context = await controlContext(options);
    if (context.id !== data.request.controlContextId) networkFail('codex-network-stale');
    return receipt(
      context,
      await recheckNetworkGuard(
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
  networkFail('codex-network-unavailable');
}
export async function runCodexNetworkGuardOperation(
  operation: string,
  options: GuardOptions,
  data: unknown,
  hooks: GuardHooks = {},
) {
  try {
    return await dispatch(operation, options, data, hooks);
  } catch (e) {
    const code = (e as Error).message;
    const mapped: Record<string, string> = {
      'codex-network-guard-invalid': 'codex-network-unsupported',
      'codex-network-guard-limit': 'codex-network-unsupported',
      'codex-network-guard-conflict': 'codex-network-conflict',
      'codex-control-runtime-changed': 'codex-network-runtime-changed',
      'codex-control-stale': 'codex-network-stale',
      'codex-control-unsupported': 'codex-network-unsupported',
      'preview-stale': 'codex-network-stale',
      'unsafe-config': 'codex-network-unsupported',
      'changed-context': 'codex-network-stale',
      deadline: 'codex-network-stale',
    };
    networkFail(
      mapped[code] ??
        (CODEX_NETWORK_GUARD_ERRORS.includes(code as any) ? code : 'codex-network-unavailable'),
    );
  }
}
