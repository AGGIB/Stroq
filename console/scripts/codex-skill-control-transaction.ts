import { assertNoPendingCodexConfiguration } from './codex-configuration-pending.ts';
import { dirname, join } from 'node:path';
import { removeCodexSkillConfigToAbsence } from './codex-skill-control-removal.ts';
import { atomicWrite, assertUnchanged, snapshotFile } from './agent-setup-files.mjs';
import { restoreCodexSkillDisable, planCodexSkillDisable } from './codex-skill-control-toml.ts';
import { validateCodexSkillControlPrivatePlan } from '../lib/codex-skill-controls-private.ts';
import {
  assertSelectedCandidate,
  selectCodexSkillControl,
} from './codex-skill-control-selection.ts';
import {
  assertContext,
  assertRuntime,
  sourceSnapshot,
  publishedPin,
  controlParents,
  nullableHash,
  same,
  fail,
  CONFIG_BYTES,
  type ControlOptions,
  type ControlContext,
  type ControlPrivatePlan,
  type ControlManifest,
  type ControlRecord,
} from './codex-skill-control-binding.ts';
import {
  readControlVault,
  createControlRecord,
  saveControlManifest,
  getControlRecord,
  syncControlDirectory,
} from './codex-skill-control-store.ts';
export type ControlHooks = { fault?: (stage: string) => Promise<void> };
const now = () => new Date().toISOString();
async function planGuard(options: ControlOptions, plan: ControlPrivatePlan) {
  if (Date.now() >= Date.parse(plan.preview.expiresAt)) fail('codex-control-stale');
  await assertRuntime(options);
  await assertContext(options, plan.context);
  await assertSelectedCandidate(plan.candidatePin);
}
async function verifyPlan(options: ControlOptions, plan: ControlPrivatePlan) {
  if (!validateCodexSkillControlPrivatePlan(plan)) fail('codex-control-stale');
  await planGuard(options, plan);
  if (plan.preview.controlContextId !== plan.context.id) fail('codex-control-stale');
  const current = await sourceSnapshot(plan.context);
  if (
    !same({ ...current, bytes: null }, { ...plan.before, bytes: null }) ||
    nullableHash(current.bytes) !== plan.preview.beforeSha256
  )
    fail('codex-control-stale');
  let candidate: Uint8Array | null;
  if (plan.request.operation === 'disable') {
    const selected = await selectCodexSkillControl(options, plan.request);
    if (
      !same(selected.context, plan.context) ||
      selected.document.path !== plan.owned.documentPath ||
      selected.document.name === null ||
      !same(selected.document.snapshot.file, plan.candidatePin?.snapshot.file)
    )
      fail('codex-control-stale');
    candidate = planCodexSkillDisable({
      bytes: current.bytes,
      documentPath: selected.document.path,
      operationId: plan.preview.recordId,
    }).bytes;
    if (
      !same(plan.owned.before === null ? null : Buffer.from(plan.owned.before), current.bytes) ||
      !Buffer.from(plan.owned.candidate).equals(Buffer.from(candidate))
    )
      fail('codex-control-stale');
  } else {
    const record = await getControlRecord(
      plan.context,
      plan.request.recordId,
      plan.request.recordRevision,
    );
    if (
      !same(controlParents(current), record.manifest.parents) ||
      record.manifest.phase !== 'disabled' ||
      !(
        record.owned.operationId === plan.owned.operationId &&
        record.owned.documentPath === plan.owned.documentPath &&
        same(
          record.owned.before === null ? null : Buffer.from(record.owned.before),
          plan.owned.before === null ? null : Buffer.from(plan.owned.before),
        ) &&
        Buffer.from(record.owned.candidate).equals(Buffer.from(plan.owned.candidate))
      )
    )
      fail('codex-control-conflict');
    candidate = restoreCodexSkillDisable({
      bytes: current.bytes ?? new Uint8Array(),
      owned: record.owned,
    });
  }
  if (
    !same(
      candidate === null ? null : Buffer.from(candidate),
      plan.candidate === null ? null : Buffer.from(plan.candidate),
    ) ||
    nullableHash(candidate === null ? null : Buffer.from(candidate)) !== plan.preview.afterSha256
  )
    fail('codex-control-stale');
}
function initialManifest(plan: ControlPrivatePlan): ControlManifest {
  if (plan.request.operation !== 'disable' || !plan.preview.binding) fail('codex-control-stale');
  const b = plan.preview.binding;
  return {
    schema: 'stroq-codex-skill-control-record/1',
    id: plan.preview.recordId,
    operationId: plan.preview.operationId,
    controlContextId: plan.context.id,
    rootBinding: plan.context.rootBinding,
    target: plan.context.target,
    documentPath: plan.owned.documentPath,
    nativeName: '',
    name: plan.preview.name,
    location: plan.preview.location,
    createdAt: now(),
    updatedAt: now(),
    phase: 'prepared',
    originalSha256: plan.preview.beforeSha256,
    candidateSha256: plan.preview.afterSha256!,
    mode: plan.before.mode,
    beforeBytes: plan.owned.before?.byteLength ?? 0,
    candidateBytes: plan.owned.candidate.byteLength,
    sourceId: b.sourceId,
    candidateId: b.candidateId,
    entrypointSha256: b.entrypointSha256,
    runtimeSha256: b.runtimeSha256,
    staged: null,
    parents: controlParents(plan.before),
    publication: null,
    restoreSha256: null,
    restoreStaged: null,
    restorePublication: null,
    removal: null,
  };
}
/** Durable intent precedes publication. The calling main thread owns the user-wide writer lock. */
export async function applyCodexSkillControl(
  options: ControlOptions,
  plan: ControlPrivatePlan,
  hooks: ControlHooks = {},
): Promise<ControlRecord> {
  await verifyPlan(options, plan);
  await assertNoPendingCodexConfiguration(plan.context, 'skill');
  const vault = await readControlVault(plan.context);
  if (
    vault.count > vault.records.length ||
    vault.pendingStaging ||
    vault.records.some((r) => ['prepared', 'restoring'].includes(r.manifest.phase))
  )
    fail('codex-control-recovery-required');
  const guard = () => planGuard(options, plan);
  let record: ControlRecord;
  if (plan.request.operation === 'disable') {
    const selected = await selectCodexSkillControl(options, plan.request),
      manifest = { ...initialManifest(plan), nativeName: selected.document.name! };
    record = await createControlRecord(
      plan.context,
      manifest,
      plan.owned.before === null ? null : Buffer.from(plan.owned.before),
      Buffer.from(plan.owned.candidate),
      async () => {
        await guard();
        await assertUnchanged(plan.context.user, plan.context.target, plan.before);
      },
    );
  } else {
    const previous = await getControlRecord(
      plan.context,
      plan.request.recordId,
      plan.request.recordRevision,
    );
    const manifest = {
      ...previous.manifest,
      operationId: plan.preview.operationId,
      updatedAt: now(),
      phase: 'restoring' as const,
      restoreSha256: plan.preview.afterSha256,
      restoreStaged: null,
      restorePublication: null,
      removal:
        plan.candidate === null
          ? {
              directory: join(
                dirname(plan.context.target),
                `.stroq-skill-restore-${plan.preview.operationId}.tmp`,
              ),
              directoryPin: null,
              original: plan.before.file!,
              moved: null,
            }
          : null,
    };
    const revision = await saveControlManifest(
      plan.context,
      manifest,
      previous.revision,
      async () => {
        await guard();
        await assertUnchanged(plan.context.user, plan.context.target, plan.before);
      },
    );
    record = await getControlRecord(plan.context, manifest.id, revision);
  }
  try {
    await hooks.fault?.('after-intent');
    await guard();
    let publication: ControlManifest['publication'] = null;
    if (plan.candidate === null) {
      record = await removeCodexSkillConfigToAbsence(options, plan, record, guard, hooks);
    } else {
      const published = await atomicWrite(
        plan.context.user,
        plan.context.target,
        Buffer.from(plan.candidate),
        plan.before,
        undefined,
        {
          fault: async (stage: string, details: { temporary: string }) => {
            if (stage === 'before-rename') {
              const staged = await snapshotFile(plan.context.user, details.temporary, CONFIG_BYTES);
              if (!staged.file || staged.sha256 !== plan.preview.afterSha256)
                fail('codex-control-write-unconfirmed');
              const manifest = {
                ...record.manifest,
                updatedAt: now(),
                parents: controlParents(staged),
                ...(plan.request.operation === 'disable'
                  ? { staged: publishedPin(staged.file) }
                  : { restoreStaged: publishedPin(staged.file) }),
              };
              const revision = await saveControlManifest(
                plan.context,
                manifest,
                record.revision,
                async () => {
                  await guard();
                  await assertUnchanged(plan.context.user, plan.context.target, plan.before);
                },
              );
              record = await getControlRecord(plan.context, manifest.id, revision);
              await hooks.fault?.('after-staged-intent');
              await guard();
            } else if (stage === 'after-rename') await hooks.fault?.('after-target-rename');
          },
        },
      );
      publication = published.file;
      await syncControlDirectory(dirname(plan.context.target));
      const current = await sourceSnapshot(plan.context);
      if (
        current.sha256 !== plan.preview.afterSha256 ||
        !same(current.file, published.file) ||
        !same(controlParents(current), record.manifest.parents)
      )
        fail('codex-control-write-unconfirmed');
    }
    await guard();
    await hooks.fault?.('before-final-metadata');
    const current = await sourceSnapshot(plan.context);
    if (
      nullableHash(current.bytes) !== plan.preview.afterSha256 ||
      !same(controlParents(current), record.manifest.parents)
    )
      fail('codex-control-write-unconfirmed');
    const manifest = {
      ...record.manifest,
      updatedAt: now(),
      phase: plan.request.operation === 'disable' ? ('disabled' as const) : ('restored' as const),
      ...(plan.request.operation === 'disable'
        ? { publication }
        : { restorePublication: publication }),
    };
    const revision = await saveControlManifest(
      plan.context,
      manifest,
      record.revision,
      async () => {
        await guard();
        await assertUnchanged(plan.context.user, plan.context.target, current);
      },
    );
    return await getControlRecord(plan.context, manifest.id, revision);
  } catch {
    fail('codex-control-write-unconfirmed');
  }
}
export async function recheckCodexSkillControl(
  options: ControlOptions,
  context: ControlContext,
  id: string,
  revision: string,
  operationId: string,
) {
  await assertRuntime(options);
  await assertContext(options, context);
  let record = await getControlRecord(context, id, revision);
  if (record.manifest.operationId !== operationId) fail('codex-control-stale');
  const m = record.manifest,
    current = await sourceSnapshot(context);
  const pending = m.phase === 'prepared' || m.phase === 'restoring';
  if (!pending) return record;
  const staged = m.phase === 'prepared' ? m.staged : m.restoreStaged,
    expected = m.phase === 'prepared' ? m.candidateSha256 : m.restoreSha256;
  if (
    !staged ||
    !expected ||
    !current.file ||
    current.sha256 !== expected ||
    !same(publishedPin(current.file), staged) ||
    !same(controlParents(current), m.parents)
  )
    return record;
  const manifest = {
    ...m,
    updatedAt: now(),
    phase: m.phase === 'prepared' ? ('disabled' as const) : ('restored' as const),
    ...(m.phase === 'prepared'
      ? { publication: current.file }
      : { restorePublication: current.file }),
  };
  const next = await saveControlManifest(context, manifest, record.revision, async () => {
    await assertRuntime(options);
    await assertContext(options, context);
    await assertUnchanged(context.user, context.target, current);
  });
  return getControlRecord(context, id, next);
}
