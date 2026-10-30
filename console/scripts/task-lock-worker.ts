import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import {
  FilePermitStore,
  createScopeGate,
  isCanonicalIso,
  isTaskId,
  stableStringify,
} from '@stroq/core';
import {
  TASK_LOCK_LIMITATIONS,
  validateTaskLockReceipt,
  validateTaskLockState,
  type TaskLockRow,
  type TaskLockState,
} from '../lib/task-locks.js';
import {
  assertLocation,
  binding,
  checkDeadline,
  directory,
  fail,
  file,
  filePin,
  hash,
  marker,
  pin,
  same,
  type FileBinding,
  type Location,
  type Options,
} from './task-lock-files.js';
import {
  captureJournal,
  evidenceFor,
  inspectTask,
  publicKey,
  selectedBinding,
  taskId,
  type Selected,
} from './task-lock-inspect.js';
import {
  assertTaskCatalog,
  captureKnownTask,
  captureSelectedTask,
  captureTaskCatalog,
  captureTaskPage,
  nativeTaskForId,
  TASK_PAGE_SIZE,
} from './task-lock-catalog.js';
import { inspectIncidentTask } from './task-lock-incident.js';
import { previewAccess, issueAccess, type AccessStage } from './task-access-worker.js';
import { accessState } from './task-access-ledger.js';
import { runSessionTaintWorker } from './session-taint-worker.ts';
import { SESSION_TAINT_ERRORS } from '../lib/session-taint.ts';
import { isHiddenCharacterError } from '../lib/task-access-review.ts';

interface Request {
  operation:
    | 'state'
    | 'page'
    | 'preview'
    | 'apply'
    | 'incident'
    | 'access-preview'
    | 'access-issue'
    | 'access-state'
    | `taint-${string}`;
  input?: Record<string, unknown>;
  options: Options;
}
interface Hooks {
  fault?: (
    stage: 'before-commit' | 'after-commit' | 'after-incident-capture' | AccessStage,
    details: Record<string, unknown>,
  ) => Promise<void> | void;
}
interface Plan {
  version: 1;
  workspaceId: string;
  id: string;
  taskId: string;
  runtimeSha256: string;
  location: Location;
  key: FileBinding;
  selected: ReturnType<typeof selectedBinding>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

function at(options: Options): string {
  const result = options.now ?? new Date().toISOString();
  if (!isCanonicalIso(result)) fail('context-unavailable');
  return result;
}
function unavailable(
  options: Options,
  checkedAt: string,
  reason: TaskLockState['reason'],
): TaskLockState {
  return {
    schema: 'stroq-task-locks/1',
    workspaceId: options.workspaceId,
    host: 'claude-code',
    checkedAt,
    currentPolicySha256: null,
    available: false,
    reason,
    coverage: { complete: false, limited: false, unverified: 1, foreign: 0 },
    tasks: [],
    limitations: TASK_LOCK_LIMITATIONS,
  };
}
function makePlan(options: Options, root: Location, key: FileBinding, selected: Selected): Plan {
  return {
    version: 1,
    workspaceId: options.workspaceId,
    id: selected.row.id,
    taskId: selected.rawId,
    runtimeSha256: options.runtimeSha256,
    location: root,
    key,
    selected: selectedBinding(selected),
  };
}

async function state(
  options: Options,
  provided?: Awaited<ReturnType<typeof captureTaskPage>>,
  checkedAt = at(options),
  preferredId?: string,
): Promise<TaskLockState> {
  if ((options.platform ?? process.platform) === 'win32')
    return unavailable(options, checkedAt, 'platform-unsupported');
  if (!sha(options.runtimeSha256) || typeof options.engineVersion !== 'string')
    return unavailable(options, checkedAt, 'runtime-unavailable');
  let capture = provided;
  try {
    capture ??= await captureTaskPage(options, checkedAt, await captureTaskCatalog(options), 0);
  } catch (error) {
    if (error instanceof Error && error.message === 'deadline-exceeded') throw error;
    return unavailable(options, checkedAt, 'context-unavailable');
  }
  const journal = await captureJournal(capture.root);
  const tasks: TaskLockRow[] = [];
  let bytes = 0;
  const ordered = preferredId
    ? [...capture.selected].sort(
        (a, b) => Number(b.row.id === preferredId) - Number(a.row.id === preferredId),
      )
    : capture.selected;
  for (const selected of ordered) {
    const row = { ...selected.row, evidence: evidenceFor(journal, selected) };
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 480 * 1024) {
      capture.coverage.limited = true;
      capture.coverage.complete = false;
      break;
    }
    tasks.push(row);
  }
  await assertTaskCatalog(options, capture.catalog);
  const result: TaskLockState = {
    schema: 'stroq-task-locks/1',
    workspaceId: options.workspaceId,
    host: 'claude-code',
    checkedAt,
    currentPolicySha256: capture.policy,
    available: true,
    reason: null,
    coverage: capture.coverage,
    tasks,
    limitations: TASK_LOCK_LIMITATIONS,
  };
  if (!validateTaskLockState(result)) fail('invalid-report');
  return result;
}

async function page(input: Record<string, unknown>, options: Options) {
  const checkedAt = at(options);
  let offset: number,
    expectedListingSha256: string | null = null,
    selectedId: string | undefined;
  if (!object(input)) fail('task-page-stale');
  const fields = Object.keys(input).sort().join(',');
  if (Reflect.ownKeys(input).length !== Object.keys(input).length) fail('task-page-stale');
  if (fields === 'expectedListingSha256,offset') {
    if (
      !Number.isSafeInteger(input.offset) ||
      Number(input.offset) < 0 ||
      Number(input.offset) >= 8192 ||
      Number(input.offset) % TASK_PAGE_SIZE !== 0 ||
      !(input.expectedListingSha256 === null || sha(input.expectedListingSha256))
    )
      fail('task-page-stale');
    offset = Number(input.offset);
    expectedListingSha256 = input.expectedListingSha256 as string | null;
  } else if (fields === 'expectedPermitSha256,id') {
    if (
      typeof input.id !== 'string' ||
      !/^task-[a-f0-9]{64}$/.test(input.id) ||
      !(input.expectedPermitSha256 === null || sha(input.expectedPermitSha256))
    )
      fail('task-unavailable');
    selectedId = input.id;
    offset = 0;
  } else fail('task-page-stale');
  const catalog = await captureTaskCatalog(options);
  if (selectedId) {
    const raw = nativeTaskForId(catalog, options.workspaceId, selectedId);
    offset = Math.floor(catalog.names.indexOf(raw) / TASK_PAGE_SIZE) * TASK_PAGE_SIZE;
  } else if (
    (offset > 0 && expectedListingSha256 === null) ||
    (expectedListingSha256 !== null && expectedListingSha256 !== catalog.sha256) ||
    (offset > 0 && offset >= catalog.names.length)
  )
    fail('task-page-stale');
  const capture = await captureTaskPage(options, checkedAt, catalog, offset);
  if (selectedId) {
    const selected = capture.selected.find((item) => item.row.id === selectedId);
    if (!selected) fail('task-unavailable');
    if (
      input.expectedPermitSha256 !== null &&
      selected.row.permitSha256 !== input.expectedPermitSha256
    )
      fail('preview-stale');
  }
  return {
    state: await state(options, capture, checkedAt, selectedId),
    listing: {
      sha256: catalog.sha256,
      offset,
      total: catalog.names.length,
      limited: catalog.limited,
    },
  };
}

async function preview(input: Record<string, unknown>, options: Options) {
  const checkedAt = at(options);
  if (
    !object(input) ||
    Object.keys(input).sort().join(',') !== 'expectedPermitSha256,id' ||
    typeof input.id !== 'string' ||
    !/^task-[a-f0-9]{64}$/.test(input.id) ||
    !sha(input.expectedPermitSha256)
  )
    fail('task-unavailable');
  const capture = await captureSelectedTask(
    options,
    checkedAt,
    input.id,
    input.expectedPermitSha256 as string,
  );
  const selected = capture.selected;
  selected.row.evidence = evidenceFor(await captureJournal(capture.root), selected);
  const plan = makePlan(options, capture.root, binding(capture.key.source), selected);
  const reason =
    selected.row.standing === 'revoked'
      ? ('already-revoked' as const)
      : selected.row.standing === 'ended'
        ? ('task-ended' as const)
        : selected.row.eligibility === 'expired'
          ? ('permit-expired' as const)
          : null;
  await assertLocation(options, capture.root);
  return {
    task: selected.row,
    plan,
    bindingSha256: hash(stableStringify(plan)),
    canApply: reason === null,
    reason,
  };
}

async function assertPlan(plan: Plan, options: Options, checkedAt: string): Promise<Selected> {
  try {
    await assertLocation(options, plan.location);
    const key = await publicKey(plan.location);
    if (!same(binding(key.source), plan.key)) fail('preview-stale');
    const found = await inspectTask(plan.taskId, plan.location, key.key, options, checkedAt, null);
    if (
      found.kind !== 'selected' ||
      found.value.row.standing !== 'present' ||
      found.value.row.eligibility === 'expired' ||
      !same(makePlan(options, plan.location, binding(key.source), found.value), plan)
    )
      fail('preview-stale');
    return found.value;
  } catch {
    return fail('preview-stale');
  }
}

async function apply(input: Record<string, unknown>, options: Options, hooks: Hooks) {
  if (options.configurationLockHeld !== true) fail('task-lock-failed');
  const started = performance.now(),
    checkedAt = at(options);
  const currentAt = () =>
    new Date(Date.parse(checkedAt) + performance.now() - started).toISOString();
  if (
    !object(input.plan) ||
    !sha(input.bindingSha256) ||
    !uuid(input.previewId) ||
    !uuid(input.receiptId)
  )
    fail('preview-stale');
  const plan = input.plan as unknown as Plan;
  if (
    plan.version !== 1 ||
    plan.workspaceId !== options.workspaceId ||
    plan.runtimeSha256 !== options.runtimeSha256 ||
    !isTaskId(plan.taskId) ||
    plan.id !== taskId(options.workspaceId, plan.taskId) ||
    hash(stableStringify(plan)) !== input.bindingSha256
  )
    fail('preview-stale');
  const selected = await assertPlan(plan, options, currentAt());
  const taskPath = join(plan.location.home, 'tasks', plan.taskId),
    markerPath = join(taskPath, 'revoked');
  await hooks.fault?.('before-commit', { taskPath, markerPath, plan });
  checkDeadline(options);
  await assertPlan(plan, options, currentAt());
  let parent, output;
  let committed = false;
  try {
    parent = await open(
      taskPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    if (!same(pin(await parent.stat({ bigint: true })), plan.selected.directoryPin))
      fail('preview-stale');
    // No mkdir, unlink or replacement: only this new empty marker in existing pinned parents.
    output = await open(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    committed = true;
    await output.chmod(0o600);
    await output.sync();
    const created = filePin(await output.stat({ bigint: true }));
    await output.close();
    output = undefined;
    await parent.sync();
    await hooks.fault?.('after-commit', { taskPath, markerPath, plan });
    await assertLocation(options, plan.location);
    if (!same(await directory(taskPath), plan.selected.directoryPin)) fail('write-unconfirmed');
    const key = await publicKey(plan.location);
    if (
      !same(binding(key.source), plan.key) ||
      !same(binding(await file(join(taskPath, 'permit.json'), 64 * 1024)), plan.selected.source)
    )
      fail('write-unconfirmed');
    const ended = await marker(join(taskPath, 'ended'));
    if (!same(ended, plan.selected.ended)) {
      // A real launcher may observe our revoke, exit, and publish its own terminal marker.
      const completed = await file(join(taskPath, 'ended'), 0);
      if (
        plan.selected.ended.kind !== 'missing' ||
        completed.kind !== 'file' ||
        completed.sha256 !== hash('') ||
        (Number(completed.pin.mode) & 0o777) !== 0o600
      )
        fail('write-unconfirmed');
    }
    const result = await file(markerPath, 0);
    if (
      result.kind !== 'file' ||
      result.sha256 !== hash('') ||
      !same(result.pin, created) ||
      (Number(created.mode) & 0o777) !== 0o600
    )
      fail('write-unconfirmed');
    const store = new FilePermitStore({ home: plan.location.home });
    const readback = store.readPermit(plan.taskId);
    if (readback.kind !== 'void' || readback.reason !== 'revoked') fail('write-unconfirmed');
    const body = selected.signed.body;
    const gate = createScopeGate({
      taskId: plan.taskId,
      store: {
        readPermit: (id) => store.readPermit(id),
        readEscalation: () => ({ kind: 'absent' }),
        consumeEscalation: () => false,
      },
      keys: { readPublicKey: () => ({ kind: 'absent' }) },
      context: () => ({
        nonce: body.nonce,
        projectRoot: body.projectRoot,
        policyDigest: body.policyDigest,
        stateDigests: body.stateDigests,
      }),
    });
    const verdict = await gate.evaluate({
      event: {
        sessionId: body.sessionId ?? 'stroq-task-revoke-check',
        toolName: 'Read',
        toolInput: {},
        cwd: plan.location.project,
      },
      classification: { classes: [], hosts: [], signals: [] },
      classes: [],
      decision: { effect: 'allow', ruleId: null, reason: 'isolated revocation check' },
    });
    if (
      verdict?.decision.effect !== 'deny' ||
      verdict.decision.ruleId !== 'task-void:revoked' ||
      verdict.evidence.kind !== 'void'
    )
      fail('write-unconfirmed');
    const receipt = {
      schema: 'stroq-task-lock-receipt/1' as const,
      id: input.receiptId,
      previewId: input.previewId,
      workspaceId: options.workspaceId,
      taskId: plan.id,
      permitSha256: selected.row.permitSha256,
      status: 'revoked' as const,
      checkedAt: currentAt(),
      markerSha256: hash(''),
      storeReadback: 'revoked' as const,
      gateDecision: 'deny' as const,
      gateRule: 'task-void:revoked' as const,
      evidence: 'isolated-gate-evaluation' as const,
      hostTermination: 'unverified' as const,
      irreversible: true as const,
    };
    if (!validateTaskLockReceipt(receipt)) fail('write-unconfirmed');
    return receipt;
  } catch (error) {
    if (committed) fail('write-unconfirmed');
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('preview-stale');
    throw error;
  } finally {
    try {
      await output?.close();
      await parent?.close();
    } catch {
      fail(committed ? 'write-unconfirmed' : 'task-lock-failed');
    }
  }
}

/** Fixed permit-store controls only: no task launch or arbitrary browser-selected path. */
export async function runTaskLockWorker(request: Request, hooks: Hooks = {}) {
  const { operation, options } = request;
  if (!options || !/^workspace-[a-f0-9]{24}$/.test(options.workspaceId))
    fail('context-unavailable');
  if (operation === 'state') return state(options);
  if ((options.platform ?? process.platform) === 'win32') fail('platform-unsupported');
  if (!sha(options.runtimeSha256) || typeof options.engineVersion !== 'string')
    fail('runtime-unavailable');
  checkDeadline(options);
  if (operation.startsWith('taint-'))
    return runSessionTaintWorker(operation, request.input ?? {}, options, hooks.fault as any);
  if (operation === 'page') return page(request.input ?? {}, options);
  if (operation === 'access-preview') return previewAccess(request.input ?? {}, options);
  if (operation === 'access-issue') return issueAccess(request.input ?? {}, options, hooks);
  if (operation === 'access-state') return accessState(request.input ?? {}, options);
  if (operation === 'incident')
    return inspectIncidentTask(request.input ?? {}, options, {
      capture: captureKnownTask,
      fault: hooks.fault,
    });
  if (operation === 'preview') return preview(request.input ?? {}, options);
  if (operation === 'apply') return apply(request.input ?? {}, options, hooks);
  return fail('task-lock-failed');
}

if (parentPort) {
  void runTaskLockWorker(workerData as Request).then(
    (result) => parentPort?.postMessage({ type: 'result', result }),
    (error: unknown) => {
      const allowed = [
        ...SESSION_TAINT_ERRORS,
        'runtime-unavailable',
        'context-unavailable',
        'platform-unsupported',
        'task-unavailable',
        'task-page-stale',
        'task-lookup-limit',
        'preview-stale',
        'deadline-exceeded',
        'task-lock-failed',
        'write-unconfirmed',
        'unsafe-source',
        'invalid-report',
        'stale-evidence',
        'legacy-refusal',
        'refusal-unavailable',
        'operation-unavailable',
        'signing-key-unavailable',
        'signing-key-mismatch',
        'permission-unavailable',
        'permission-active',
        'preview-expired',
        'task-access-failed',
      ];
      parentPort?.postMessage({
        type: 'error',
        error:
          error instanceof Error &&
          (allowed.includes(error.message) || isHiddenCharacterError(error.message))
            ? error.message
            : 'task-lock-failed',
      });
    },
  );
}
