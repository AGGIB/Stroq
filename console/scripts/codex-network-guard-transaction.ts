import { atomicWrite, assertUnchanged, snapshotFile } from './agent-setup-files.mjs';
import { planCodexNetworkGuard, restoreCodexNetworkGuard } from './codex-network-guard-toml.ts';
import { validateCodexNetworkGuardPrivatePlan } from '../lib/codex-network-guard-private.ts';
import { assertNetworkCapture, assertNetworkSources } from './codex-network-guard-capture.ts';
import { assertNoPendingCodexConfiguration } from './codex-configuration-pending.ts';
import { assertNetworkGuardRestoreOwnership } from './codex-configuration-ownership.ts';
import {
  assertContext,
  assertRuntime,
  captureGuardNative,
  sourceSnapshot,
  controlParents,
  publishedPin,
  nullableHash,
  same,
  networkFail,
  CONFIG_BYTES,
  type GuardOptions,
  type GuardHooks,
  type GuardManifest,
  type GuardRecord,
  type CodexNetworkGuardPrivatePlan,
  type ControlContext,
} from './codex-network-guard-binding.ts';
import { guardOwnedKeys, assertGuardOwnership } from './codex-network-guard-ownership.ts';
import {
  readNetworkGuardVault,
  createNetworkGuardRecord,
  getNetworkGuardRecord,
  saveNetworkGuardManifest,
  syncNetworkGuardDirectory,
} from './codex-network-guard-store.ts';
import { dirname } from 'node:path';
const now = () => new Date().toISOString();
async function contextGuard(
  options: GuardOptions,
  plan: CodexNetworkGuardPrivatePlan,
  hooks: GuardHooks,
) {
  if (Date.now() >= Date.parse(plan.preview.expiresAt)) networkFail('codex-network-stale');
  await assertRuntime(options);
  await assertContext(options, plan.context);
  const native = await (hooks.nativeCapture ?? captureGuardNative)(options);
  if (!same(native, plan.capture.native)) networkFail('codex-network-native-changed');
  await assertNetworkSources(options, plan.capture);
  if (plan.request.operation === 'restore')
    await assertNetworkGuardRestoreOwnership(
      plan.context,
      await getNetworkGuardRecord(plan.context, plan.preview.recordId),
    );
}
async function verifyPlan(
  options: GuardOptions,
  plan: CodexNetworkGuardPrivatePlan,
  hooks: GuardHooks,
) {
  if (!validateCodexNetworkGuardPrivatePlan(plan)) networkFail('codex-network-stale');
  await contextGuard(options, plan, hooks);
  await assertNetworkCapture(options, plan.capture, hooks);
  const current = await sourceSnapshot(plan.context);
  if (!same({ ...current, bytes: null }, { ...plan.before, bytes: null }))
    networkFail('codex-network-stale');
  let candidate: Uint8Array | null;
  if (plan.request.operation === 'guard') {
    if (!plan.capture.public.canGuard || plan.capture.kind !== plan.preview.kind)
      networkFail('codex-network-stale');
    const derived = planCodexNetworkGuard({
      bytes: current.bytes,
      operationId: plan.preview.recordId,
      kind: plan.preview.kind,
    });
    candidate = derived.bytes;
    if (
      !same(
        { ...derived.owned, before: null, candidate: null },
        { ...plan.owned, before: null, candidate: null },
      ) ||
      !Buffer.from(derived.owned.candidate).equals(Buffer.from(plan.owned.candidate)) ||
      !same(current.bytes, plan.owned.before === null ? null : Buffer.from(plan.owned.before))
    )
      networkFail('codex-network-stale');
  } else {
    const record = await getNetworkGuardRecord(
      plan.context,
      plan.request.recordId,
      plan.request.recordRevision,
    );
    assertGuardOwnership(record, (await readNetworkGuardVault(plan.context)).records);
    await assertNetworkGuardRestoreOwnership(plan.context, record);
    if (
      record.manifest.phase !== 'guarded' ||
      !same(controlParents(current), record.manifest.parents) ||
      !Buffer.from(record.owned.candidate).equals(Buffer.from(plan.owned.candidate))
    )
      networkFail('codex-network-conflict');
    if (current.bytes === null) networkFail('codex-network-conflict');
    candidate = restoreCodexNetworkGuard({ bytes: current.bytes, owned: record.owned });
  }
  if (
    candidate === null ||
    !Buffer.from(candidate).equals(Buffer.from(plan.candidate ?? [])) ||
    nullableHash(Buffer.from(candidate)) !== plan.preview.afterSha256
  )
    networkFail('codex-network-stale');
}
function initialManifest(plan: CodexNetworkGuardPrivatePlan, sequence: number): GuardManifest {
  return {
    schema: 'stroq-codex-network-record/1',
    id: plan.preview.recordId,
    operationId: plan.preview.operationId,
    controlContextId: plan.context.id,
    rootBinding: plan.context.rootBinding,
    target: plan.context.target,
    sequence,
    ownedKeys: guardOwnedKeys(plan.owned),
    kind: plan.preview.kind,
    parentProfile: plan.owned.parentProfile,
    childProfile: plan.owned.childProfile,
    createdAt: now(),
    updatedAt: now(),
    phase: 'prepared',
    originalSha256: plan.preview.beforeSha256,
    candidateSha256: plan.preview.afterSha256!,
    beforeBytes: plan.owned.before?.byteLength ?? 0,
    candidateBytes: plan.owned.candidate.byteLength,
    mode: plan.before.mode,
    nativeBinarySha256: plan.capture.native.sha256,
    captureSha256: plan.capture.binding.captureSha256,
    sourceGraphSha256: plan.capture.binding.sourceGraphSha256,
    staged: null,
    parents: controlParents(plan.before),
    publication: null,
    restoreSha256: null,
    restoreStaged: null,
    restorePublication: null,
  };
}
/** Main owns the shared Codex writer lock until this worker has exited. */
export async function applyNetworkGuard(
  options: GuardOptions,
  plan: CodexNetworkGuardPrivatePlan,
  hooks: GuardHooks = {},
): Promise<GuardRecord> {
  await verifyPlan(options, plan, hooks);
  await assertNoPendingCodexConfiguration(plan.context, 'network');
  const guard = () => contextGuard(options, plan, hooks);
  const beforeCommit = async () => {
    await guard();
    await assertUnchanged(plan.context.user, plan.context.target, plan.before);
  };
  let record: GuardRecord;
  if (plan.request.operation === 'guard')
    record = await createNetworkGuardRecord(
      plan.context,
      initialManifest(
        plan,
        Math.max(
          0,
          ...(await readNetworkGuardVault(plan.context)).records.map((r) => r.manifest.sequence),
        ) + 1,
      ),
      plan.owned.before === null ? null : Buffer.from(plan.owned.before),
      Buffer.from(plan.owned.candidate),
      beforeCommit,
    );
  else {
    const previous = await getNetworkGuardRecord(
        plan.context,
        plan.request.recordId,
        plan.request.recordRevision,
      ),
      manifest = {
        ...previous.manifest,
        operationId: plan.preview.operationId,
        updatedAt: now(),
        phase: 'restoring' as const,
        restoreSha256: plan.preview.afterSha256,
        restoreStaged: null,
        restorePublication: null,
      };
    const revision = await saveNetworkGuardManifest(
      plan.context,
      manifest,
      previous.revision,
      beforeCommit,
    );
    record = await getNetworkGuardRecord(plan.context, manifest.id, revision);
  }
  try {
    await hooks.fault?.('after-intent');
    await beforeCommit();
    const published = await atomicWrite(
      plan.context.user,
      plan.context.target,
      Buffer.from(plan.candidate!),
      plan.before,
      undefined,
      {
        fault: async (stage: string, details: { temporary: string }) => {
          if (stage === 'before-rename') {
            const staged = await snapshotFile(plan.context.user, details.temporary, CONFIG_BYTES);
            if (!staged.file || staged.sha256 !== plan.preview.afterSha256)
              networkFail('codex-network-write-unconfirmed');
            const manifest = {
              ...record.manifest,
              updatedAt: now(),
              parents: controlParents(staged),
              ...(plan.request.operation === 'guard'
                ? { staged: publishedPin(staged.file) }
                : { restoreStaged: publishedPin(staged.file) }),
            };
            const revision = await saveNetworkGuardManifest(
              plan.context,
              manifest,
              record.revision,
              beforeCommit,
            );
            record = await getNetworkGuardRecord(plan.context, manifest.id, revision);
            await hooks.fault?.('after-staged-intent');
            await beforeCommit();
          } else if (stage === 'after-rename') await hooks.fault?.('after-target-rename');
        },
      },
    );
    await syncNetworkGuardDirectory(dirname(plan.context.target));
    await guard();
    await hooks.fault?.('before-final-metadata');
    const current = await sourceSnapshot(plan.context);
    if (
      !same(current.file, published.file) ||
      current.sha256 !== plan.preview.afterSha256 ||
      !same(controlParents(current), record.manifest.parents)
    )
      networkFail('codex-network-write-unconfirmed');
    const manifest = {
      ...record.manifest,
      updatedAt: now(),
      phase: plan.request.operation === 'guard' ? ('guarded' as const) : ('restored' as const),
      ...(plan.request.operation === 'guard'
        ? { publication: current.file }
        : { restorePublication: current.file }),
    };
    const revision = await saveNetworkGuardManifest(
      plan.context,
      manifest,
      record.revision,
      async () => {
        await guard();
        await assertUnchanged(plan.context.user, plan.context.target, current);
      },
    );
    return getNetworkGuardRecord(plan.context, manifest.id, revision);
  } catch {
    networkFail('codex-network-write-unconfirmed');
  }
}
export async function recheckNetworkGuard(
  options: GuardOptions,
  context: ControlContext,
  id: string,
  revision: string,
  operationId: string,
  hooks: GuardHooks = {},
) {
  await assertRuntime(options);
  await assertContext(options, context);
  const native = await (hooks.nativeCapture ?? captureGuardNative)(options);
  let record = await getNetworkGuardRecord(context, id, revision);
  if (
    record.manifest.operationId !== operationId ||
    record.manifest.nativeBinarySha256 !== native.sha256
  )
    networkFail('codex-network-stale');
  const m = record.manifest;
  if (!['prepared', 'restoring'].includes(m.phase)) return record;
  const current = await sourceSnapshot(context),
    staged = m.phase === 'prepared' ? m.staged : m.restoreStaged,
    expected = m.phase === 'prepared' ? m.candidateSha256 : m.restoreSha256;
  if (
    !staged ||
    !current.file ||
    !expected ||
    current.sha256 !== expected ||
    !same(publishedPin(current.file), staged) ||
    !same(controlParents(current), m.parents)
  )
    return record;
  const manifest = {
    ...m,
    updatedAt: now(),
    phase: m.phase === 'prepared' ? ('guarded' as const) : ('restored' as const),
    ...(m.phase === 'prepared'
      ? { publication: current.file }
      : { restorePublication: current.file }),
  };
  const next = await saveNetworkGuardManifest(context, manifest, record.revision, async () => {
    await assertRuntime(options);
    await assertContext(options, context);
    if (!same(await (hooks.nativeCapture ?? captureGuardNative)(options), native))
      networkFail('codex-network-native-changed');
    await assertUnchanged(context.user, context.target, current);
  });
  return getNetworkGuardRecord(context, id, next);
}
