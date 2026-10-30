import { assertNoPendingCodexConfiguration } from './codex-configuration-pending.ts';
import { randomUUID } from 'node:crypto';
import { closed } from '../lib/local-guards.ts';
import {
  validateCodexSkillControlSelection,
  validateCodexSkillControlRestoreSelection,
  validateCodexSkillControlRecheckSelection,
  type CodexSkillControlRecord,
  type CodexSkillControlPreview,
  type CodexSkillControlReceipt,
  type CodexSkillControlState,
} from '../lib/codex-skill-controls.ts';
import { captureCodexSkillConfig, declaredSkillState } from './codex-skill-source-config.ts';
import { planCodexSkillDisable, restoreCodexSkillDisable } from './codex-skill-control-toml.ts';
import {
  controlContext,
  nullableHash,
  sourceSnapshot,
  controlParents,
  same,
  assertRuntime,
  fail,
  type ControlOptions,
  type ControlContext,
  type ControlPrivatePlan,
  type ControlRecord,
} from './codex-skill-control-binding.ts';
import { selectCodexSkillControl } from './codex-skill-control-selection.ts';
import { getControlRecord, readControlVault } from './codex-skill-control-store.ts';
import {
  applyCodexSkillControl,
  recheckCodexSkillControl,
  type ControlHooks,
} from './codex-skill-control-transaction.ts';
export {
  validateCodexSkillControlPrivatePlan,
  codexSkillControlPrivatePlanBytes,
} from '../lib/codex-skill-controls-private.ts';
const now = () => new Date().toISOString();
const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
export async function projectCodexSkillControlRecord(
  context: ControlContext,
  record: ControlRecord,
  hooks: ControlHooks = {},
): Promise<CodexSkillControlRecord> {
  const m = record.manifest;
  let standing: CodexSkillControlRecord['standing'] = 'unavailable',
    canRestore = false;
  try {
    const config = await captureCodexSkillConfig({ root: context.user, path: context.target });
    await hooks.fault?.('after-standing-capture');
    const declared = declaredSkillState(config.configuration, {
      path: m.documentPath,
      name: m.nativeName,
      knownPaths: new Set([m.documentPath]),
    });
    standing =
      declared === 'disabled'
        ? 'disabled'
        : declared === 'enabled' || declared === 'not-specified'
          ? 'enabled-or-unspecified'
          : config.configuration.status === 'ready'
            ? 'changed'
            : 'unavailable';
    try {
      if (m.phase === 'disabled') {
        const current = await sourceSnapshot(context);
        if (current.bytes !== null && same(controlParents(current), m.parents)) {
          restoreCodexSkillDisable({ bytes: current.bytes, owned: record.owned });
          canRestore = true;
        }
      }
    } catch {
      canRestore = false;
    }
    await config.assertCurrent();
  } catch {
    standing = 'unavailable';
    canRestore = false;
  }
  return {
    id: m.id,
    operationId: m.operationId,
    revision: record.revision,
    controlContextId: m.controlContextId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    name: m.name,
    location: m.location,
    operationStatus: ['prepared', 'restoring'].includes(m.phase)
      ? 'unknown'
      : (m.phase as 'disabled' | 'restored'),
    standing,
    originalSha256: m.originalSha256,
    candidateSha256: m.candidateSha256,
    canRestore,
    sharedUserConfig: true,
    hostEnforcement: false,
  };
}
export async function readCodexSkillControlState(
  options: ControlOptions,
  hooks: ControlHooks = {},
): Promise<CodexSkillControlState> {
  let context: ControlContext | null = null;
  try {
    context = await controlContext(options);
    const vault = await readControlVault(context);
    const records = await Promise.all(
      vault.records
        .filter(
          (r) =>
            r.manifest.controlContextId === context!.id && r.manifest.target === context!.target,
        )
        .map((r) => projectCodexSkillControlRecord(context!, r, hooks)),
    );
    const blocked = vault.count > vault.records.length || vault.pendingStaging;
    return {
      schema: 'stroq-codex-skill-controls/1',
      controlContextId: context.id,
      generatedAt: now(),
      available: !blocked,
      history: vault.missing ? 'missing' : 'ready',
      records,
      error: blocked ? 'codex-control-recovery-required' : null,
    };
  } catch {
    return {
      schema: 'stroq-codex-skill-controls/1',
      controlContextId: context?.id ?? null,
      generatedAt: now(),
      available: false,
      history: 'unavailable',
      records: [],
      error: 'codex-control-store-unavailable',
    };
  }
}
export async function previewCodexSkillControl(options: ControlOptions, request: unknown) {
  if (
    !validateCodexSkillControlSelection(request) &&
    !validateCodexSkillControlRestoreSelection(request)
  )
    fail('codex-control-stale');
  await assertRuntime(options);
  const context = await controlContext(options);
  if (context.id !== request.controlContextId) fail('codex-control-stale');
  await assertNoPendingCodexConfiguration(context, 'skill');
  const vault = await readControlVault(context);
  if (
    vault.count > vault.records.length ||
    vault.pendingStaging ||
    vault.records.some((r) => ['prepared', 'restoring'].includes(r.manifest.phase))
  )
    fail('codex-control-recovery-required');
  const id = randomUUID(),
    createdMs = Date.now(),
    createdAt = new Date(createdMs).toISOString(),
    expiresAt = new Date(Math.min(createdMs + 120000, options.deadline + 120000)).toISOString();
  let plan: ControlPrivatePlan;
  if (request.operation === 'disable') {
    const selected = await selectCodexSkillControl(options, request),
      recordId = randomUUID();
    const transformed = planCodexSkillDisable({
      bytes: selected.before.bytes,
      documentPath: selected.document.path,
      operationId: recordId,
    });
    const preview: CodexSkillControlPreview = {
      schema: 'stroq-codex-skill-control-preview/1',
      id,
      operationId: id,
      binding: {
        controlContextId: context.id,
        sourceId: request.sourceId,
        candidateId: request.candidateId,
        entrypointSha256: request.expectedEntrypointSha256,
        runtimeSha256: options.runtimeSha256,
      },
      controlContextId: context.id,
      operation: 'disable',
      recordId,
      recordRevision: null,
      createdAt,
      expiresAt,
      name: selected.item.name,
      location: selected.item.location,
      beforeSha256: nullableHash(selected.before.bytes),
      afterSha256: nullableHash(Buffer.from(transformed.bytes)),
      sameNameCopies: selected.sameNameCopies,
      sharedUserConfig: true,
      retainsConfigurationCopies: true,
      formattingPreserved: true,
      hostEnforcement: false,
    };
    plan = {
      schema: 'stroq-codex-skill-control-private-plan/1',
      preview,
      request,
      context,
      before: selected.before,
      candidate: transformed.bytes,
      owned: transformed.owned,
      candidatePin: {
        root: selected.document.root,
        path: selected.document.path,
        snapshot: selected.document.snapshot,
      },
    };
  } else {
    const record = await getControlRecord(context, request.recordId, request.recordRevision);
    if (record.manifest.phase !== 'disabled') fail('codex-control-conflict');
    const before = await sourceSnapshot(context);
    if (before.bytes === null || !same(controlParents(before), record.manifest.parents))
      fail('codex-control-conflict');
    const candidate = restoreCodexSkillDisable({ bytes: before.bytes, owned: record.owned });
    const preview: CodexSkillControlPreview = {
      schema: 'stroq-codex-skill-control-preview/1',
      id,
      operationId: id,
      binding: null,
      controlContextId: context.id,
      operation: 'restore',
      recordId: record.manifest.id,
      recordRevision: record.revision,
      createdAt,
      expiresAt,
      name: record.manifest.name,
      location: record.manifest.location,
      beforeSha256: nullableHash(before.bytes),
      afterSha256: nullableHash(candidate === null ? null : Buffer.from(candidate)),
      sameNameCopies: 0,
      sharedUserConfig: true,
      retainsConfigurationCopies: true,
      formattingPreserved: true,
      hostEnforcement: false,
    };
    plan = {
      schema: 'stroq-codex-skill-control-private-plan/1',
      preview,
      request,
      context,
      before,
      candidate,
      owned: record.owned,
      candidatePin: null,
    };
  }
  return { preview: plan.preview, privatePlan: plan };
}
async function receipt(
  context: ControlContext,
  record: ControlRecord,
  operation: CodexSkillControlReceipt['operation'],
): Promise<CodexSkillControlReceipt> {
  return {
    schema: 'stroq-codex-skill-control-receipt/1',
    operationId: record.manifest.operationId,
    controlContextId: context.id,
    operation,
    checkedAt: now(),
    writeConfirmed: ['disabled', 'restored'].includes(record.manifest.phase),
    record: await projectCodexSkillControlRecord(context, record),
  };
}
/** Fixed worker operations. The private plan crosses only the trusted main/worker channel. */
async function dispatchCodexSkillControlOperation(
  operation: string,
  options: ControlOptions,
  data: unknown,
  hooks: ControlHooks = {},
): Promise<unknown> {
  if (operation === 'codex-control-state') {
    if (!exact(data, [])) fail('codex-control-stale');
    return readCodexSkillControlState(options, hooks);
  }
  if (operation === 'codex-control-preview') {
    if (!exact(data, ['request'])) fail('codex-control-stale');
    return previewCodexSkillControl(options, data.request);
  }
  if (operation === 'codex-control-apply') {
    if (
      !closed(data, [
        'privatePlan',
        'acknowledgeSharedUserConfig',
        'acknowledgeRetention',
        'acknowledgeWeakening',
        'writerLockHeld',
      ]) ||
      data.acknowledgeSharedUserConfig !== true ||
      data.acknowledgeRetention !== true ||
      data.writerLockHeld !== true
    )
      fail('codex-control-consent-required');
    const plan = data.privatePlan as ControlPrivatePlan;
    if (
      !plan?.preview ||
      (plan.preview.operation === 'restore'
        ? data.acknowledgeWeakening !== true
        : Object.hasOwn(data, 'acknowledgeWeakening'))
    )
      fail('codex-control-consent-required');
    const record = await applyCodexSkillControl(options, plan, hooks);
    return receipt(plan.context, record, plan.preview.operation);
  }
  if (operation === 'codex-control-recheck') {
    if (
      !exact(data, ['request', 'writerLockHeld']) ||
      data.writerLockHeld !== true ||
      !validateCodexSkillControlRecheckSelection(data.request)
    )
      fail('codex-control-stale');
    const context = await controlContext(options);
    if (context.id !== data.request.controlContextId) fail('codex-control-stale');
    const record = await recheckCodexSkillControl(
      options,
      context,
      data.request.recordId,
      data.request.recordRevision,
      data.request.operationId,
    );
    return receipt(context, record, 'recheck');
  }
  fail('codex-control-unavailable');
}

export async function runCodexSkillControlOperation(
  operation: string,
  options: ControlOptions,
  data: unknown,
  hooks: ControlHooks = {},
): Promise<unknown> {
  try {
    return await dispatchCodexSkillControlOperation(operation, options, data, hooks);
  } catch (error) {
    const code = (error as Error)?.message;
    const mapped: Record<string, string> = {
      'codex-skill-control-conflict': 'codex-control-conflict',
      'codex-skill-control-invalid': 'codex-control-unsupported',
      'codex-skill-control-limit': 'codex-control-unsupported',
      'preview-stale': 'codex-control-stale',
      'unsafe-config': 'codex-control-unsupported',
      'changed-context': 'codex-control-stale',
      deadline: 'codex-control-stale',
    };
    if (mapped[code]) fail(mapped[code]!);
    throw error;
  }
}
