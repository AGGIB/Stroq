import {
  captureSessionTaint,
  clearStoredSessionTaint,
  sessionTaintPublishedPin,
  type SessionTaintClearConfirmation,
  type SessionTaintPin,
} from '@stroq/core';
import { join } from 'node:path';
import { runtimeDigest } from './runtime-digest.mjs';
import { assertLocation, checkDeadline, fail, hash, same } from './task-lock-files.ts';
import {
  inspectSessionTaint,
  type TaintBinding,
  type TaintOptions,
  type TaintSelection,
} from './session-taint-inspect.ts';
import {
  readTaintHistory,
  writeTaintEntry,
  type TaintEntry,
  type TaintStored,
} from './session-taint-store.ts';
import {
  validateSessionTaintPreview,
  validateSessionTaintRecord,
  validateSessionTaintReceipt,
  validateSessionTaintState,
  SESSION_TAINT_ERRORS,
  type SessionTaintInspection,
  type SessionTaintRecord,
  type SessionTaintError,
} from '../lib/session-taint.ts';

export interface TaintPlan {
  schema: 'stroq-session-taint-plan/1';
  recordId: string;
  expiresAt: number;
  before: SessionTaintInspection;
  binding: TaintBinding;
}
const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
/** Both acknowledgements the person gave on the preview, and that preview's id (`session-taint-control.ts`). */
const confirmed = (v: unknown): v is SessionTaintClearConfirmation =>
  exact(v, ['weakensRestrictions', 'recoveryRetention', 'previewId']) &&
  v.weakensRestrictions === true &&
  v.recoveryRetention === true &&
  uuid(v.previewId);
export function sessionTaintError(error: unknown): SessionTaintError {
  const code = (error as Error)?.message;
  const mapped: Record<string, string> = {
    'session-taint-source-unavailable': 'unsafe-state',
    'session-taint-stale': 'stale-state',
    'session-taint-unconfirmed': 'invalid-report',
    'session-taint-write-unconfirmed': 'write-unconfirmed',
    'unsafe-source': 'unsafe-state',
    'preview-stale': 'stale-state',
    'engine-unavailable': 'runtime-unavailable',
  };
  if (/^lock timeout:/.test(code ?? '')) return 'session-busy';
  const value = mapped[code] ?? code;
  return (SESSION_TAINT_ERRORS as readonly string[]).includes(value)
    ? (value as SessionTaintError)
    : 'session-taint-unavailable';
}
function clock(options: TaintOptions) {
  return options.now ?? new Date().toISOString();
}
async function guard(options: TaintOptions, expiresAt: number | null = null) {
  checkDeadline(options);
  if (
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) ||
      Date.now() >= expiresAt ||
      options.commitGuard?.expiresAt !== expiresAt)
  )
    fail('preview-expired');
  if (!options.commitGuard?.runtimePaths) fail('runtime-unavailable');
  try {
    if ((await runtimeDigest(options.commitGuard.runtimePaths)) !== options.runtimeSha256)
      fail('runtime-unavailable');
  } catch {
    fail('runtime-unavailable');
  }
}
function selection(input: Record<string, any>): TaintSelection {
  if (
    typeof input.id !== 'string' ||
    input.id !== `incident-${input.expectedEvidenceSha}` ||
    !/^[a-f0-9]{64}$/.test(input.expectedEvidenceSha) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    typeof input.recordedAt !== 'string' ||
    !Number.isFinite(Date.parse(input.recordedAt)) ||
    new Date(input.recordedAt).toISOString() !== input.recordedAt
  )
    fail('stale-evidence');
  return {
    id: input.id,
    expectedEvidenceSha: input.expectedEvidenceSha,
    sequence: input.sequence,
    recordedAt: input.recordedAt,
  };
}
async function project(options: TaintOptions, stored: TaintStored): Promise<SessionTaintRecord> {
  const e = stored.entry;
  let current: SessionTaintInspection | null = null,
    error: SessionTaintError | null = null;
  try {
    current = (await inspectSessionTaint(options, e.binding.selection, e.binding)).report;
  } catch (caught) {
    error = sessionTaintError(caught);
  }
  const result: SessionTaintRecord = {
    id: e.id,
    revisionSha256: stored.revision,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    status: e.status,
    before: e.before,
    afterTaintSha256: e.status === 'cleared' ? e.staged.sha256 : null,
    preservedProvenanceSha256: e.status === 'cleared' ? e.before.provenance.sha256 : null,
    recoveryAvailable: true,
    current,
    error,
  };
  if (!validateSessionTaintRecord(result)) fail('invalid-report');
  return result;
}
async function history(options: TaintOptions) {
  const vault = await readTaintHistory(options),
    records = [];
  for (const stored of vault.records)
    if (stored.entry.before.workspaceId === options.workspaceId)
      records.push(await project(options, stored));
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const body = {
    schema: 'stroq-session-taint/1',
    workspaceId: options.workspaceId,
    generatedAt: clock(options),
    available: true,
    history: vault.marker.bytes ? 'ready' : 'missing',
    error: null,
    records,
  };
  if (!validateSessionTaintState(body)) fail('invalid-report');
  return body;
}
async function preview(options: TaintOptions, input: Record<string, any>) {
  if (
    !exact(input, [
      'id',
      'expectedEvidenceSha',
      'sequence',
      'recordedAt',
      'expectedRevisionSha256',
      'recordId',
      'previewId',
      'expiresAt',
    ]) ||
    !uuid(input.recordId) ||
    !uuid(input.previewId)
  )
    fail('invalid-report');
  await guard(options, input.expiresAt);
  const captured = await inspectSessionTaint(options, selection(input));
  if (captured.report.revisionSha256 !== input.expectedRevisionSha256) fail('stale-state');
  if (captured.report.taint.status !== 'suspect') fail('not-tainted');
  if (captured.report.provenance.pending) fail('session-busy');
  const vault = await readTaintHistory(options);
  if (
    vault.records.some(
      (r) =>
        r.entry.before.sessionRef === captured.report.sessionRef &&
        ['prepared', 'uncertain'].includes(r.entry.status),
    )
  )
    fail('recovery-required');
  const report = {
    schema: 'stroq-session-taint-preview/1',
    id: input.previewId,
    recordId: input.recordId,
    createdAt: clock(options),
    expiresAt: new Date(input.expiresAt).toISOString(),
    inspection: captured.report,
    weakensRestrictions: true,
    provenancePreserved: true,
    privateRecovery: true,
    hostEnforcement: false,
  };
  if (!validateSessionTaintPreview(report)) fail('invalid-report');
  return {
    report,
    plan: {
      schema: 'stroq-session-taint-plan/1',
      recordId: input.recordId,
      expiresAt: input.expiresAt,
      before: captured.report,
      binding: captured.binding,
    } satisfies TaintPlan,
  };
}
async function apply(
  options: TaintOptions,
  input: Record<string, any>,
  fault?: (stage: string) => void | Promise<void>,
) {
  if (
    options.configurationLockHeld !== true ||
    !exact(input, ['plan', 'confirmation']) ||
    !exact(input.plan, ['schema', 'recordId', 'expiresAt', 'before', 'binding']) ||
    input.plan.schema !== 'stroq-session-taint-plan/1' ||
    !uuid(input.plan.recordId) ||
    !confirmed(input.confirmation)
  )
    fail('invalid-report');
  const plan = input.plan as TaintPlan,
    confirmation: SessionTaintClearConfirmation = { ...input.confirmation };
  await guard(options, plan.expiresAt);
  const snapshot = await inspectSessionTaint(options, plan.binding.selection, plan.binding);
  if (
    !same(snapshot.report, { ...plan.before, checkedAt: snapshot.report.checkedAt }) ||
    snapshot.report.revisionSha256 !== plan.before.revisionSha256
  )
    fail('stale-state');
  if (snapshot.report.provenance.pending) fail('session-busy');
  const vault = await readTaintHistory(options);
  if (
    vault.records.some(
      (r) =>
        r.entry.before.sessionRef === plan.before.sessionRef &&
        ['prepared', 'uncertain'].includes(r.entry.status),
    )
  )
    fail('recovery-required');
  const native = { ...plan.binding.native, bytes: Buffer.from(plan.binding.native.bytes!) };
  let stored: TaintStored | null = null,
    nativePublished = false;
  const commitGuard = async () => {
    await guard(options, plan.expiresAt);
    await assertLocation(options, plan.binding.root);
    if (nativePublished) return;
    const fresh = await inspectSessionTaint(options, plan.binding.selection, plan.binding);
    if (fresh.report.provenance.pending) fail('session-busy');
    if (fresh.report.revisionSha256 !== plan.before.revisionSha256) fail('stale-state');
  };
  let cleared: Awaited<ReturnType<typeof clearStoredSessionTaint>>;
  try {
    cleared = await clearStoredSessionTaint(native, {
      confirmation,
      guard: commitGuard,
      now: () => new Date(clock(options)),
      beforePublish: async (stage) => {
        const at = clock(options),
          entry: TaintEntry = {
            schema: 'stroq-session-taint-private/1',
            id: plan.recordId,
            createdAt: at,
            updatedAt: at,
            status: 'prepared',
            before: plan.before,
            binding: { ...plan.binding, native },
            staged: { sha256: stage.sha256, pin: stage.pin },
            published: null,
            audit: null,
          };
        stored = await writeTaintEntry(options, entry, null, commitGuard);
        await fault?.('after-intent');
      },
      // The clear is audited in its private recovery record: the record and the person's confirmation are
      // written into it, durably, before the clear is published.
      audit: async (record) => {
        if (!stored) fail('write-unconfirmed');
        const prepared = stored as TaintStored;
        stored = await writeTaintEntry(
          options,
          { ...prepared.entry, audit: record, updatedAt: clock(options) },
          prepared.revision,
          commitGuard,
        );
      },
      fault: async (stage) => {
        if (stage === 'after-rename') nativePublished = true;
        await fault?.(stage);
      },
    });
  } catch (error) {
    // Refused as stale, the clear was never published: a hook marked the session while the intent was
    // written. The record says so now, or a recheck would find the session neither cleared nor as it was
    // and hold it in recovery for good.
    // Stale is said by the clear (`session-taint-stale`) or by the commit guard first (`stale-state`).
    if (stored && sessionTaintError(error) === 'stale-state') {
      const prepared = stored as TaintStored;
      try {
        await writeTaintEntry(
          options,
          { ...prepared.entry, status: 'unchanged', updatedAt: clock(options) },
          prepared.revision,
          async () => {
            await guard(options);
            await assertLocation(options, plan.binding.root);
          },
        );
      } catch {
        // The record stays prepared, and an explicit recheck settles it; the refusal is what is reported.
      }
    }
    throw error;
  }
  if (!stored) fail('write-unconfirmed');
  const prepared = stored as TaintStored;
  try {
    const entry: TaintEntry = {
      ...prepared.entry,
      status: 'cleared',
      published: cleared.pin,
      updatedAt: clock(options),
    };
    // Publication is already a native fact; a later observation may immediately re-taint.
    stored = await writeTaintEntry(options, entry, prepared.revision, async () => {
      await guard(options, plan.expiresAt);
      await assertLocation(options, plan.binding.root);
    });
    const record = await project(options, stored),
      receipt = {
        schema: 'stroq-session-taint-receipt/1',
        operation: 'clear',
        checkedAt: clock(options),
        writeConfirmed: true,
        record,
      };
    if (!validateSessionTaintReceipt(receipt)) fail('write-unconfirmed');
    return receipt;
  } catch {
    fail('write-unconfirmed');
  }
}
async function recheck(options: TaintOptions, input: Record<string, any>) {
  if (
    options.configurationLockHeld !== true ||
    !exact(input, ['recordId']) ||
    !uuid(input.recordId)
  )
    fail('invalid-report');
  const vault = await readTaintHistory(options),
    stored = vault.records.find(
      (r) => r.entry.id === input.recordId && r.entry.before.workspaceId === options.workspaceId,
    );
  if (!stored) fail('stale-state');
  let result = stored;
  const e = stored.entry;
  if (['prepared', 'uncertain'].includes(e.status)) {
    await guard(options, options.commitGuard?.expiresAt ?? null);
    await assertLocation(options, e.binding.root);
    const observed = await inspectSessionTaint(options, e.binding.selection, e.binding);
    if (observed.report.provenance.pending) fail('session-busy');
    const native = await captureSessionTaint(join(options.home, 'sessions'), e.binding.sessionId);
    const owns =
      native.state?.taint === null &&
      native.sha256 === e.staged.sha256 &&
      native.pin &&
      same(sessionTaintPublishedPin(native.pin), e.staged.pin);
    const unchanged =
      native.sha256 === e.binding.native.sha256 && same(native.pin, e.binding.native.pin);
    const status = owns ? 'cleared' : unchanged ? 'unchanged' : 'uncertain';
    const entry: TaintEntry = {
      ...e,
      status,
      published: owns ? native.pin : null,
      updatedAt: clock(options),
    };
    result = await writeTaintEntry(options, entry, stored.revision, async () => {
      await guard(options, options.commitGuard?.expiresAt ?? null);
      await assertLocation(options, e.binding.root);
    });
  }
  const record = await project(options, result),
    receipt = {
      schema: 'stroq-session-taint-receipt/1',
      operation: 'recheck',
      checkedAt: clock(options),
      writeConfirmed: record.status === 'cleared',
      record,
    };
  if (!validateSessionTaintReceipt(receipt)) fail('invalid-report');
  return receipt;
}
export async function runSessionTaintWorker(
  operation: string,
  input: Record<string, any>,
  options: TaintOptions,
  fault?: (stage: string) => void | Promise<void>,
) {
  try {
    await guard(options);
    if (operation === 'taint-inspect') {
      if (!exact(input, ['id', 'expectedEvidenceSha', 'sequence', 'recordedAt']))
        fail('invalid-report');
      return (await inspectSessionTaint(options, selection(input))).report;
    }
    if (operation === 'taint-preview') return await preview(options, input);
    if (operation === 'taint-apply') return await apply(options, input, fault);
    if (operation === 'taint-recheck') return await recheck(options, input);
    if (operation === 'taint-state') {
      if (!exact(input, [])) fail('invalid-report');
      return await history(options);
    }
    fail('invalid-report');
  } catch (error) {
    fail(sessionTaintError(error));
  }
}
