import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Project only the documented audit, liveness and proof formats. Never enumerate
// the home, read credentials/cloak, run the CLI, or repeat stored free-form text.
const HOSTS = [
  ['claude-code', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['codex', 'Codex CLI'],
];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FUTURE_SKEW = 5 * 60_000;
const AUDIT_BYTES = 1024 * 1024;
const MAX_CALLS = 500;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));
const text = (value, pattern) => typeof value === 'string' && pattern.test(value);
const plain = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x20-\x7e]+$/.test(value);

function validTime(value, now) {
  if (!text(value, ISO)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value &&
    parsed.getTime() <= now + FUTURE_SKEW
  );
}

/** Fixed relative paths only; refuse symlinks, special files, hard links and growing reads. */
async function boundedFile(home, parts, maxBytes, tail = false) {
  let handle;
  try {
    const base = resolve(home);
    if (!(await lstat(base)).isDirectory()) return { kind: 'refused' };
    const root = await realpath(base);
    let path = root;
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      if (!(await lstat(path)).isDirectory()) return { kind: 'refused' };
    }
    path = join(path, parts.at(-1));
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || (!tail && before.size > maxBytes))
      return { kind: 'refused' };
    handle = await open(path, READ_FLAGS);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      (await realpath(path)) !== path
    )
      return { kind: 'refused' };
    if (!tail && stat.size > maxBytes) return { kind: 'refused' };
    const offset = tail ? Math.max(0, stat.size - maxBytes) : 0;
    const bytes = Buffer.alloc(Math.min(maxBytes, stat.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || after.size < stat.size) return { kind: 'refused' };
    // A tail may start in the middle of UTF-8; discard that partial line before decoding.
    const start = offset > 0 ? bytes.indexOf(10) + 1 : 0;
    if (offset > 0 && start === 0) return { kind: 'refused' };
    return {
      kind: 'text',
      value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start)),
      truncated: offset > 0,
    };
  } catch (error) {
    return { kind: error?.code === 'ENOENT' ? 'absent' : 'refused' };
  } finally {
    await handle?.close();
  }
}

const DECISIONS = {
  deny: [
    'block',
    'Policy denied a tool call',
    'Recorded policy denial; host enforcement was not checked.',
  ],
  ask: [
    'ask',
    'Policy requested approval',
    'Recorded approval requirement; no user response is inferred.',
  ],
  allow: [
    'allow',
    'Policy allowed a tool call',
    'Recorded policy allow; successful execution is not inferred.',
  ],
  suspect: [
    'flag',
    'A content scan raised a finding',
    'Recorded scan observation; this does not establish a blocked action.',
  ],
};

function auditCall(row, raw, now) {
  if (!object(row) || !Number.isSafeInteger(row.seq) || row.seq < 1 || !validTime(row.ts, now))
    return null;
  if (
    typeof row.sessionId !== 'string' ||
    row.sessionId.length < 1 ||
    row.sessionId.length > 512 ||
    row.outcome !== undefined
  )
    return null;
  let key;
  if (
    row.phase === 'pre' &&
    object(row.decision) &&
    ['deny', 'ask', 'allow'].includes(row.decision.effect)
  )
    key = row.decision.effect;
  if (
    row.phase === 'post' &&
    object(row.scan) &&
    row.scan.verdict === 'suspect' &&
    Number.isFinite(row.scan.score) &&
    row.scan.score >= 0 &&
    row.scan.score <= 1
  )
    key = 'suspect';
  if (key === undefined) return null;
  const [decision, label, reason] = DECISIONS[key];
  return {
    id: `audit-${row.seq}`,
    ...(/^[a-f0-9]{64}$/.test(row.hash) && /^[a-f0-9]{64}$/.test(row.prevHash)
      ? { evidenceSha: createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex') }
      : {}),
    sessionId: `session-${createHash('sha256').update(row.sessionId).digest('hex').slice(0, 16)}`,
    decision,
    label,
    reason,
    raw: 'Command and content withheld',
    agent: 'Unknown host',
    date: row.ts.slice(0, 10),
    time: row.ts.slice(11, 19),
  };
}

async function readCalls(home, now, limitations) {
  const file = await boundedFile(home, ['audit.jsonl'], AUDIT_BYTES, true);
  if (file.kind !== 'text') {
    limitations.push(
      file.kind === 'absent'
        ? 'No local audit file is available.'
        : 'The local audit file was refused or unreadable.',
    );
    return [];
  }
  if (file.truncated) limitations.push('Only the most recent 1 MiB audit tail was read.');
  const lines = file.value.split('\n');
  const incomplete = lines.pop(); // An appended record without its newline is not complete yet.
  let skipped = incomplete ? 1 : 0;
  const calls = [];
  const ids = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      if (line.length > 64 * 1024) throw new Error('large');
      const row = JSON.parse(line);
      const call = auditCall(row, line, now);
      if (call === null || ids.has(call.id)) {
        skipped++;
        continue;
      }
      ids.add(call.id);
      calls.push(call);
    } catch {
      skipped++;
    }
  }
  if (skipped)
    limitations.push(
      'Some unreadable, unsupported, incomplete or non-decision audit records were omitted.',
    );
  if (calls.length > MAX_CALLS)
    limitations.push('At most 500 recent policy decisions and scan findings are displayed.');
  return calls.slice(-MAX_CALLS).reverse();
}

const CODE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const MARKS = ['passed', 'failed', 'not-issued', 'inconclusive', 'skipped', 'not-attempted'];
function validProbe(probe) {
  if (
    !keysOnly(probe, ['id', 'kind', 'mark', 'reason', 'detail', 'evidence']) ||
    !text(probe.id, CODE) ||
    !['allow', 'deny', 'secret-egress'].includes(probe.kind) ||
    !MARKS.includes(probe.mark)
  )
    return false;
  if (
    (probe.reason !== undefined && !text(probe.reason, CODE)) ||
    (probe.detail !== undefined && !plain(probe.detail, 160))
  )
    return false;
  const evidence = probe.evidence;
  if (
    !keysOnly(evidence, ['E1', 'E2', 'E3', 'E4']) ||
    !['E1', 'E2', 'E3', 'E4'].every(
      (key) => evidence[key] === null || typeof evidence[key] === 'boolean',
    )
  )
    return false;
  if (probe.mark === 'failed') return evidence.E1 === true;
  if (probe.mark !== 'passed') return true;
  return (
    evidence.E1 === true &&
    evidence.E3 === true &&
    (probe.id.endsWith(':control') || evidence.E2 === true)
  );
}

// Same evidence rule as packages/cli/src/live/state-rule.ts. Historical results
// are never promoted to current protection without the CLI's freshness checks.
function provedState(probes) {
  if (probes.some((probe) => probe.mark === 'failed')) return 'failed';
  const real = probes.filter((probe) => !probe.id.endsWith(':control'));
  const allowed = real.some((probe) => probe.kind === 'allow' && probe.mark === 'passed');
  const denied = real.some(
    (probe) =>
      probe.kind !== 'allow' &&
      probe.mark === 'passed' &&
      probe.evidence.E4 === true &&
      probes.some(
        (control) =>
          control.id === `${probe.id}:control` &&
          control.kind === probe.kind &&
          control.mark === 'passed',
      ),
  );
  if (allowed && denied) return 'verified';
  return probes.every((probe) => ['not-attempted', 'skipped'].includes(probe.mark))
    ? 'not-attempted'
    : 'inconclusive';
}

function validProof(raw, agent, now) {
  if (
    !keysOnly(raw, [
      'version',
      'agent',
      'hostVersion',
      'stroqVersion',
      'policySha256',
      'at',
      'mode',
      'probes',
      'state',
      'caveats',
    ])
  )
    return false;
  if (
    raw.version !== 1 ||
    raw.agent !== agent ||
    raw.mode !== 'live' ||
    !['verified', 'failed'].includes(raw.state) ||
    !validTime(raw.at, now)
  )
    return false;
  if (
    !(raw.hostVersion === null || plain(raw.hostVersion, 80)) ||
    !plain(raw.stroqVersion, 80) ||
    !text(raw.policySha256, /^[a-f0-9]{64}$/)
  )
    return false;
  if (
    !Array.isArray(raw.caveats) ||
    raw.caveats.length > 16 ||
    !raw.caveats.every((value) => plain(value, 120))
  )
    return false;
  if (
    !Array.isArray(raw.probes) ||
    raw.probes.length > 16 ||
    !raw.probes.every(validProbe) ||
    new Set(raw.probes.map((probe) => probe.id)).size !== raw.probes.length
  )
    return false;
  return provedState(raw.probes) === raw.state;
}

async function readAgent(home, id, name, now, limitations) {
  const [stamp, proof] = await Promise.all([
    boundedFile(home, ['last-hook', id], 64),
    boundedFile(home, ['live', `${id}.json`], 64 * 1024),
  ]);
  const observed = stamp.kind === 'text' && validTime(stamp.value.trim(), now);
  let stored = null;
  if (proof.kind === 'text') {
    try {
      const parsed = JSON.parse(proof.value);
      if (validProof(parsed, id, now)) stored = parsed;
    } catch {
      /* Refuse malformed proof without repeating it. */
    }
  }
  if (
    stamp.kind === 'refused' ||
    (stamp.kind === 'text' && !observed) ||
    proof.kind === 'refused' ||
    (proof.kind === 'text' && !stored)
  )
    limitations.push(`${name}: invalid or unsupported local evidence was omitted.`);
  if (!observed && stored === null) return null;
  if (stored?.state === 'failed')
    limitations.push(
      `${name}: the stored live test recorded a failure; run stroq doctor to review current status.`,
    );
  return {
    id,
    name,
    version: 'Not read',
    state: 'unver',
    checks: [
      'na',
      observed ? 'yes' : 'na',
      stored?.state === 'verified' ? 'yes' : stored?.state === 'failed' ? 'no' : 'notyet',
      'na',
    ],
    next: 'stroq doctor',
  };
}

export async function readLocalSnapshot({
  home = process.env.STROQ_HOME || join(homedir(), '.stroq'),
  now = new Date(),
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new TypeError('Invalid snapshot clock');
  const limitations = [
    'Timestamps use UTC. Audit records describe policy decisions and scan observations, not proof of execution or blocking.',
    'Host attribution is not stored in the audit format. Session identifiers are pseudonymous hashes.',
    'Commands, content, tool labels, rule text and credential stores are withheld. No key inventory is read.',
    'The audit hash chain is not verified by this preview. Local files are not authenticated attestations.',
    'Hook stamps record a past call. Stored proofs are historical; current installation, policy and host versions are not checked.',
  ];
  const calls = await readCalls(home, now.getTime(), limitations);
  const agents = [];
  for (const [id, name] of HOSTS) {
    const agent = await readAgent(home, id, name, now.getTime(), limitations);
    if (agent) agents.push(agent);
  }
  return {
    schema: 'stroq-console/1',
    source: 'local',
    generatedAt: now.toISOString(),
    calls,
    agents,
    keys: [],
    limitations,
  };
}
