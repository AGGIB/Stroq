import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  escalationIdentity,
  isTaskId,
  newEscalationBody,
  signEscalation,
  stableStringify,
  verifyEscalation,
} from '@stroq/core';
import {
  TASK_ACCESS_LIMITATIONS,
  validateTaskAccessReceipt,
  type TaskAccessReceipt,
} from '../lib/task-access.js';
import {
  assertLocation,
  binding,
  checkDeadline,
  directory,
  fail,
  file,
  filePin,
  hash,
  pin,
  same,
  type FileBinding,
  type FilePin,
  type Location,
  type Options,
  type Pin,
} from './task-lock-files.js';
import { selectedBinding, type Journal } from './task-lock-inspect.js';
import { existingSigningKey } from './task-access-key.js';
import {
  accessInput,
  captureAccess,
  type AccessCapture,
  type AccessInput,
} from './task-access-source.js';
import { assertUnusedSlot, extensionsDirectory, safeUsed } from './task-access-ledger.js';

export type AccessStage =
  | 'access-before-key-read'
  | 'access-before-publish'
  | 'access-after-stage'
  | 'access-after-publish';
export interface AccessHooks {
  fault?: (stage: AccessStage, details: Record<string, unknown>) => Promise<void> | void;
}
interface Plan {
  version: 1;
  workspaceId: string;
  runtimeSha256: string;
  input: AccessInput;
  root: Location;
  key: FileBinding;
  selected: ReturnType<typeof selectedBinding>;
  privateKey: FilePin;
  journal: FileBinding;
  extensionDirectory: Pin | null;
  operation: AccessCapture['operation'];
  createdAt: string;
  grantExpiresAt: string;
}
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const journalBinding = (journal: Journal): FileBinding => {
  if (journal.source?.kind !== 'file') fail('refusal-unavailable');
  return binding(journal.source);
};
function assertPrefix(before: FileBinding, after: Journal): void {
  if (before.kind !== 'file' || after.source?.kind !== 'file') fail('stale-evidence');
  const fresh = after.source,
    length = Number(before.pin.size);
  if (
    ['dev', 'ino', 'uid', 'mode', 'nlink'].some(
      (k) => before.pin[k as keyof FilePin] !== fresh.pin[k as keyof FilePin],
    ) ||
    fresh.bytes.length < length ||
    hash(fresh.bytes.subarray(0, length)) !== before.sha256 ||
    (fresh.bytes.length === length && !same(before.pin, fresh.pin))
  )
    fail('stale-evidence');
}
function makePlan(
  capture: AccessCapture,
  input: AccessInput,
  options: Options,
  extensionDirectory: Pin | null,
): Plan {
  const createdAt = options.now ?? new Date().toISOString();
  const approval = (
    capture.entry as unknown as { approvalRequest: { body: { expiresAt: string } } }
  ).approvalRequest;
  const grantExpiresAt = new Date(
    Math.min(
      Date.parse(createdAt) + 300000,
      Date.parse(capture.selected.signed.body.expiresAt),
      Date.parse(approval.body.expiresAt),
    ),
  ).toISOString();
  if (!(Date.parse(grantExpiresAt) > Date.parse(createdAt))) fail('refusal-unavailable');
  return {
    version: 1,
    workspaceId: options.workspaceId,
    runtimeSha256: options.runtimeSha256,
    input,
    root: capture.root,
    key: binding(capture.key.source),
    selected: selectedBinding(capture.selected),
    privateKey: capture.privateKey,
    journal: journalBinding(capture.journal),
    extensionDirectory,
    operation: capture.operation,
    createdAt,
    grantExpiresAt,
  };
}
export async function previewAccess(value: Record<string, unknown>, options: Options) {
  const input = accessInput(value),
    capture = await captureAccess(input, options);
  const extensionDirectory = await assertUnusedSlot(
    capture.root,
    capture.selected,
    capture.operation.fingerprint,
  );
  const plan = makePlan(capture, input, options, extensionDirectory);
  return {
    task: capture.selected.row,
    operation: capture.operation,
    plan: { ...plan, bindingSha256: hash(stableStringify(plan)) },
    grantExpiresAt: plan.grantExpiresAt,
  };
}
async function assertPlan(
  plan: Plan,
  options: Options,
  expectedDirectory = plan.extensionDirectory,
): Promise<AccessCapture> {
  const fresh = await captureAccess(plan.input, options);
  if (
    !same(fresh.root, plan.root) ||
    !same(binding(fresh.key.source), plan.key) ||
    !same(selectedBinding(fresh.selected), plan.selected) ||
    !same(fresh.privateKey, plan.privateKey) ||
    !same(fresh.operation, plan.operation)
  )
    fail('preview-stale');
  assertPrefix(plan.journal, fresh.journal);
  if (!same(await extensionsDirectory(fresh.root, fresh.selected), expectedDirectory))
    fail('preview-stale');
  return fresh;
}
async function removeOwnStage(path: string, created: FilePin) {
  const current = filePin(await lstat(path, { bigint: true }));
  if (
    ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs'].some(
      (k) => current[k as keyof FilePin] !== created[k as keyof FilePin],
    )
  )
    fail('write-unconfirmed');
  await unlink(path);
}

/** A signature grants one core operation fingerprint; it never launches or retries that operation. */
export async function issueAccess(
  input: Record<string, unknown>,
  options: Options,
  hooks: AccessHooks = {},
): Promise<TaskAccessReceipt> {
  if (options.configurationLockHeld !== true) fail('task-access-failed');
  if (
    Object.keys(input).sort().join(',') !== 'plan,previewId,receiptId' ||
    !object(input.plan) ||
    !uuid(input.previewId) ||
    !uuid(input.receiptId)
  )
    fail('preview-stale');
  const { bindingSha256, ...value } = input.plan;
  const plan = value as unknown as Plan;
  if (
    !sha(bindingSha256) ||
    hash(stableStringify(plan)) !== bindingSha256 ||
    plan.version !== 1 ||
    plan.workspaceId !== options.workspaceId ||
    plan.runtimeSha256 !== options.runtimeSha256 ||
    !plan.selected ||
    !isTaskId(plan.selected.rawId)
  )
    fail('preview-stale');
  const started = performance.now(),
    initialAt = options.now ?? new Date().toISOString();
  const currentOptions = () => ({
    ...options,
    now: new Date(Date.parse(initialAt) + performance.now() - started).toISOString(),
  });
  const currentAt = () => currentOptions().now;
  if (Date.parse(currentAt()) >= Date.parse(plan.grantExpiresAt)) fail('preview-expired');
  let fresh = await assertPlan(plan, currentOptions());
  await assertUnusedSlot(fresh.root, fresh.selected, plan.operation.fingerprint);
  await hooks.fault?.('access-before-key-read', {});
  checkDeadline(options);
  const key = await existingSigningKey(
    plan.root,
    plan.privateKey,
    fresh.key.key!,
    fresh.selected.signed.keyId,
  );
  const body = fresh.selected.signed.body;
  const candidate = JSON.stringify(
    signEscalation(
      newEscalationBody({
        taskId: fresh.selected.rawId,
        nonce: body.nonce,
        fingerprint: plan.operation.fingerprint,
        now: new Date(plan.createdAt),
        ttlMs: Date.parse(plan.grantExpiresAt) - Date.parse(plan.createdAt),
      }),
      key,
    ),
  );
  if (
    !verifyEscalation(candidate, fresh.key.key!, {
      now: new Date(currentAt()),
      nonce: body.nonce,
      taskId: fresh.selected.rawId,
      fingerprint: plan.operation.fingerprint,
    }).ok
  )
    fail('preview-expired');
  const taskPath = join(plan.root.home, 'tasks', fresh.selected.rawId),
    dirPath = join(taskPath, 'extensions');
  const finalPath = join(dirPath, `${plan.operation.fingerprint}.json`);
  const usedPath = join(
    dirPath,
    `${plan.operation.fingerprint}.${escalationIdentity(candidate)}.used`,
  );
  await hooks.fault?.('access-before-publish', { finalPath, usedPath });
  checkDeadline(options);
  fresh = await assertPlan(plan, currentOptions());
  await assertUnusedSlot(fresh.root, fresh.selected, plan.operation.fingerprint);
  if (Date.parse(currentAt()) >= Date.parse(plan.grantExpiresAt)) fail('preview-expired');
  if ((await safeUsed(usedPath)) !== 'missing') fail('preview-stale');
  let parent,
    output,
    stage: string | null = null,
    staged: FilePin | null = null,
    committed = false;
  let directoryPin = plan.extensionDirectory;
  try {
    if (directoryPin === null) {
      try {
        await mkdir(dirPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') fail('preview-stale');
        throw error;
      }
      directoryPin = await directory(dirPath);
      if (directoryPin === null || (Number(directoryPin.mode) & 0o777) !== 0o700)
        fail('unsafe-source');
    }
    parent = await open(
      dirPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    if (!same(pin(await parent.stat({ bigint: true })), directoryPin)) fail('preview-stale');
    stage = join(dirPath, `.task-access-${randomUUID()}.tmp`);
    output = await open(
      stage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await output.chmod(0o600);
    await output.writeFile(candidate, 'utf8');
    await output.sync();
    staged = filePin(await output.stat({ bigint: true }));
    await output.close();
    output = undefined;
    await hooks.fault?.('access-after-stage', { finalPath, usedPath, stage });
    // Recheck every mutable source after staging. No destination is ever replaced.
    await assertPlan(plan, currentOptions(), directoryPin);
    const stageRead = await file(stage, 16384);
    if (
      stageRead.kind !== 'file' ||
      !same(stageRead.pin, staged) ||
      stageRead.text !== candidate ||
      stageRead.sha256 !== hash(candidate)
    )
      fail('preview-stale');
    if (
      !same(await directory(taskPath), plan.selected.directoryPin) ||
      !same(await directory(dirPath), directoryPin) ||
      !same(binding(await file(join(taskPath, 'permit.json'), 65536)), plan.selected.source)
    )
      fail('preview-stale');
    if (Date.parse(currentAt()) >= Date.parse(plan.grantExpiresAt)) fail('preview-expired');
    await assertUnusedSlot(fresh.root, fresh.selected, plan.operation.fingerprint);
    if ((await safeUsed(usedPath)) !== 'missing') fail('preview-stale');
    await link(stage, finalPath);
    committed = true;
    await removeOwnStage(stage, staged);
    stage = null;
    await parent.sync();
    await hooks.fault?.('access-after-publish', { finalPath, usedPath, candidate });
    checkDeadline(options);
    const consumedBeforeReadback = (await safeUsed(usedPath)) === 'consumed';
    const after = await captureAccess(plan.input, currentOptions(), consumedBeforeReadback);
    assertPrefix(plan.journal, after.journal);
    const afterSelected = selectedBinding(after.selected);
    let safeEnded = false;
    if (
      consumedBeforeReadback &&
      plan.selected.ended.kind === 'missing' &&
      afterSelected.ended.kind === 'present'
    ) {
      const ended = await file(join(taskPath, 'ended'), 0);
      safeEnded =
        ended.kind === 'file' &&
        (Number(ended.pin.mode) & 0o777) === 0o600 &&
        same({ ...afterSelected, ended: plan.selected.ended }, plan.selected);
    }
    if (
      !same(after.root, plan.root) ||
      !same(binding(after.key.source), plan.key) ||
      (!same(afterSelected, plan.selected) && !safeEnded) ||
      !same(after.privateKey, plan.privateKey) ||
      !same(after.operation, plan.operation) ||
      !same(await extensionsDirectory(after.root, after.selected), directoryPin)
    )
      fail('write-unconfirmed');
    const readback = await file(finalPath, 16384);
    if (
      readback.kind !== 'file' ||
      readback.text !== candidate ||
      readback.sha256 !== hash(candidate) ||
      (Number(readback.pin.mode) & 0o777) !== 0o600 ||
      readback.pin.dev !== staged.dev ||
      readback.pin.ino !== staged.ino ||
      readback.pin.mtimeNs !== staged.mtimeNs ||
      !verifyEscalation(readback.text, after.key.key!, {
        now: new Date(currentAt()),
        nonce: body.nonce,
        taskId: after.selected.rawId,
        fingerprint: plan.operation.fingerprint,
      }).ok
    )
      fail('write-unconfirmed');
    const used = await safeUsed(usedPath);
    if (safeEnded && used !== 'consumed') fail('write-unconfirmed');
    const receipt: TaskAccessReceipt = {
      schema: 'stroq-task-access-receipt/1',
      id: input.receiptId,
      previewId: input.previewId,
      workspaceId: options.workspaceId,
      incident: {
        id: plan.input.id,
        evidenceSha256: plan.input.expectedEvidenceSha,
        sequence: plan.input.sequence,
        recordedAt: plan.input.recordedAt,
      },
      taskId: after.selected.row.id,
      permitSha256: after.selected.row.permitSha256,
      fingerprint: plan.operation.fingerprint,
      extensionSha256: readback.sha256,
      issuedAt: plan.createdAt,
      expiresAt: plan.grantExpiresAt,
      state: used === 'consumed' ? 'consumed' : 'unused',
      execution: 'unverified',
      limitations: TASK_ACCESS_LIMITATIONS,
    };
    if (!validateTaskAccessReceipt(receipt)) fail('write-unconfirmed');
    return receipt;
  } catch (error) {
    if (committed) fail('write-unconfirmed');
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') fail('permission-active');
    throw error;
  } finally {
    let cleanupFailed = false;
    try {
      await output?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (!committed && stage !== null && staged !== null) await removeOwnStage(stage, staged);
    } catch {
      cleanupFailed = true;
    }
    try {
      await parent?.close();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) fail(committed ? 'write-unconfirmed' : 'task-access-failed');
  }
}
