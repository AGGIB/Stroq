import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  digestOf,
  isCanonicalIso,
  isTaskId,
  parseTaskAccessReview,
  verifyTaskAccessRequest,
  type AuditEntry,
} from '@stroq/core';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.js';
import {
  hiddenCharacterError,
  hiddenReviewCharacter,
  reviewTextSafe,
} from '../lib/task-access-review.js';
import {
  assertLocation,
  binding,
  checkDeadline,
  fail,
  filePin,
  hash,
  location,
  same,
  type FilePin,
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

export interface AccessInput {
  id: string;
  expectedEvidenceSha: string;
  sequence: number;
  recordedAt: string;
}
export interface AccessCapture {
  root: Location;
  journal: Journal;
  entry: AuditEntry;
  key: Awaited<ReturnType<typeof publicKey>>;
  selected: Selected;
  privateKey: FilePin;
  operation: {
    tool: string;
    review: string;
    kind: 'read-target' | 'whole-call';
    fingerprint: string;
    requiredCount: number;
  };
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export function accessInput(value: Record<string, unknown>): AccessInput {
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
  return value as unknown as AccessInput;
}
export function accessEvent(input: AccessInput, journal: Journal): AuditEntry {
  if (
    journal.status !== 'verified' ||
    journal.source?.kind !== 'file' ||
    !journal.source.text.endsWith('\n')
  )
    fail('refusal-unavailable');
  for (const raw of journal.source.text.split('\n').slice(0, -1)) {
    if (hash(raw) !== input.expectedEvidenceSha) continue;
    const parsed = parseStrictJson(raw);
    if (!parsed.ok || !object(parsed.value)) fail('stale-evidence');
    const row = parsed.value;
    if (row.seq !== input.sequence || row.ts !== input.recordedAt) fail('stale-evidence');
    if (
      row.phase !== 'pre' ||
      Object.hasOwn(row, 'outcome') ||
      !object(row.decision) ||
      row.decision.effect !== 'deny' ||
      !object(row.scope) ||
      typeof row.scope.kind !== 'string' ||
      !['scope', 'ask'].includes(row.scope.kind) ||
      typeof row.scope.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.scope.fingerprint)
    )
      fail('refusal-unavailable');
    return row as unknown as AuditEntry;
  }
  fail('stale-evidence');
}
export function assertAccessContinuity(before: Journal, after: Journal): void {
  if (
    before.source?.kind !== 'file' ||
    after.status !== 'verified' ||
    after.source?.kind !== 'file'
  )
    fail('stale-evidence');
  const a = before.source,
    b = after.source;
  if (
    ['dev', 'ino', 'uid', 'mode', 'nlink'].some(
      (k) => a.pin[k as keyof FilePin] !== b.pin[k as keyof FilePin],
    ) ||
    b.bytes.length < a.bytes.length ||
    hash(b.bytes.subarray(0, a.bytes.length)) !== a.sha256 ||
    (b.bytes.length === a.bytes.length && !same(a.pin, b.pin))
  )
    fail('stale-evidence');
}

/** Metadata only. The preview never opens or decodes the private key. */
export async function privateKeyMetadata(root: Location): Promise<FilePin> {
  try {
    if (root.keysPin === null || (Number(root.keysPin.mode) & 0o777) !== 0o700)
      fail('signing-key-unavailable');
    const info = await lstat(join(root.home, 'keys', 'permit.key'), { bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size <= 0n ||
      info.size > 4096n ||
      (info.mode & 0o777n) !== 0o600n ||
      (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))
    )
      fail('signing-key-unavailable');
    return filePin(info);
  } catch {
    fail('signing-key-unavailable');
  }
}

export async function captureAccess(
  input: AccessInput,
  options: Options,
  allowConsumedEnd = false,
): Promise<AccessCapture> {
  checkDeadline(options);
  const at = options.now ?? new Date().toISOString();
  if (!isCanonicalIso(at)) fail('context-unavailable');
  const root = await location(options),
    journal = await captureJournal(root),
    entry = accessEvent(input, journal);
  if (!isTaskId(entry.taskId) || entry.taskId === 'invalid') fail('task-unavailable');
  if (!Object.hasOwn(entry, 'approvalRequest')) fail('legacy-refusal');
  const data = entry as unknown as Record<string, unknown>,
    signed = data.approvalRequest;
  if (!object(signed) || !object(signed.body)) fail('refusal-unavailable');
  const request = signed.body;
  const review = data.approvalReview;
  if (typeof review !== 'string' || Buffer.byteLength(review) > 65536 || !review.length)
    fail('operation-unavailable');
  // A character the review screen would not show as it is: refused here, before any preview or
  // signature, and named, so the person learns which one it was. Then the raw text as a whole.
  const hidden = hiddenReviewCharacter(review);
  if (hidden !== null) fail(hiddenCharacterError(hidden));
  if (!reviewTextSafe(review)) fail('operation-unavailable');
  const decoded = parseTaskAccessReview(review);
  if (
    decoded === null ||
    decoded.tool !== entry.tool ||
    decoded.kind !== request.fingerprintKind ||
    (decoded.kind === 'read-target' &&
      (decoded.target?.op !== 'read' ||
        !decoded.target.path ||
        (decoded.target.real !== undefined && !decoded.target.real))) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(entry.tool)
  )
    fail('operation-unavailable');
  if (
    typeof entry.sessionId !== 'string' ||
    !entry.sessionId ||
    entry.sessionId.length > 512 ||
    typeof entry.callId !== 'string' ||
    !entry.callId ||
    entry.callId.length > 512
  )
    fail('refusal-unavailable');
  const key = await publicKey(root);
  if (key.key === null) fail('task-unavailable');
  const policy = await currentPolicy(root),
    found = await inspectTask(entry.taskId, root, key.key, options, at, policy);
  if (found.kind !== 'selected') fail('task-unavailable');
  const selected = found.value,
    body = selected.signed.body;
  if (
    (selected.row.standing !== 'present' &&
      !(allowConsumedEnd && selected.row.standing === 'ended')) ||
    selected.row.eligibility !== 'eligible' ||
    selected.row.policyRelation !== 'matches-current' ||
    body.sessionId !== entry.sessionId ||
    signed.keyId !== selected.signed.keyId
  )
    fail('task-unavailable');
  if (
    !Array.isArray(request.requiredFingerprints) ||
    typeof request.fingerprint !== 'string' ||
    request.fingerprint !== entry.scope?.fingerprint ||
    typeof request.fingerprintKind !== 'string' ||
    !['read-target', 'whole-call'].includes(request.fingerprintKind)
  )
    fail('refusal-unavailable');
  const checked = verifyTaskAccessRequest(signed, key.key, {
    now: new Date(at),
    taskId: selected.rawId,
    permitBodySha256: digestOf(body),
    fingerprint: request.fingerprint,
    fingerprintKind: request.fingerprintKind as 'read-target' | 'whole-call',
    requiredFingerprints: request.requiredFingerprints as string[],
    reviewSha256: hash(review),
    sessionSha256: hash(entry.sessionId),
    callIdSha256: hash(entry.callId),
    permitExpiresAt: body.expiresAt,
  });
  if (!checked.ok) fail('refusal-unavailable');
  if (
    Date.parse(input.recordedAt) < Date.parse(body.issuedAt) - 60000 ||
    Date.parse(input.recordedAt) > Date.parse(at) + 60000 ||
    Math.abs(Date.parse(checked.body.issuedAt) - Date.parse(input.recordedAt)) > 60000
  )
    fail('refusal-unavailable');
  const privateKey = await privateKeyMetadata(root);
  const finalJournal = await captureJournal(root);
  assertAccessContinuity(journal, finalJournal);
  accessEvent(input, finalJournal);
  await assertLocation(options, root);
  const finalKey = await publicKey(root),
    finalTask = await inspectTask(entry.taskId, root, finalKey.key, options, at, policy);
  if (
    !same(binding(finalKey.source), binding(key.source)) ||
    finalTask.kind !== 'selected' ||
    !same(selectedBinding(finalTask.value), selectedBinding(selected)) ||
    !same(await privateKeyMetadata(root), privateKey) ||
    (await currentPolicy(root)) !== policy
  )
    fail('preview-stale');
  selected.row.evidence = evidenceFor(finalJournal, selected);
  if (selected.row.evidence.status !== 'verified') fail('refusal-unavailable');
  return {
    root,
    journal: finalJournal,
    entry,
    key,
    selected,
    privateKey,
    operation: {
      tool: entry.tool,
      review,
      kind: checked.body.fingerprintKind,
      fingerprint: checked.body.fingerprint,
      requiredCount: checked.body.requiredFingerprints.length,
    },
  };
}
