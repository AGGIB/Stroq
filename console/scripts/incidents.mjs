import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  hashBytes,
  readIncidentFile,
  parseIncidentEvidenceJson,
  projectIncidentRecordedEvidence,
} from './incidents-safe.mjs';
import {
  readReviews,
  validIncidentTime,
  validateReviewRequest,
  writeReview,
} from './incidents-store.mjs';
import { verifyIncidentJournal } from './incidents-worker.mjs';

const MAX_READ = 1024 * 1024;
const MAX_VERIFY = 16 * 1024 * 1024;
const MAX_INCIDENTS = 500;
// A bounded 64 KiB operation and review can each double when JSON-encoded in
// the audit entry. Keep those genuine refusals visible within the 1 MiB tail.
const MAX_LINE = 512 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const LIMITATIONS = [
  'Audit entries record policy decisions and content-scan observations. Host execution and enforcement are not established.',
  'Commands, content, rule text, credential values, session identifiers and paths are withheld. Host and project attribution were not recorded.',
  'Related events are preceding scan observations in the same recorded session, not proof of causation.',
  'Reviewed is a manual acknowledgement retained for 90 days, up to 1000 records. It does not establish remediation.',
  'Queue reads do not verify the audit hash chain. Local records are not authenticated attestations.',
];
const VERIFY_LIMITATIONS = [
  'This verifies the internal hash chain of one complete captured journal snapshot using the Stroq engine.',
  'Hash-chain consistency does not establish signed authenticity. Rewritten chains and tail truncation need an independently trusted checkpoint.',
  'A consistent journal does not prove host execution, blocking, agent identity or remediation.',
];
const TITLES = {
  'policy-deny': 'Policy denied a tool call',
  'policy-ask': 'Policy requested approval',
  'content-flag': 'Content scan raised a finding',
};
const CATEGORY_CLASSES = {
  network: ['shell.network', 'network.fetch', 'git.push_external'],
  execution: ['shell.exec_encoded', 'shell.unparsed'],
  credentials: ['fs.secrets', 'fs.canary', 'secret.egress', 'secret.unscannable'],
  filesystem: ['shell.destructive'],
  configuration: [
    'config.self',
    'config.self_touch',
    'config.git_exec',
    'config.persistence',
    'config.instructions',
    'config.instructions_payload',
  ],
  'external-tool': ['mcp.call', 'mcp.side_effect'],
};

function projectRecord(row, raw, now) {
  if (
    !object(row) ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 1 ||
    !validIncidentTime(row.ts, now) ||
    !SHA.test(row.hash) ||
    !SHA.test(row.prevHash) ||
    typeof row.sessionId !== 'string' ||
    !row.sessionId.length ||
    row.sessionId.length > 512
  )
    return { kind: 'invalid' };
  if (row.outcome !== undefined) return { kind: 'ignored' };
  let kind;
  if (row.phase === 'pre' && object(row.decision) && ['deny', 'ask'].includes(row.decision.effect))
    kind = `policy-${row.decision.effect}`;
  if (
    row.phase === 'post' &&
    object(row.scan) &&
    row.scan.verdict === 'suspect' &&
    Number.isFinite(row.scan.score) &&
    row.scan.score >= 0 &&
    row.scan.score <= 1
  )
    kind = 'content-flag';
  if (!kind) return { kind: 'ignored' };
  const evidenceSha = hashBytes(Buffer.from(raw, 'utf8'));
  const classes = Array.isArray(row.classes)
    ? row.classes.filter((value) => typeof value === 'string')
    : [];
  const categories = Object.entries(CATEGORY_CLASSES)
    .filter(([, values]) => values.some((value) => classes.includes(value)))
    .map(([key]) => key);
  return {
    kind: 'incident',
    session: row.sessionId,
    incident: {
      id: `incident-${evidenceSha}`,
      evidenceSha,
      recordedAt: row.ts,
      sequence: row.seq,
      kind,
      severity: kind === 'policy-deny' ? 'high' : 'medium',
      title: TITLES[kind],
      categories: categories.length ? categories : ['unclassified'],
      relatedIds: [],
      secretReferences: Array.isArray(row.secrets) ? Math.min(row.secrets.length, 1000) : 0,
      status: 'open',
      reviewedAt: null,
    },
  };
}

function projectJournal(file, now) {
  const incidents = [];
  const previousFlags = new Map();
  const seen = new Set();
  let omitted = 0;
  const lines = file.text.split('\n');
  if (!file.text.endsWith('\n') && lines.at(-1)?.trim()) {
    lines.pop();
    omitted++;
  }
  for (const raw of lines) {
    if (!raw.trim()) continue;
    try {
      if (Buffer.byteLength(raw, 'utf8') > MAX_LINE) throw new Error();
      const projected = projectRecord(JSON.parse(raw), raw, now);
      if (projected.kind === 'invalid') {
        omitted++;
        continue;
      }
      if (projected.kind !== 'incident') continue;
      const { session, incident } = projected;
      if (seen.has(incident.id)) {
        omitted++;
        continue;
      }
      seen.add(incident.id);
      const flags = previousFlags.get(session) ?? [];
      incidents.push({ ...incident, relatedIds: flags.slice(-8) });
      if (incident.kind === 'content-flag')
        previousFlags.set(session, [...flags.slice(-7), incident.id]);
    } catch {
      omitted++;
    }
  }
  const recent = incidents.slice(-MAX_INCIDENTS).reverse();
  const ids = new Set(recent.map((row) => row.id));
  return {
    incidents: recent.map((row) => ({
      ...row,
      relatedIds: row.relatedIds.filter((id) => ids.has(id)),
    })),
    omitted: omitted + Math.max(0, incidents.length - MAX_INCIDENTS),
  };
}

export function createIncidentService({
  home = process.env.STROQ_HOME || join(homedir(), '.stroq'),
  now = () => new Date(),
  verifyAdapter = verifyIncidentJournal,
  maxReadBytes = MAX_READ,
  maxVerifyBytes = MAX_VERIFY,
} = {}) {
  const root = resolve(home);
  const readLimit = Math.min(MAX_READ, maxReadBytes);
  const verifyLimit = Math.min(MAX_VERIFY, maxVerifyBytes);
  let verifying = false;
  const clock = () => {
    const date = now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
      throw new TypeError('invalid-clock');
    return date;
  };
  const capture = () => readIncidentFile(root, ['audit.jsonl'], readLimit, { tail: true });
  async function read() {
    const at = clock();
    const file = await capture();
    const projected =
      file.kind === 'text' ? projectJournal(file, at.getTime()) : { incidents: [], omitted: 0 };
    const limitations = [...LIMITATIONS];
    let reviews = [];
    try {
      reviews = (await readReviews(root, at.getTime())).records;
    } catch {
      limitations.push(
        'Stored review acknowledgements are unavailable; current events are shown as open.',
      );
    }
    if (file.truncated)
      limitations.push('Only the most recent 1 MiB is read; at most 500 findings are displayed.');
    const byId = new Map(reviews.map((row) => [row.id, row]));
    return {
      schema: 'stroq-incidents/1',
      source: 'local',
      generatedAt: at.toISOString(),
      window: {
        kind: file.kind === 'text' ? 'available' : file.kind === 'missing' ? 'missing' : 'refused',
        truncated: file.truncated ?? false,
        omitted: projected.omitted,
      },
      incidents: projected.incidents.map((row) => {
        const review = byId.get(row.id);
        return review?.evidenceSha === row.evidenceSha
          ? { ...row, status: 'reviewed', reviewedAt: review.reviewedAt }
          : row;
      }),
      limitations,
    };
  }
  async function review(request) {
    validateReviewRequest(request);
    const recheck = async () => {
      const file = await capture();
      if (file.kind !== 'text') throw new Error('stale-evidence');
      const row = projectJournal(file, clock().getTime()).incidents.find(
        (row) => row.id === request.id,
      );
      if (!row || row.evidenceSha !== request.expectedEvidenceSha)
        throw new Error('stale-evidence');
    };
    // Invalid/stale requests cannot create an acknowledgement directory.
    await recheck();
    return writeReview(root, request, clock().getTime(), recheck);
  }
  async function selectForComparison(request) {
    if (
      !object(request) ||
      Object.keys(request).length !== 2 ||
      !Object.hasOwn(request, 'id') ||
      !Object.hasOwn(request, 'expectedEvidenceSha') ||
      typeof request.expectedEvidenceSha !== 'string' ||
      !SHA.test(request.expectedEvidenceSha) ||
      request.id !== `incident-${request.expectedEvidenceSha}`
    )
      throw new Error('invalid-request');
    const file = await capture();
    if (file.kind !== 'text') throw new Error('stale-evidence');
    const current = projectJournal(file, clock().getTime()).incidents.find(
      (item) => item.id === request.id && item.evidenceSha === request.expectedEvidenceSha,
    );
    if (!current) throw new Error('stale-evidence');
    // Private service handoff only. The comparison service extracts known classes;
    // commands, identifiers and content never enter the HTTP response or worker input.
    const raw = file.text
      .split('\n')
      .find((line) => hashBytes(Buffer.from(line, 'utf8')) === current.evidenceSha);
    if (!raw) throw new Error('stale-evidence');
    return JSON.parse(raw);
  }
  async function explain(request) {
    if (
      !object(request) ||
      Object.keys(request).length !== 2 ||
      !Object.hasOwn(request, 'id') ||
      !Object.hasOwn(request, 'expectedEvidenceSha') ||
      typeof request.expectedEvidenceSha !== 'string' ||
      !SHA.test(request.expectedEvidenceSha) ||
      request.id !== `incident-${request.expectedEvidenceSha}`
    )
      throw new Error('invalid-request');
    const at = clock();
    const file = await capture();
    if (file.kind !== 'text') throw new Error('stale-evidence');
    const projected = projectJournal(file, at.getTime());
    const incident = projected.incidents.find(
      (row) => row.id === request.id && row.evidenceSha === request.expectedEvidenceSha,
    );
    if (!incident) throw new Error('stale-evidence');
    const raw = file.text
      .split('\n')
      .find((line) => hashBytes(Buffer.from(line, 'utf8')) === incident.evidenceSha);
    if (!raw) throw new Error('stale-evidence');
    const row = parseIncidentEvidenceJson(raw);
    const confirmed = projectRecord(row, raw, at.getTime());
    if (confirmed.kind !== 'incident' || confirmed.incident.id !== incident.id)
      throw new Error('stale-evidence');
    return projectIncidentRecordedEvidence(row, incident, at.toISOString(), {
      truncated: file.truncated ?? false,
      omitted: projected.omitted,
    });
  }
  async function verify(request = {}) {
    if (!object(request) || Object.keys(request).length !== 0) throw new Error('invalid-request');
    if (verifying) throw new Error('busy');
    verifying = true;
    try {
      return await verifySnapshot(root, clock(), verifyLimit, verifyAdapter);
    } finally {
      verifying = false;
    }
  }
  let closed = false;
  const active = new Set();
  const track = (operation) => {
    if (closed) return Promise.reject(new Error('server-stopped'));
    const promise = Promise.resolve().then(operation);
    active.add(promise);
    void promise.finally(() => active.delete(promise)).catch(() => undefined);
    return promise;
  };
  return {
    read: () => track(read),
    review: (request) => track(() => review(request)),
    selectForComparison: (request) => track(() => selectForComparison(request)),
    explain: (request) => track(() => explain(request)),
    verify: (request) => track(() => verify(request)),
    async close() {
      closed = true;
      await Promise.allSettled([...active]);
    },
  };
}

async function verifySnapshot(root, now, maxBytes, adapter) {
  const report = {
    schema: 'stroq-journal-verification/1',
    source: 'local',
    verifiedAt: now.toISOString(),
    status: 'engine-unavailable',
    journalSha: null,
    count: null,
    brokenAt: null,
    limitations: [...VERIFY_LIMITATIONS],
  };
  const file = await readIncidentFile(root, ['audit.jsonl'], maxBytes);
  if (file.kind !== 'text') return { ...report, status: file.kind };
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'stroq-journal-capture-'));
    const path = join(directory, 'audit.jsonl');
    await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
    const result = await adapter(path);
    if (
      !object(result) ||
      typeof result.ok !== 'boolean' ||
      !Number.isSafeInteger(result.count) ||
      result.count < 0 ||
      result.count > 1_000_000 ||
      (result.ok
        ? result.brokenAt !== null
        : !Number.isSafeInteger(result.brokenAt) || result.brokenAt < 1)
    )
      throw new Error();
    return {
      ...report,
      status: result.ok ? 'consistent' : 'broken',
      journalSha: file.revision,
      count: result.count,
      brokenAt: result.brokenAt,
    };
  } catch {
    return report;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
