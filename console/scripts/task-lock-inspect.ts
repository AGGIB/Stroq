import { createPublicKey, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_POLICY,
  GENESIS_HASH,
  PolicySchema,
  SignedPermitSchema,
  hashEntry,
  isCanonicalIso,
  redact,
  verifyPermit,
  type AuditEntry,
  type SignedPermit,
} from '@stroq/core';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.js';
import { parseDocument } from 'yaml';
import { policySha256 } from '../../packages/cli/src/policy/digest.js';
import { taskReceipt } from '../../packages/cli/src/task/receipt.js';
import {
  isTaskLockRelativePattern,
  type SafeGlob,
  type TaskLockEvidence,
  type TaskLockRow,
} from '../lib/task-locks.js';
import {
  binding,
  directory,
  file,
  hash,
  marker,
  same,
  type FileCapture,
  type Location,
  type Marker,
  type Pin,
  type Options,
} from './task-lock-files.js';

export const taskId = (workspaceId: string, raw: string): string =>
  `task-${hash(workspaceId + '\0' + raw)}`;
export const effect = (value: unknown): value is 'allow' | 'ask' | 'deny' =>
  ['allow', 'ask', 'deny'].includes(String(value));
const kinds = ['void', 'hard', 'scope', 'ask', 'policy', 'escalated', 'in-scope'];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const noEvidence = (
  status: TaskLockEvidence['status'],
  journalSha256: string | null = null,
): TaskLockEvidence => ({ status, journalSha256, counts: null, lastGate: null });

export async function currentPolicy(root: Location): Promise<string | null> {
  try {
    if (root.homePin === null) return policySha256(DEFAULT_POLICY);
    const source = await file(join(root.home, 'policy.yaml'), 256 * 1024);
    if (source.kind === 'missing') return policySha256(DEFAULT_POLICY);
    const document = parseDocument(source.text);
    if (document.errors.length) return null;
    return policySha256(PolicySchema.parse(document.toJS({ maxAliasCount: 0 })));
  } catch {
    return null;
  }
}

export async function publicKey(
  root: Location,
): Promise<{ source: FileCapture; key: KeyObject | null }> {
  const source =
    root.keysPin === null
      ? { kind: 'missing' as const }
      : await file(join(root.home, 'keys', 'permit.pub'), 4096);
  if (source.kind === 'missing') return { source, key: null };
  try {
    const key = createPublicKey(source.text);
    return { source, key: key.asymmetricKeyType === 'ed25519' ? key : null };
  } catch {
    return { source, key: null };
  }
}

export function safeGlob(glob: string, root: Location): SafeGlob {
  for (const [kind, base] of [
    ['workspace', root.project],
    ['home', root.userHome],
  ] as const) {
    if (glob !== base && !glob.startsWith(base + '/')) continue;
    const pattern = glob === base ? '.' : glob.slice(base.length + 1);
    return {
      id: hash(glob),
      root: kind,
      pattern: isTaskLockRelativePattern(pattern) && redact(pattern) === pattern ? pattern : null,
    };
  }
  return { id: hash(glob), root: 'external', pattern: null };
}

export interface Selected {
  rawId: string;
  source: FileCapture;
  directoryPin: Pin;
  revoked: Marker;
  ended: Marker;
  signed: SignedPermit;
  row: TaskLockRow;
}
export type Selection =
  { kind: 'foreign' } | { kind: 'invalid' } | { kind: 'selected'; value: Selected };

export async function inspectTask(
  rawId: string,
  root: Location,
  key: KeyObject | null,
  options: Options,
  checkedAt: string,
  policy: string | null,
): Promise<Selection> {
  const path = join(root.home, 'tasks', rawId);
  const directoryPin = await directory(path);
  const source = await file(join(path, 'permit.json'), 64 * 1024);
  if (source.kind === 'missing' || key === null) return { kind: 'invalid' };
  const parsed = parseStrictJson(source.text);
  if (!parsed.ok) return { kind: 'invalid' };
  const signed = SignedPermitSchema.safeParse(parsed.value);
  if (!signed.success) return { kind: 'invalid' };
  const { body } = signed.data;
  const context = {
    nonce: body.nonce,
    taskId: rawId,
    projectRoot: body.projectRoot,
    policyDigest: body.policyDigest,
    stateDigests: body.stateDigests,
    sessionId: body.sessionId,
  };
  if (!verifyPermit(source.text, key, { ...context, now: new Date(body.issuedAt) }).ok)
    return { kind: 'invalid' };
  // Never resolve or inspect another project's signed path merely to list our own tasks.
  if (body.projectRoot !== root.project) return { kind: 'foreign' };
  const current = verifyPermit(source.text, key, { ...context, now: new Date(checkedAt) });
  const eligibility = current.ok
    ? 'eligible'
    : current.reason === 'expired'
      ? 'expired'
      : current.reason === 'not-yet-valid'
        ? 'not-yet-valid'
        : null;
  if (eligibility === null) return { kind: 'invalid' };
  const revoked = await marker(join(path, 'revoked')),
    ended = await marker(join(path, 'ended'));
  if (!same(await directory(path), directoryPin)) throw new Error('unsafe-source');
  const paths = (value: SignedPermit['body']['scope']['read']) => ({
    allow: value.allow.map((glob) => safeGlob(glob, root)),
    deny: value.deny.map((glob) => safeGlob(glob, root)),
  });
  const row: TaskLockRow = {
    id: taskId(options.workspaceId, rawId),
    permitSha256: source.sha256,
    profile: body.profile,
    policySha256: body.policyDigest,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    declaredMode: body.mode ?? 'unknown',
    eligibility,
    standing:
      revoked.kind === 'present' ? 'revoked' : ended.kind === 'present' ? 'ended' : 'present',
    policyRelation:
      policy === null
        ? 'unavailable'
        : policy === body.policyDigest
          ? 'matches-current'
          : 'differs-current',
    scope: {
      tools: [...body.scope.tools],
      shell: body.scope.shell,
      read: paths(body.scope.read),
      write: paths(body.scope.write),
      net: body.scope.net,
      mcp: body.scope.mcp,
    },
    evidence: noEvidence('missing'),
  };
  return {
    kind: 'selected',
    value: { rawId, source, directoryPin: directoryPin!, revoked, ended, signed: signed.data, row },
  };
}

export type Journal = {
  status: TaskLockEvidence['status'];
  sha256: string | null;
  entries: AuditEntry[] | null;
  /** Private capture metadata: never included in a browser projection. */
  source?: FileCapture;
  rawSha256?: string[];
};

/** The core chain hash over captured bytes; no raw copy persists if a worker is terminated. */
export async function captureJournal(root: Location): Promise<Journal> {
  let source;
  try {
    source =
      root.homePin === null
        ? { kind: 'missing' as const }
        : await file(join(root.home, 'audit.jsonl'), 16 * 1024 * 1024);
  } catch (error) {
    return {
      status:
        error instanceof Error && error.message === 'source-limit'
          ? 'limit'
          : error instanceof Error && error.message === 'invalid-source'
            ? 'broken'
            : 'unavailable',
      sha256: null,
      entries: null,
    };
  }
  if (source.kind === 'missing') return { status: 'missing', sha256: null, entries: null, source };
  const broken: Journal = { status: 'broken', sha256: source.sha256, entries: null, source };
  try {
    const lines = source.text.split('\n').filter((line) => line.trim().length > 0);
    const entries: AuditEntry[] = [];
    let previous = GENESIS_HASH;
    for (const [index, line] of lines.entries()) {
      const parsed = parseStrictJson(line);
      if (!parsed.ok || !object(parsed.value)) return broken;
      const entry = parsed.value;
      if (
        entry.seq !== index + 1 ||
        entry.prevHash !== previous ||
        typeof entry.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        typeof entry.ts !== 'string' ||
        !isCanonicalIso(entry.ts) ||
        !['pre', 'post'].includes(String(entry.phase)) ||
        typeof entry.sessionId !== 'string' ||
        typeof entry.tool !== 'string'
      )
        return broken;
      const { hash: digest, ...unhashed } = entry;
      if (hashEntry(unhashed as unknown as Omit<AuditEntry, 'hash'>) !== digest) return broken;
      previous = digest;
      entries.push(entry as unknown as AuditEntry);
    }
    return {
      status: 'verified',
      sha256: source.sha256,
      entries,
      source,
      rawSha256: lines.map(hash),
    };
  } catch {
    return broken;
  }
}

export function evidenceFor(journal: Journal, selected: Selected): TaskLockEvidence {
  if (journal.entries === null) return noEvidence(journal.status, journal.sha256);
  const entries = journal.entries.filter((entry) => entry.taskId === selected.rawId);
  for (const entry of entries) {
    if (
      (entry.phase === 'pre' && !effect(entry.decision?.effect)) ||
      (entry.scope !== undefined && (!object(entry.scope) || !kinds.includes(entry.scope.kind))) ||
      (entry.callId !== undefined && typeof entry.callId !== 'string')
    )
      return noEvidence('broken', journal.sha256);
  }
  const receipt = taskReceipt(entries, selected.rawId, selected.row.declaredMode);
  const calls = receipt.calls;
  const last = [...entries]
    .reverse()
    .find((entry) => entry.phase === 'pre' && entry.scope !== undefined);
  return {
    status: 'verified',
    journalSha256: journal.sha256,
    counts: {
      calls: calls.length,
      allowed: calls.filter((call) => call.decision?.effect === 'allow').length,
      denied: calls.filter((call) => call.decision?.effect === 'deny').length,
      asks: calls.filter((call) => call.decision?.effect === 'ask').length,
      hostReported: calls.filter((call) => call.status === 'host-reported').length,
      hostFailure: calls.filter((call) => call.status === 'host-reported-failure').length,
      unconfirmed: calls.filter((call) => call.status === 'unconfirmed').length,
    },
    lastGate:
      last === undefined
        ? null
        : { at: last.ts, effect: last.decision!.effect, kind: last.scope!.kind },
  };
}

export function selectedBinding(selected: Selected) {
  return {
    rawId: selected.rawId,
    directoryPin: selected.directoryPin,
    source: binding(selected.source),
    revoked: selected.revoked,
    ended: selected.ended,
  };
}
