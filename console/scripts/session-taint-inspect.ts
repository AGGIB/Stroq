import { join } from 'node:path';
import { opendir } from 'node:fs/promises';
import {
  captureSessionTaint,
  sessionKey,
  stableStringify,
  type SessionTaintSnapshot,
} from '@stroq/core';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import {
  validateSessionTaintInspection,
  type SessionTaintInspection,
} from '../lib/session-taint.ts';
import { captureJournal } from './task-lock-inspect.ts';
import {
  directory,
  file,
  binding,
  hash,
  same,
  location,
  assertLocation,
  fail,
  checkDeadline,
  type Options,
  type Location,
  type FileBinding,
  type FilePin,
} from './task-lock-files.ts';

export interface TaintSelection {
  id: string;
  expectedEvidenceSha: string;
  sequence: number;
  recordedAt: string;
}
export interface TaintOptions extends Options {
  commitGuard?: { runtimePaths: Record<string, string>; expiresAt: number | null };
}
export interface ProvenanceBinding {
  directory: Awaited<ReturnType<typeof directory>>;
  files: { name: string; source: FileBinding }[];
  pendingDirectory: Awaited<ReturnType<typeof directory>>;
}
export interface TaintBinding {
  selection: TaintSelection;
  sessionId: string;
  native: SessionTaintSnapshot;
  provenance: ProvenanceBinding;
  journal: { pin: FilePin; sha256: string; bytes: number };
  root: Location;
  runtimeSha256: string;
  engineVersion: string;
}
const object = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function selected(input: TaintSelection, journal: Awaited<ReturnType<typeof captureJournal>>) {
  if (
    journal.status !== 'verified' ||
    journal.source?.kind !== 'file' ||
    !journal.source.text.endsWith('\n')
  )
    fail('evidence-unavailable');
  const raw = journal.source.text
    .split('\n')
    .find((line) => hash(line) === input.expectedEvidenceSha);
  if (!raw || input.id !== `incident-${input.expectedEvidenceSha}`) fail('stale-evidence');
  const parsed = parseStrictJson(raw);
  if (!parsed.ok || !object(parsed.value)) fail('stale-evidence');
  const row = (parsed as { ok: true; value: Record<string, any> }).value;
  if (
    row.seq !== input.sequence ||
    row.ts !== input.recordedAt ||
    typeof row.sessionId !== 'string' ||
    !row.sessionId.length ||
    row.sessionId.length > 512 ||
    Object.hasOwn(row, 'outcome') ||
    !(
      (row.phase === 'pre' &&
        object(row.decision) &&
        ['deny', 'ask'].includes(row.decision.effect)) ||
      (row.phase === 'post' && object(row.scan) && row.scan.verdict === 'suspect')
    )
  )
    fail('stale-evidence');
  return row.sessionId as string;
}
function records(text: string, digests: boolean) {
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !Array.isArray(parsed.value) || parsed.value.length > 2000)
    fail('provenance-unavailable');
  let suspect = 0;
  for (const v of (parsed as { ok: true; value: unknown[] }).value) {
    // A record of the developer's own text that was flagged carries `flaggedOwn` (it taints nothing).
    const keys = Object.hasOwn(object(v) ? v : {}, 'flaggedOwn')
      ? 'at,excerpt,flaggedOwn,hash,kind,seq,source,suspect,tool'
      : 'at,excerpt,hash,kind,seq,source,suspect,tool';
    if (
      !object(v) ||
      Object.keys(v).sort().join(',') !== keys ||
      (v.flaggedOwn !== undefined && typeof v.flaggedOwn !== 'boolean') ||
      !Number.isSafeInteger(v.seq) ||
      v.seq < 1 ||
      typeof v.at !== 'string' ||
      !Number.isFinite(Date.parse(v.at)) ||
      !['tool', 'source', 'hash', 'excerpt'].every((k) => typeof v[k] === 'string') ||
      typeof v.suspect !== 'boolean' ||
      !(digests ? ['digest'] : ['url', 'host', 'pkg', 'pipe_shell', 'encoded']).includes(v.kind)
    )
      fail('provenance-unavailable');
    if (v.suspect) suspect++;
  }
  return { records: (parsed as { ok: true; value: unknown[] }).value.length, suspect };
}
export async function captureProvenance(root: Location, sessionId: string) {
  const dir = join(root.home, 'sessions'),
    key = sessionKey(sessionId),
    directoryPin = await directory(dir);
  const files: ProvenanceBinding['files'] = [];
  let total = 0,
    suspect = 0,
    pending = 0,
    incomplete = false,
    digestsLost = false;
  for (const suffix of [
    '.prov.json',
    '.prov.digests.json',
    '.prov.incomplete',
    '.prov.digests-lost',
    '.prov.pending',
  ]) {
    const name = key + suffix,
      s = await file(join(dir, name), suffix.endsWith('.json') ? 2 * 1024 * 1024 : 4096);
    files.push({ name, source: binding(s) });
    if (s.kind === 'missing') continue;
    if ((Number(s.pin.mode) & 0o777) !== 0o600) fail('unsafe-state');
    if (suffix.endsWith('.json')) {
      const c = records(s.text, suffix.includes('digests'));
      total += c.records;
      suspect += c.suspect;
    }
    if (suffix === '.prov.incomplete') incomplete = true;
    if (suffix === '.prov.digests-lost') digestsLost = true;
    if (suffix === '.prov.pending') pending++;
  }
  const pendingPath = join(dir, key + '.prov.pending.d'),
    pendingDirectory = await directory(pendingPath, true);
  if (pendingDirectory) {
    const list = await opendir(pendingPath, { bufferSize: 4 });
    let count = 0;
    for await (const entry of list) {
      if (++count > 256 || !/^[a-f0-9]{16}$/.test(entry.name) || !entry.isFile())
        fail('provenance-unavailable');
      const name = key + '.prov.pending.d/' + entry.name,
        s = await file(join(dir, name), 4096);
      if (s.kind === 'missing') fail('stale-state');
      if ((Number(s.pin.mode) & 0o777) !== 0o600) fail('unsafe-state');
      files.push({ name, source: binding(s) });
      pending++;
    }
    if (!same(await directory(pendingPath), pendingDirectory)) fail('stale-state');
  }
  if (!same(await directory(dir), directoryPin)) fail('stale-state');
  files.sort((a, b) => a.name.localeCompare(b.name));
  const bound: ProvenanceBinding = { directory: directoryPin, files, pendingDirectory };
  return {
    binding: bound,
    public: {
      sha256: hash(stableStringify(bound)),
      records: total,
      suspect,
      incomplete,
      digestsLost,
      pending,
    },
  };
}
export async function inspectSessionTaint(
  options: TaintOptions,
  input: TaintSelection,
  expected?: TaintBinding,
) {
  checkDeadline(options);
  const root = await location(options),
    journal = await captureJournal(root),
    sessionId = selected(input, journal);
  if (journal.source?.kind !== 'file') fail('evidence-unavailable');
  if (expected) {
    const old = expected.journal,
      fresh = journal.source;
    if (
      sessionId !== expected.sessionId ||
      !same(root, expected.root) ||
      !(['dev', 'ino', 'uid', 'mode', 'nlink'] as const).every(
        (k) => fresh.pin[k] === old.pin[k],
      ) ||
      fresh.bytes.length < old.bytes ||
      hash(fresh.bytes.subarray(0, old.bytes)) !== old.sha256 ||
      (fresh.bytes.length === old.bytes && !same(fresh.pin, old.pin))
    )
      fail('stale-evidence');
  }
  let native: SessionTaintSnapshot;
  try {
    native = await captureSessionTaint(join(root.home, 'sessions'), sessionId);
  } catch (error) {
    if ((error as Error).message === 'session-taint-stale') fail('stale-state');
    fail('session-unavailable');
  }
  const provenance = await captureProvenance(root, sessionId);
  const second = await captureSessionTaint(join(root.home, 'sessions'), sessionId),
    secondProvenance = await captureProvenance(root, sessionId);
  if (
    !same(
      { pin: native.pin, sha256: native.sha256, directory: native.directory },
      { pin: second.pin, sha256: second.sha256, directory: second.directory },
    ) ||
    !same(provenance.binding, secondProvenance.binding)
  )
    fail('stale-state');
  await assertLocation(options, root);
  const bound: TaintBinding = {
    selection: input,
    sessionId,
    native,
    provenance: provenance.binding,
    journal: {
      pin: journal.source.pin,
      sha256: journal.source.sha256,
      bytes: journal.source.bytes.length,
    },
    root,
    runtimeSha256: options.runtimeSha256,
    engineVersion: options.engineVersion,
  };
  // Appends to the journal do not change current session state authority.
  const revision = hash(
    stableStringify({
      sessionRef: hash(sessionId),
      native: { directory: native.directory, pin: native.pin, sha256: native.sha256 },
      provenance: provenance.binding,
      context: root,
      runtimeSha256: options.runtimeSha256,
      engineVersion: options.engineVersion,
      incident: input,
    }),
  );
  const report: SessionTaintInspection = {
    schema: 'stroq-session-taint-inspection/1',
    workspaceId: options.workspaceId,
    incident: {
      id: input.id,
      evidenceSha256: input.expectedEvidenceSha,
      sequence: input.sequence,
      recordedAt: input.recordedAt,
    },
    sessionRef: `session-${hash(sessionId)}`,
    checkedAt: options.now ?? new Date().toISOString(),
    revisionSha256: revision,
    taint: {
      status: native.state?.taint ? 'suspect' : 'clear',
      sources: native.state?.taint?.sources.length ?? 0,
      since: native.state?.taint?.since ?? null,
      sha256: native.sha256,
    },
    provenance: provenance.public,
  };
  if (!validateSessionTaintInspection(report)) fail('invalid-state');
  return { report, binding: bound };
}
