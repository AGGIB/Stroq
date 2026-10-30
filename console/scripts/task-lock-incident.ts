import { join } from 'node:path';
import { isCanonicalIso, isTaskId, verifyPermit, type AuditEntry } from '@stroq/core';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.js';
import {
  INCIDENT_TASK_LIMITATIONS,
  validateIncidentTaskReport,
  type IncidentTaskReport,
} from '../lib/incident-task.js';
import {
  assertLocation,
  binding,
  checkDeadline,
  fail,
  file,
  hash,
  location,
  same,
  type FileCapture,
  type Location,
  type Options,
} from './task-lock-files.js';
import {
  captureJournal,
  currentPolicy,
  evidenceFor,
  inspectTask,
  publicKey,
  selectedBinding,
  type Journal,
  type Selected,
} from './task-lock-inspect.js';

interface Input {
  id: string;
  expectedEvidenceSha: string;
  sequence: number;
  recordedAt: string;
}
interface Inventory {
  root: Location;
  key: Awaited<ReturnType<typeof publicKey>>;
  policy: string | null;
  selected: Selected[];
  references: Map<string, 'foreign' | 'invalid'>;
}
interface Dependencies {
  capture: (options: Options, checkedAt: string, rawId: string) => Promise<Inventory>;
  fault?: (
    stage: 'after-incident-capture',
    details: Record<string, unknown>,
  ) => Promise<void> | void;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function request(value: Record<string, unknown>): Input {
  if (
    Object.keys(value).sort().join(',') !== 'expectedEvidenceSha,id,recordedAt,sequence' ||
    typeof value.expectedEvidenceSha !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expectedEvidenceSha) ||
    value.id !== `incident-${value.expectedEvidenceSha}` ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.recordedAt !== 'string' ||
    !isCanonicalIso(value.recordedAt)
  )
    fail('stale-evidence');
  return value as unknown as Input;
}

/** The incident fingerprint covers the exact raw line, not normalized JSON or the core entry hash. */
function selectedEvent(input: Input, journal: Journal): AuditEntry | null {
  if (journal.source?.kind !== 'file') return null;
  const lines = journal.source.text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    if (hash(raw) !== input.expectedEvidenceSha) continue;
    if (index === lines.length - 1) fail('stale-evidence');
    const parsed = parseStrictJson(raw);
    if (!parsed.ok || !object(parsed.value)) fail('stale-evidence');
    const row = parsed.value;
    const finding =
      (row.phase === 'pre' &&
        object(row.decision) &&
        (row.decision.effect === 'deny' || row.decision.effect === 'ask')) ||
      (row.phase === 'post' &&
        object(row.scan) &&
        row.scan.verdict === 'suspect' &&
        typeof row.scan.score === 'number' &&
        row.scan.score >= 0 &&
        row.scan.score <= 1);
    if (
      row.seq !== input.sequence ||
      row.ts !== input.recordedAt ||
      Object.hasOwn(row, 'outcome') ||
      !finding ||
      typeof row.sessionId !== 'string' ||
      !row.sessionId.length ||
      row.sessionId.length > 512
    )
      fail('stale-evidence');
    return row as unknown as AuditEntry;
  }
  fail('stale-evidence');
}

/** Safe append continuity permits a new full chain, never a replacement or changed old prefix. */
function assertContinuity(before: Journal, after: Journal): void {
  if (before.source?.kind !== 'file') return;
  if (after.source?.kind !== 'file') {
    if (after.status === 'missing') fail('stale-evidence');
    return;
  }
  const old = before.source,
    fresh = after.source;
  if (
    ['dev', 'ino', 'uid', 'mode', 'nlink'].some(
      (key) => old.pin[key as keyof typeof old.pin] !== fresh.pin[key as keyof typeof fresh.pin],
    ) ||
    fresh.bytes.length < old.bytes.length ||
    hash(fresh.bytes.subarray(0, old.bytes.length)) !== old.sha256
  )
    fail('stale-evidence');
  if (fresh.bytes.length === old.bytes.length && !same(old.pin, fresh.pin)) fail('stale-evidence');
}

function base(
  input: Input,
  options: Options,
  checkedAt: string,
  policy: string | null,
  journal: Journal,
): IncidentTaskReport {
  return {
    schema: 'stroq-incident-task/1',
    workspaceId: options.workspaceId,
    incident: {
      id: input.id,
      evidenceSha256: input.expectedEvidenceSha,
      sequence: input.sequence,
      recordedAt: input.recordedAt,
    },
    checkedAt,
    currentPolicySha256: policy,
    status: 'evidence-unavailable',
    journal: { status: journal.status, sha256: journal.sha256 },
    relation: 'none',
    historicalPermitRelation: 'not-recorded',
    sessionRelation: 'unavailable',
    task: null,
    limitations: INCIDENT_TASK_LIMITATIONS,
  };
}
function finish(report: IncidentTaskReport): IncidentTaskReport {
  if (!validateIncidentTaskReport(report)) fail('invalid-report');
  return report;
}
/** Read-only association. Signed current metadata is never attributed to the historical request. */
export async function inspectIncidentTask(
  inputValue: Record<string, unknown>,
  options: Options,
  dependencies: Dependencies,
): Promise<IncidentTaskReport> {
  const input = request(inputValue),
    checkedAt = options.now ?? new Date().toISOString();
  if (!isCanonicalIso(checkedAt)) fail('context-unavailable');
  const root = await location(options);
  const initial = await captureJournal(root);
  if (initial.status !== 'verified')
    return finish(base(input, options, checkedAt, await currentPolicy(root), initial));
  const original = selectedEvent(input, initial);
  if (original === null)
    return finish(base(input, options, checkedAt, await currentPolicy(root), initial));
  let inventory: Inventory | null;
  try {
    inventory =
      isTaskId(original.taskId) && original.taskId !== 'invalid'
        ? await dependencies.capture(options, checkedAt, original.taskId)
        : null;
  } catch (error) {
    if (error instanceof Error && error.message === 'deadline-exceeded') throw error;
    inventory = null;
  }
  if (inventory !== null && !same(root, inventory.root)) fail('preview-stale');
  await dependencies.fault?.('after-incident-capture', { root, journalSha256: initial.sha256 });
  checkDeadline(options);
  const final = await captureJournal(root);
  assertContinuity(initial, final);
  const policy = await currentPolicy(root);
  const report = base(input, options, checkedAt, policy, final);
  await assertLocation(options, root);
  if (
    final.status !== 'verified' ||
    final.source?.kind !== 'file' ||
    !final.source.text.endsWith('\n')
  )
    return finish({
      ...report,
      journal: { ...report.journal, status: final.status === 'verified' ? 'broken' : final.status },
    });
  selectedEvent(input, final);
  if (!Object.hasOwn(original, 'taskId')) return finish({ ...report, status: 'not-recorded' });
  if (!isTaskId(original.taskId) || original.taskId === 'invalid')
    return finish({ ...report, status: 'invalid-reference' });
  if (inventory === null) return finish({ ...report, status: 'permit-unavailable' });
  let freshKey;
  try {
    freshKey = await publicKey(root);
  } catch {
    fail('preview-stale');
  }
  if (!same(binding(freshKey.source), binding(inventory.key.source))) fail('preview-stale');
  const selected = inventory.selected.find((entry) => entry.rawId === original.taskId);
  if (!selected)
    return finish({
      ...report,
      status:
        inventory.references.get(original.taskId) === 'foreign'
          ? 'different-workspace'
          : 'permit-unavailable',
    });
  let current;
  try {
    current = await inspectTask(selected.rawId, root, freshKey.key, options, checkedAt, policy);
  } catch {
    fail('preview-stale');
  }
  if (
    current.kind !== 'selected' ||
    !same(selectedBinding(selected), selectedBinding(current.value))
  )
    fail('preview-stale');
  const fresh = current.value;
  const row = { ...fresh.row, evidence: evidenceFor(final, fresh) };
  if (Buffer.byteLength(JSON.stringify(row)) > 480 * 1024)
    return finish({ ...report, status: 'permit-unavailable' });
  if (row.evidence.status !== 'verified')
    return finish({ ...report, journal: { status: 'broken', sha256: final.sha256 } });
  const body = fresh.signed.body;
  const sessionRelation =
    body.sessionId === undefined
      ? ('unavailable' as const)
      : body.sessionId === original.sessionId
        ? ('matches' as const)
        : ('differs' as const);
  if (sessionRelation === 'differs')
    return finish({ ...report, status: 'session-mismatch', sessionRelation });
  if (fresh.source.kind !== 'file' || freshKey.key === null) fail('preview-stale');
  const historical = verifyPermit(fresh.source.text, freshKey.key, {
    now: new Date(input.recordedAt),
    nonce: body.nonce,
    taskId: fresh.rawId,
    projectRoot: body.projectRoot,
    policyDigest: body.policyDigest,
    stateDigests: body.stateDigests,
    sessionId: original.sessionId,
  });
  if (!historical.ok) return finish({ ...report, status: 'time-mismatch', sessionRelation });
  await assertLocation(options, root);
  const last = await inspectTask(fresh.rawId, root, freshKey.key, options, checkedAt, policy);
  if (
    !same(
      binding(await file(join(root.home, 'keys/permit.pub'), 4096)),
      binding(freshKey.source),
    ) ||
    last.kind !== 'selected' ||
    !same(selectedBinding(last.value), selectedBinding(fresh)) ||
    (await currentPolicy(root)) !== policy
  )
    fail('preview-stale');
  return finish({
    ...report,
    status: 'matched',
    relation: 'task-id-only',
    sessionRelation,
    task: row,
  });
}
