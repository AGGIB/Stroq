import {
  validateCodexNetworkGuardState,
  validateCodexNetworkGuardPreview,
  type CodexNetworkGuardRecord,
} from './codex-network-guard';
import {
  validateCodexNetworkCheckState,
  validateCodexNetworkCheckBinding,
  type CodexNetworkCheckJob,
} from './codex-network-check';
import { closed, stamp, member } from './local-guards';
import { codexNetworkHref } from './codex-network-navigation';
import type { GuardPending, CheckPending } from './codex-network-client';
import type { ProtectionEvidenceRow } from './protection-evidence';
interface Input {
  workspaceId: string | null | undefined;
  guard: unknown;
  checks: unknown;
  guardPending?: readonly GuardPending[];
  checkPending?: readonly CheckPending[];
  loading?: boolean;
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const guardKey = (context: string, record: string, operation: string) =>
  `${context}:${record}:${operation}`;
const checkKey = (context: string, workspace: string, job: string, operation: string) =>
  `${context}:${workspace}:${job}:${operation}`;
const jobKey = (job: CodexNetworkCheckJob) =>
  checkKey(job.binding.controlContextId, job.binding.workspaceId, job.id, job.operationId);
function validGuardPending(v: unknown): v is GuardPending {
  return (
    closed(v, ['preview', 'startedAt']) &&
    Reflect.ownKeys(v).length === 2 &&
    validateCodexNetworkGuardPreview(v.preview) &&
    stamp(v.startedAt)
  );
}
function validCheckPending(v: unknown): v is CheckPending {
  return (
    closed(v, ['action', 'id', 'operationId', 'binding', 'startedAt']) &&
    Reflect.ownKeys(v).length === 5 &&
    member(v.action, ['start', 'cancel']) &&
    uuid(v.id) &&
    uuid(v.operationId) &&
    validateCodexNetworkCheckBinding(v.binding) &&
    stamp(v.startedAt)
  );
}
const copyScope = 'Historical isolated permission copy';
const jobHref = (j: CodexNetworkCheckJob) =>
  codexNetworkHref({
    controlContextId: j.binding.controlContextId,
    workspaceId: j.binding.workspaceId,
    jobId: j.id,
  });
function recordRow(record: CodexNetworkGuardRecord): ProtectionEvidenceRow | null {
  const unknown = record.operationStatus === 'unknown';
  if (
    !unknown &&
    (record.operationStatus !== 'guarded' ||
      record.ownership !== 'current' ||
      record.standing === 'selected')
  )
    return null;
  const detail = unknown
    ? 'This retained operation has no confirmed publication outcome. Recheck its exact saved evidence.'
    : record.standing === 'overridden'
      ? 'A higher layer overrides the saved user declaration. Inspect settings before another action.'
      : record.standing === 'unavailable'
        ? 'The current owned user setting could not be verified. Its saved receipt does not establish current adoption.'
        : 'The current user setting differs from this owned change. Inspect the retained declaration.';
  return {
    key: 'codex-network-record:' + guardKey(record.controlContextId, record.id, record.operationId),
    title: unknown
      ? 'Codex network change needs recheck'
      : record.standing === 'overridden'
        ? 'Codex network setting is overridden'
        : record.standing === 'unavailable'
          ? 'Codex network setting is unverified'
          : 'Codex network setting changed',
    detail,
    context: 'Base user declaration',
    href: codexNetworkHref({ recordId: record.id, controlContextId: record.controlContextId }),
    action: 'Inspect change',
    tone: 'orange',
  };
}
function terminalRow(job: CodexNetworkCheckJob, foreign: boolean): ProtectionEvidenceRow {
  const result = job.result;
  const title =
    job.status === 'failed'
      ? 'Latest Codex copy check failed'
      : job.status === 'cancelled'
        ? 'Latest Codex copy check cancelled'
        : result?.outcome === 'passed'
          ? 'Latest Codex copy check recorded'
          : result?.outcome === 'attention'
            ? 'Latest Codex copy allowed a connection'
            : 'Latest Codex copy check inconclusive';
  const outcome =
    job.status === 'failed'
      ? 'The attempt ended without accepted canary evidence.'
      : job.status === 'cancelled'
        ? 'The attempt was cancelled; no completed refusal proof was recorded.'
        : result?.outcome === 'passed'
          ? 'TCP and Unix canaries refused the tested connections.'
          : result?.outcome === 'attention'
            ? 'A fixed socket canary connected under the copied policy.'
            : 'Execution or positive controls did not establish both socket refusals.';
  return {
    key: 'codex-network-check:' + jobKey(job),
    title,
    context: copyScope,
    detail: `${outcome} Recorded ${job.finishedAt}. ${foreign ? 'Another Codex data directory. ' : ''}The current default and native client adoption remain unverified.`,
    href: jobHref(job),
    action: 'Inspect check',
    tone: job.status === 'cancelled' || result?.outcome === 'passed' ? 'muted' : 'orange',
  };
}
/** Passive projection only: no source capture, authority change, recheck or pending reconciliation. */
export function codexNetworkRows(input: Input): ProtectionEvidenceRow[] {
  const workspace =
    typeof input.workspaceId === 'string' && /^workspace-[a-f0-9]{24}$/.test(input.workspaceId)
      ? input.workspaceId
      : null;
  const guard = workspace && validateCodexNetworkGuardState(input.guard) ? input.guard : null;
  const checks =
    workspace &&
    validateCodexNetworkCheckState(input.checks) &&
    input.checks.workspaceId === workspace &&
    (!guard?.controlContextId || input.checks.controlContextId === guard.controlContextId)
      ? input.checks
      : null;
  const rows: ProtectionEvidenceRow[] = [],
    guardOperations = new Set<string>(),
    checkOperations = new Set<string>(),
    requests = new Set<string>();
  const invalidPending =
    (input.guardPending ?? []).some((p) => !validGuardPending(p)) ||
    (input.checkPending ?? []).some((p) => !validCheckPending(p));
  for (const value of input.guardPending ?? []) {
    if (!validGuardPending(value)) continue;
    const p = value.preview,
      key = guardKey(p.controlContextId, p.recordId, p.operationId);
    if (guardOperations.has(key)) continue;
    guardOperations.add(key);
    const foreign = !!guard?.controlContextId && p.controlContextId !== guard.controlContextId;
    rows.push({
      key: 'codex-network-write:' + key,
      title: 'Codex network change is unconfirmed',
      context: 'Exact configuration operation',
      detail: foreign
        ? 'This request belongs to another Codex data directory. Return to that context to recheck it.'
        : 'The response did not establish the write outcome. Recheck the exact saved change; do not repeat it.',
      href: codexNetworkHref({ recordId: p.recordId, controlContextId: p.controlContextId }),
      action: 'Inspect change',
      tone: 'orange',
    });
  }
  for (const value of input.checkPending ?? []) {
    if (!validCheckPending(value)) continue;
    const key = checkKey(
        value.binding.controlContextId,
        value.binding.workspaceId,
        value.id,
        value.operationId,
      ),
      requestKey = key + ':' + value.action;
    if (requests.has(requestKey)) continue;
    requests.add(requestKey);
    checkOperations.add(key);
    const foreign =
      value.binding.workspaceId !== workspace ||
      (!!guard?.controlContextId && value.binding.controlContextId !== guard.controlContextId);
    rows.push({
      key: 'codex-network-request:' + requestKey,
      title:
        value.action === 'cancel'
          ? 'Codex copy-check cancellation unconfirmed'
          : 'Codex copy-check start unconfirmed',
      context: 'Exact isolated-copy attempt',
      detail: foreign
        ? 'This request belongs to another workspace or Codex data directory. Reconnect that context to recheck the exact attempt.'
        : 'The exact attempt may still be running. Recheck its history; do not repeat the start or cancellation.',
      href: codexNetworkHref({
        jobId: value.id,
        controlContextId: value.binding.controlContextId,
        workspaceId: value.binding.workspaceId,
      }),
      action: 'Inspect check',
      tone: 'orange',
    });
  }
  if (invalidPending)
    rows.push({
      key: 'codex-network-pending-unavailable',
      title: 'Codex pending request could not be verified',
      context: 'Unresolved request metadata',
      detail: 'An unresolved request could not be bound safely. Its state was not cleared.',
      href: codexNetworkHref({ view: 'history' }),
      action: 'Inspect history',
      tone: 'orange',
    });
  const records = guard?.history !== 'unavailable' ? (guard?.records ?? []) : [];
  for (const record of records) {
    if (guardOperations.has(guardKey(record.controlContextId, record.id, record.operationId)))
      continue;
    const row = recordRow(record);
    if (row) rows.push(row);
  }
  if (
    (!guard && !input.loading) ||
    (guard && (!guard.available || guard.history === 'unavailable'))
  )
    rows.push({
      key: 'codex-network-guard-history',
      title: 'Codex network settings unavailable',
      context: 'Base user declaration',
      detail:
        'Saved changes or current owned settings could not be verified. Missing evidence is not an empty history.',
      href: codexNetworkHref({ view: 'history' }),
      action: 'Inspect history',
      tone: 'orange',
    });
  if ((!checks && !input.loading) || checks?.history === 'unavailable')
    rows.push({
      key: 'codex-network-check-history',
      title: 'Codex copied-policy history unavailable',
      context: copyScope,
      detail:
        'The retained test history could not be verified. No passing or empty result was inferred.',
      href: codexNetworkHref({ view: 'history' }),
      action: 'Inspect history',
      tone: 'orange',
    });
  const jobs = checks?.history === 'ready' ? checks.jobs : [],
    terminal = new Map<string, CodexNetworkCheckJob>();
  for (const job of [...jobs].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  )) {
    if (job.status === 'running') {
      if (!checkOperations.has(jobKey(job)))
        rows.push({
          key: 'codex-network-running:' + jobKey(job),
          title:
            checks?.ownedJobId === job.id
              ? 'Codex copy check last recorded running'
              : 'Codex copy check recorded running; ownership unverified',
          context: 'Isolated permission copy',
          detail:
            checks?.ownedJobId === job.id
              ? `History read ${checks!.generatedAt}. No completed result is available; inspect this exact attempt for progress.`
              : 'The retained running record is not owned by this service. Liveness is unverified; inspect history without assuming the check is active.',
          href: jobHref(job),
          action: 'Inspect check',
          tone: 'muted',
        });
    } else {
      const key = job.binding.workspaceId + ':' + job.binding.controlContextId;
      if (!terminal.has(key)) terminal.set(key, job);
    }
  }
  for (const job of terminal.values())
    if (!checkOperations.has(jobKey(job)))
      rows.push(
        terminalRow(
          job,
          !!guard?.controlContextId && job.binding.controlContextId !== guard.controlContextId,
        ),
      );
  const matching = guard?.available
    ? records.find(
        (r) =>
          r.operationStatus === 'guarded' &&
          r.ownership === 'current' &&
          r.standing === 'selected' &&
          !guardOperations.has(guardKey(r.controlContextId, r.id, r.operationId)),
      )
    : null;
  if (matching)
    rows.push({
      key: 'codex-network-declared:' + matching.controlContextId,
      title: 'Codex user network-off setting matches',
      context: 'Base user declaration',
      detail:
        'An owned setting matches the captured user declaration. Native client adoption remains unverified; profiles and overrides can differ.',
      href: codexNetworkHref({
        recordId: matching.id,
        controlContextId: matching.controlContextId,
      }),
      action: 'Inspect change',
      tone: 'muted',
    });
  return rows;
}
