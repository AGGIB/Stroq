import { join, isAbsolute, resolve } from 'node:path';
import { sessionKey, stableStringify } from '@stroq/core';
import { hash, same } from './task-lock-files.ts';
import { validateSessionTaintInspection } from '../lib/session-taint.ts';
import type { TaintOptions } from './session-taint-inspect.ts';

const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const iso = (v: unknown) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const number = (v: unknown) => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,24})$/.test(v);
const path = (v: unknown) =>
  typeof v === 'string' &&
  v.length <= 4096 &&
  !v.includes('\0') &&
  isAbsolute(v) &&
  resolve(v) === v;
function pin(v: unknown, file = false, staged = false, max = 16 * 1024 * 1024) {
  return (
    exact(v, [
      'dev',
      'ino',
      'uid',
      'mode',
      ...(file ? ['size', 'nlink', 'mtimeNs', ...(staged ? [] : ['ctimeNs'])] : []),
    ]) &&
    Object.values(v).every(number) &&
    (!file || (v.nlink === '1' && BigInt(v.size) <= BigInt(max))) &&
    (BigInt(v.mode) & 0o022n) === 0n
  );
}
function native(v: any, id: string, home: string) {
  return (
    exact(v, ['sessionId', 'path', 'directory', 'pin', 'sha256']) &&
    v.sessionId === id &&
    v.path === join(home, 'sessions', sessionKey(id) + '.json') &&
    sha(v.sha256) &&
    exact(v.directory, ['path', 'dev', 'ino', 'uid', 'mode']) &&
    v.directory.path === join(home, 'sessions') &&
    pin(Object.fromEntries(Object.entries(v.directory).filter(([k]) => k !== 'path'))) &&
    (BigInt(v.directory.mode) & 0o777n) === 0o700n &&
    pin(v.pin, true, false, 256 * 1024) &&
    (BigInt(v.pin.mode) & 0o777n) === 0o600n &&
    v.pin.uid === v.directory.uid
  );
}
function source(v: any, max: number) {
  return (
    (exact(v, ['kind']) && v.kind === 'missing') ||
    (exact(v, ['kind', 'pin', 'sha256']) &&
      v.kind === 'file' &&
      sha(v.sha256) &&
      pin(v.pin, true, false, max) &&
      (BigInt(v.pin.mode) & 0o777n) === 0o600n)
  );
}
function provenance(v: any, id: string, before: any, nativeDirectory: any) {
  if (
    !exact(v, ['directory', 'files', 'pendingDirectory']) ||
    !pin(v.directory) ||
    (BigInt(v.directory.mode) & 0o777n) !== 0o700n ||
    !same(
      v.directory,
      Object.fromEntries(Object.entries(nativeDirectory).filter(([k]) => k !== 'path')),
    ) ||
    !(
      v.pendingDirectory === null ||
      (pin(v.pendingDirectory) && (BigInt(v.pendingDirectory.mode) & 0o777n) === 0o700n)
    ) ||
    !Array.isArray(v.files) ||
    v.files.length < 5 ||
    v.files.length > 261
  )
    return false;
  const key = sessionKey(id),
    fixed = [
      '.prov.json',
      '.prov.digests.json',
      '.prov.incomplete',
      '.prov.digests-lost',
      '.prov.pending',
    ].map((s) => key + s),
    seen = new Set<string>();
  let pending = 0;
  for (const f of v.files) {
    if (!exact(f, ['name', 'source']) || typeof f.name !== 'string' || seen.has(f.name))
      return false;
    seen.add(f.name);
    const prefix = key + '.prov.pending.d/';
    const child = f.name.startsWith(prefix) && /^[a-f0-9]{16}$/.test(f.name.slice(prefix.length));
    if (
      (!fixed.includes(f.name) && !child) ||
      (child && v.pendingDirectory === null) ||
      !source(f.source, f.name.endsWith('.json') ? 2 * 1024 * 1024 : 4096) ||
      (child && f.source.kind !== 'file')
    )
      return false;
    if ((child || f.name === key + '.prov.pending') && f.source.kind === 'file') pending++;
  }
  if (
    fixed.some((name) => !seen.has(name)) ||
    hash(stableStringify(v)) !== before.provenance.sha256 ||
    pending !== before.provenance.pending
  )
    return false;
  const present = (suffix: string) =>
    v.files.find((f: any) => f.name === key + suffix).source.kind === 'file';
  return (
    before.provenance.incomplete === present('.prov.incomplete') &&
    before.provenance.digestsLost === present('.prov.digests-lost')
  );
}
/** The note of flags on the developer's own text (`OwnTextFlag`), which a clear of the taint keeps. */
function ownFlag(v: any): boolean {
  return (
    exact(v, ['since', 'count', 'last']) &&
    iso(v.since) &&
    Number.isSafeInteger(v.count) &&
    v.count > 0 &&
    v.last !== null &&
    typeof v.last === 'object' &&
    exact(v.last, [
      'tool',
      'at',
      'ruleIds',
      ...(Object.hasOwn(v.last, 'source') ? ['source'] : []),
    ]) &&
    typeof v.last.tool === 'string' &&
    iso(v.last.at) &&
    Array.isArray(v.last.ruleIds) &&
    v.last.ruleIds.every((r: any) => typeof r === 'string') &&
    (v.last.source === undefined || typeof v.last.source === 'string')
  );
}
function state(v: any, id: string, before: any) {
  const has = (key: string) => v !== null && typeof v === 'object' && Object.hasOwn(v, key);
  const flagged = has('flagged'),
    fetched = has('fetched');
  return (
    exact(v, [
      'sessionId',
      'taint',
      'updatedAt',
      ...(flagged ? ['flagged'] : []),
      ...(fetched ? ['fetched'] : []),
    ]) &&
    (!flagged || ownFlag(v.flagged)) &&
    (!fetched ||
      (Array.isArray(v.fetched) &&
        v.fetched.length <= 64 &&
        v.fetched.every((p: any) => typeof p === 'string' && p.length > 0 && p.length <= 4096))) &&
    v.sessionId === id &&
    iso(v.updatedAt) &&
    exact(v.taint, ['level', 'since', 'sources']) &&
    v.taint.level === 'suspect' &&
    v.taint.since === before.taint.since &&
    Array.isArray(v.taint.sources) &&
    v.taint.sources.length === before.taint.sources &&
    v.taint.sources.length <= 4096 &&
    v.taint.sources.every(
      (s: any) =>
        s !== null &&
        typeof s === 'object' &&
        exact(s, ['tool', 'at', 'ruleIds', ...(Object.hasOwn(s, 'source') ? ['source'] : [])]) &&
        typeof s.tool === 'string' &&
        iso(s.at) &&
        Array.isArray(s.ruleIds) &&
        s.ruleIds.every((r: any) => typeof r === 'string') &&
        (s.source === undefined || typeof s.source === 'string'),
    )
  );
}
/**
 * The audit record of the clear: the session, the state it replaced and the one that replaced it, when, and
 * the person's confirmation. A clear that was published has one; none is published without it.
 */
function audit(v: any): boolean {
  const a = v.audit,
    b = v.binding;
  if (a === null) return v.status !== 'cleared';
  return (
    exact(a, ['sessionId', 'beforeSha256', 'afterSha256', 'at', 'confirmation']) &&
    a.sessionId === b.sessionId &&
    a.beforeSha256 === b.native.sha256 &&
    a.afterSha256 === v.staged.sha256 &&
    a.at === v.createdAt &&
    exact(a.confirmation, ['weakensRestrictions', 'recoveryRetention', 'previewId']) &&
    a.confirmation.weakensRestrictions === true &&
    a.confirmation.recoveryRetention === true &&
    typeof a.confirmation.previewId === 'string' &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(a.confirmation.previewId)
  );
}
/** Closed recovery envelope. Every filesystem child is derived from the selected home. */
export function validTaintPrivate(v: any, backup: Buffer, decoded: any, options: TaintOptions) {
  if (
    !exact(v, [
      'schema',
      'id',
      'createdAt',
      'updatedAt',
      'status',
      'before',
      'binding',
      'staged',
      'published',
      'audit',
      'backup',
    ]) ||
    v.schema !== 'stroq-session-taint-private/1' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.id) ||
    !iso(v.createdAt) ||
    !iso(v.updatedAt) ||
    v.updatedAt < v.createdAt ||
    !validateSessionTaintInspection(v.before) ||
    v.before.taint.status !== 'suspect' ||
    v.before.checkedAt > v.createdAt ||
    !['prepared', 'cleared', 'unchanged', 'uncertain'].includes(v.status)
  )
    return false;
  const b = v.binding;
  if (
    !exact(b, [
      'selection',
      'sessionId',
      'native',
      'provenance',
      'journal',
      'root',
      'runtimeSha256',
      'engineVersion',
    ]) ||
    typeof b.sessionId !== 'string' ||
    !b.sessionId.length ||
    b.sessionId.length > 512 ||
    v.before.sessionRef !== `session-${hash(b.sessionId)}` ||
    !native(b.native, b.sessionId, options.home) ||
    b.native.sha256 !== v.before.taint.sha256 ||
    backup.length !== Number(b.native.pin.size) ||
    hash(backup) !== b.native.sha256 ||
    !state(decoded, b.sessionId, v.before) ||
    !exact(b.selection, ['id', 'expectedEvidenceSha', 'sequence', 'recordedAt']) ||
    b.selection.id !== v.before.incident.id ||
    b.selection.expectedEvidenceSha !== v.before.incident.evidenceSha256 ||
    b.selection.sequence !== v.before.incident.sequence ||
    b.selection.recordedAt !== v.before.incident.recordedAt ||
    !sha(b.runtimeSha256) ||
    typeof b.engineVersion !== 'string' ||
    !b.engineVersion.length ||
    b.engineVersion.length > 100 ||
    !exact(b.root, [
      'project',
      'userHome',
      'home',
      'projectPin',
      'userPin',
      'homePin',
      'tasksPin',
      'keysPin',
    ]) ||
    !path(b.root.project) ||
    b.root.home !== options.home ||
    b.root.userHome !== options.userHome ||
    v.before.workspaceId !== `workspace-${hash(b.root.project).slice(0, 24)}` ||
    !pin(b.root.projectPin) ||
    !pin(b.root.userPin) ||
    !pin(b.root.homePin) ||
    !['tasksPin', 'keysPin'].every((k) => b.root[k] === null || pin(b.root[k])) ||
    !provenance(b.provenance, b.sessionId, v.before, b.native.directory) ||
    !exact(b.journal, ['pin', 'sha256', 'bytes']) ||
    !pin(b.journal.pin, true) ||
    !sha(b.journal.sha256) ||
    !Number.isSafeInteger(b.journal.bytes) ||
    b.journal.bytes < 1 ||
    b.journal.bytes !== Number(b.journal.pin.size) ||
    !exact(v.staged, ['sha256', 'pin']) ||
    !sha(v.staged.sha256) ||
    !pin(v.staged.pin, true, true, 256 * 1024) ||
    (BigInt(v.staged.pin.mode) & 0o777n) !== 0o600n
  )
    return false;
  const candidate = Buffer.from(
    JSON.stringify({ ...decoded, taint: null, updatedAt: v.createdAt }),
  );
  if (hash(candidate) !== v.staged.sha256 || candidate.length !== Number(v.staged.pin.size))
    return false;
  if (!audit(v)) return false;
  if (v.status === 'cleared') {
    if (!pin(v.published, true, false, 256 * 1024)) return false;
    const { ctimeNs, ...published } = v.published;
    if (!same(published, v.staged.pin)) return false;
  } else if (v.published !== null) return false;
  const revision = hash(
    stableStringify({
      sessionRef: hash(b.sessionId),
      native: { directory: b.native.directory, pin: b.native.pin, sha256: b.native.sha256 },
      provenance: b.provenance,
      context: b.root,
      runtimeSha256: b.runtimeSha256,
      engineVersion: b.engineVersion,
      incident: b.selection,
    }),
  );
  return revision === v.before.revisionSha256;
}
