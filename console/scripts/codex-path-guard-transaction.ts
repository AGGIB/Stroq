import { atomicWrite, assertUnchanged, snapshotFile } from './agent-setup-files.mjs';
import { planCodexPathGuard } from './codex-path-guard-toml.ts';
import { validateCodexPathGuardPrivatePlan } from '../lib/codex-path-guard-private.ts';
import {
  assertPathGuardCapture,
  assertPathGuardDependencies,
  restorePathGuardRecord,
} from './codex-path-guard-capture.ts';
import { assertPathGuardTargets } from './codex-path-guard-targets.ts';
import { assertPathGuardSelectorOwnership } from './codex-configuration-ownership.ts';
import { assertNoPendingCodexConfiguration } from './codex-configuration-pending.ts';
import {
  assertContext,
  assertRuntime,
  captureGuardNative,
  sourceSnapshot,
  controlParents,
  publishedPin,
  nullableHash,
  same,
  pathFail,
  CONFIG_BYTES,
  type GuardOptions,
  type GuardHooks,
  type PathGuardManifest,
  type PathGuardRecord,
  type CodexPathGuardPrivatePlan,
  type ControlContext,
} from './codex-path-guard-binding.ts';
import { pathGuardOwnedKeys, assertPathGuardOwnership } from './codex-path-guard-ownership.ts';
import {
  readPathGuardVault,
  createPathGuardRecord,
  getPathGuardRecord,
  savePathGuardManifest,
  syncPathGuardDirectory,
} from './codex-path-guard-store.ts';
import { dirname } from 'node:path';
import type { PathPrivateCapture } from '../lib/codex-path-guard-private.ts';
import type { PrivateControlSnapshot } from '../lib/codex-skill-controls-private.ts';
import type { PathGuardCapture, Snapshot } from './codex-path-guard-binding.ts';
const now = () => new Date().toISOString();
/** Structured clone transports Buffer as Uint8Array; restore checked server snapshot buffers. */
function serverCapture(capture: PathPrivateCapture): PathGuardCapture {
  const snapshot = (s: PrivateControlSnapshot): Snapshot =>
    s.bytes === null ? { ...s, bytes: null, file: null } : { ...s, bytes: Buffer.from(s.bytes) };
  return {
    ...capture,
    before: snapshot(capture.before),
    sources: capture.sources.map((s) => ({ ...s, snapshot: snapshot(s.snapshot) })),
    base: {
      ...capture.base,
      before: snapshot(capture.base.before),
      sources: capture.base.sources.map((s) => ({ ...s, snapshot: snapshot(s.snapshot) })),
    },
  };
}
async function contextGuard(
  options: GuardOptions,
  plan: CodexPathGuardPrivatePlan,
  hooks: GuardHooks,
) {
  if (Date.now() >= Date.parse(plan.preview.expiresAt)) pathFail('codex-path-guard-stale');
  await assertRuntime(options);
  await assertContext(options, plan.context);
  const native = await (hooks.nativeCapture ?? captureGuardNative)(options);
  if (!same(native, plan.capture.native)) pathFail('codex-path-guard-native-changed');
  await assertPathGuardDependencies(options, serverCapture(plan.capture));
  await assertPathGuardSelectorOwnership(plan.context, plan.owned.profileName);
}
async function verifyPlan(
  options: GuardOptions,
  plan: CodexPathGuardPrivatePlan,
  hooks: GuardHooks,
) {
  if (!validateCodexPathGuardPrivatePlan(plan)) pathFail('codex-path-guard-stale');
  await contextGuard(options, plan, hooks);
  const fresh = await assertPathGuardCapture(
    options,
    serverCapture(plan.capture),
    hooks,
    plan.request.operation,
  );
  if (!same(fresh.binding, plan.capture.binding) && plan.request.operation === 'guard')
    pathFail('codex-path-guard-stale');
  const current = await sourceSnapshot(plan.context);
  if (!same({ ...current, bytes: null }, { ...plan.before, bytes: null }))
    pathFail('codex-path-guard-stale');
  let candidate: Uint8Array | null;
  if (plan.request.operation === 'guard') {
    if (
      !fresh.public.presets.some((p) => p.id === plan.preview.presetId && p.canGuard) ||
      fresh.profileName !== plan.owned.profileName
    )
      pathFail('codex-path-guard-stale');
    const derived = planCodexPathGuard({
      bytes: current.bytes,
      operationId: plan.preview.recordId,
      targetPath: plan.owned.targetPath,
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
      pathFail('codex-path-guard-stale');
  } else {
    const record = await getPathGuardRecord(
      plan.context,
      plan.request.recordId,
      plan.request.recordRevision,
    );
    assertPathGuardOwnership(record, (await readPathGuardVault(plan.context)).records);
    if (
      record.manifest.phase !== 'guarded' ||
      record.manifest.presetId !== plan.preview.presetId ||
      !same(controlParents(current), record.manifest.parents) ||
      !same(
        { ...record.owned, before: null, candidate: null },
        { ...plan.owned, before: null, candidate: null },
      ) ||
      !Buffer.from(record.owned.before).equals(Buffer.from(plan.owned.before)) ||
      !Buffer.from(record.owned.candidate).equals(Buffer.from(plan.owned.candidate))
    )
      pathFail('codex-path-guard-conflict');
    if (current.bytes === null) pathFail('codex-path-guard-conflict');
    candidate = await restorePathGuardRecord(options, fresh, record);
  }
  if (
    candidate === null ||
    !Buffer.from(candidate).equals(Buffer.from(plan.candidate ?? [])) ||
    nullableHash(Buffer.from(candidate)) !== plan.preview.afterSha256
  )
    pathFail('codex-path-guard-stale');
}
function initialManifest(plan: CodexPathGuardPrivatePlan, sequence: number): PathGuardManifest {
  return {
    schema: 'stroq-codex-path-record/1',
    id: plan.preview.recordId,
    operationId: plan.preview.operationId,
    controlContextId: plan.context.id,
    rootBinding: plan.context.rootBinding,
    target: plan.context.target,
    sequence,
    ownedKeys: pathGuardOwnedKeys(plan.owned),
    kind: plan.preview.kind,
    presetId: plan.preview.presetId,
    profileName: plan.owned.profileName,
    credentialTarget: plan.owned.targetPath,
    targetMetadataSha256: plan.capture.binding.targetMetadataSha256,
    dependencySha256: plan.capture.dependencySha256,
    createdAt: now(),
    updatedAt: now(),
    phase: 'prepared',
    originalSha256: plan.preview.beforeSha256!,
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
export async function applyPathGuard(
  options: GuardOptions,
  plan: CodexPathGuardPrivatePlan,
  hooks: GuardHooks = {},
): Promise<PathGuardRecord> {
  await verifyPlan(options, plan, hooks);
  await assertNoPendingCodexConfiguration(plan.context, 'path');
  const guard = () => contextGuard(options, plan, hooks);
  const beforeCommit = async () => {
    await guard();
    if (plan.request.operation === 'guard')
      await assertPathGuardTargets(plan.context.user, plan.capture.targets);
    try {
      await assertUnchanged(plan.context.user, plan.context.target, plan.before);
    } catch {
      pathFail('codex-path-guard-stale');
    }
  };
  let record: PathGuardRecord;
  if (plan.request.operation === 'guard')
    record = await createPathGuardRecord(
      plan.context,
      initialManifest(
        plan,
        Math.max(
          0,
          ...(await readPathGuardVault(plan.context)).records.map((r) => r.manifest.sequence),
        ) + 1,
      ),
      plan.owned.before === null ? null : Buffer.from(plan.owned.before),
      Buffer.from(plan.owned.candidate),
      beforeCommit,
    );
  else {
    const previous = await getPathGuardRecord(
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
    const revision = await savePathGuardManifest(
      plan.context,
      manifest,
      previous.revision,
      beforeCommit,
    );
    record = await getPathGuardRecord(plan.context, manifest.id, revision);
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
        fault: async (stage?: string, details?: { temporary: string }) => {
          if (stage === 'before-rename') {
            if (!details) pathFail('codex-path-guard-write-unconfirmed');
            const staged = await snapshotFile(plan.context.user, details.temporary, CONFIG_BYTES);
            if (!staged.file || staged.sha256 !== plan.preview.afterSha256)
              pathFail('codex-path-guard-write-unconfirmed');
            const manifest = {
              ...record.manifest,
              updatedAt: now(),
              parents: controlParents(staged),
              ...(plan.request.operation === 'guard'
                ? { staged: publishedPin(staged.file) }
                : { restoreStaged: publishedPin(staged.file) }),
            };
            const revision = await savePathGuardManifest(
              plan.context,
              manifest,
              record.revision,
              beforeCommit,
            );
            record = await getPathGuardRecord(plan.context, manifest.id, revision);
            await hooks.fault?.('after-staged-intent');
            await beforeCommit();
          } else if (stage === 'after-rename') await hooks.fault?.('after-target-rename');
        },
      },
    );
    await syncPathGuardDirectory(dirname(plan.context.target));
    await guard();
    await hooks.fault?.('before-final-metadata');
    const current = await sourceSnapshot(plan.context);
    if (
      !same(current.file, published.file) ||
      current.sha256 !== plan.preview.afterSha256 ||
      !same(controlParents(current), record.manifest.parents)
    )
      pathFail('codex-path-guard-write-unconfirmed');
    const manifest = {
      ...record.manifest,
      updatedAt: now(),
      phase: plan.request.operation === 'guard' ? ('guarded' as const) : ('restored' as const),
      ...(plan.request.operation === 'guard'
        ? { publication: current.file }
        : { restorePublication: current.file }),
    };
    const revision = await savePathGuardManifest(
      plan.context,
      manifest,
      record.revision,
      async () => {
        await guard();
        await assertUnchanged(plan.context.user, plan.context.target, current);
      },
    );
    return getPathGuardRecord(plan.context, manifest.id, revision);
  } catch {
    pathFail('codex-path-guard-write-unconfirmed');
  }
}
export async function recheckPathGuard(
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
  let record = await getPathGuardRecord(context, id, revision);
  if (
    record.manifest.operationId !== operationId ||
    record.manifest.nativeBinarySha256 !== native.sha256
  )
    pathFail('codex-path-guard-stale');
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
  const next = await savePathGuardManifest(context, manifest, record.revision, async () => {
    await assertRuntime(options);
    await assertContext(options, context);
    if (!same(await (hooks.nativeCapture ?? captureGuardNative)(options), native))
      pathFail('codex-path-guard-native-changed');
    await assertUnchanged(context.user, context.target, current);
  });
  return getPathGuardRecord(context, id, next);
}
