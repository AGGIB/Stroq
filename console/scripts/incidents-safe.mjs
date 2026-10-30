import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const owned = (stat) => uid === null || stat.uid === uid;

const RECORDED_CLASSES = [
  'shell.exec_encoded',
  'shell.network',
  'shell.destructive',
  'shell.unparsed',
  'fs.secrets',
  'fs.canary',
  'git.push_external',
  'config.self',
  'config.self_touch',
  'config.git_exec',
  'config.persistence',
  'config.instructions',
  'config.instructions_payload',
  'network.fetch',
  'mcp.call',
  'mcp.side_effect',
  'origin.untrusted',
  'origin.suspect',
  'secret.egress',
  'secret.unscannable',
];
const ORIGIN_KINDS = ['url', 'host', 'pkg', 'pipe_shell', 'encoded', 'digest'];
const SCOPE_KINDS = ['void', 'hard', 'scope', 'ask', 'policy', 'escalated', 'in-scope'];
export const RECORDED_EVIDENCE_LIMITATIONS = [
  'Only fields recorded in this exact journal entry are projected; missing fields are not inferred.',
  'Original session taint and policy version were not recorded. Current state and current-policy comparison are separate.',
  'Recorded origin matches and earlier same-session events do not establish why the model chose an action.',
  'Commands, content, rule identifiers and reasons, session identifiers, source paths, excerpts and secret labels are withheld.',
  'The captured journal window is bounded and may omit earlier events; a scan score is not an attack probability.',
  'This read does not verify the journal hash chain or establish authenticated evidence, host execution, blocking or remediation.',
  'Task-scope labels describe recorded evidence, not current permission, a valid signature or host enforcement.',
];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const privateText = (value) =>
  typeof value === 'string' && value.length <= 4096 && value.isWellFormed();
const recordedTime = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const emptyEvidence = (status) => ({ status, values: [], omitted: 0 });

/** Raw selected journal evidence only. No duplicate-key or nested grammar fallback. */
export function parseIncidentEvidenceJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024)
    throw Error('unsupported-evidence');
  let at = 0,
    nodes = 0;
  const fail = () => {
    throw Error('unsupported-evidence');
  };
  const whitespace = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
  };
  const string = () => {
    if (text[at++] !== '"') fail();
    const start = at - 1;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') {
        const decoded = JSON.parse(text.slice(start, at));
        if (!decoded.isWellFormed()) fail();
        return decoded;
      }
    }
    fail();
  };
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (depth) => {
    if (++nodes > 65536 || depth > 32) fail();
    whitespace();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === '{') {
      at++;
      whitespace();
      const seen = new Set();
      if (text[at] === '}') {
        at++;
        return;
      }
      for (;;) {
        const key = string();
        if (seen.has(key)) fail();
        seen.add(key);
        whitespace();
        if (text[at++] !== ':') fail();
        value(depth + 1);
        whitespace();
        if (text[at] === '}') {
          at++;
          return;
        }
        if (text[at++] !== ',') fail();
        whitespace();
      }
    }
    if (text[at] === '[') {
      at++;
      whitespace();
      if (text[at] === ']') {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (text[at] === ']') {
          at++;
          return;
        }
        if (text[at++] !== ',') fail();
      }
    }
    for (const literal of ['null', 'true', 'false'])
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return;
      }
    number.lastIndex = at;
    const match = number.exec(text);
    if (!match) fail();
    at = number.lastIndex;
  };
  try {
    value(0);
    whitespace();
    if (at !== text.length) fail();
    const parsed = JSON.parse(text);
    if (!object(parsed)) fail();
    return parsed;
  } catch {
    fail();
  }
}

function recordedClasses(row) {
  if (!Object.hasOwn(row, 'classes')) return emptyEvidence('not-recorded');
  if (!Array.isArray(row.classes)) return emptyEvidence('unavailable');
  const selected = row.classes.slice(0, 128);
  const known = new Set(selected.filter((value) => RECORDED_CLASSES.includes(value)));
  const omitted =
    row.classes.length -
    selected.length +
    selected.filter((value) => !RECORDED_CLASSES.includes(value)).length;
  return {
    status: omitted ? 'partial' : 'recorded',
    values: RECORDED_CLASSES.filter((value) => known.has(value)),
    omitted,
  };
}
function recordedScope(row) {
  if (!Object.hasOwn(row, 'scope')) return { status: 'not-recorded', kind: null };
  const value = row.scope;
  const valid =
    keys(value, ['ruleId', 'kind'], ['fingerprint']) &&
    privateText(value.ruleId) &&
    value.ruleId.length > 0 &&
    SCOPE_KINDS.includes(value.kind) &&
    (!Object.hasOwn(value, 'fingerprint') ||
      (typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)));
  return valid ? { status: 'recorded', kind: value.kind } : { status: 'unavailable', kind: null };
}
function recordedOrigins(row, field, suspect) {
  if (!Object.hasOwn(row, field)) return emptyEvidence('not-recorded');
  if (!Array.isArray(row[field])) return emptyEvidence('unavailable');
  const selected = row[field].slice(0, 128),
    counts = new Map();
  let omitted = row[field].length - selected.length;
  for (const value of selected) {
    if (
      !keys(
        value,
        suspect ? ['kind', 'suspect', 'at', 'source', 'tool', 'excerpt'] : ['kind', 'excerpt'],
        suspect ? ['flaggedOwn'] : [],
      ) ||
      !ORIGIN_KINDS.includes(value.kind) ||
      !privateText(value.excerpt) ||
      (suspect &&
        (typeof value.suspect !== 'boolean' ||
          (value.flaggedOwn !== undefined && typeof value.flaggedOwn !== 'boolean') ||
          !recordedTime(value.at) ||
          !privateText(value.source) ||
          !privateText(value.tool)))
    ) {
      omitted++;
      continue;
    }
    const previous = counts.get(value.kind) ?? {
      kind: value.kind,
      count: 0,
      ...(suspect ? { suspect: 0 } : {}),
    };
    counts.set(value.kind, {
      ...previous,
      count: previous.count + 1,
      ...(suspect ? { suspect: previous.suspect + Number(value.suspect) } : {}),
    });
  }
  return {
    status: omitted ? 'partial' : 'recorded',
    values: ORIGIN_KINDS.flatMap((kind) => (counts.has(kind) ? [counts.get(kind)] : [])),
    omitted,
  };
}
function recordedScan(row, content) {
  if (!content) return null;
  const value = row.scan;
  const valid =
    keys(value, ['verdict', 'score', 'ruleIds'], ['trusted']) &&
    value.verdict === 'suspect' &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 1 &&
    Array.isArray(value.ruleIds) &&
    value.ruleIds.length <= 128 &&
    value.ruleIds.every(privateText) &&
    (!Object.hasOwn(value, 'trusted') || typeof value.trusted === 'boolean');
  return valid
    ? { status: 'recorded', score: value.score, trusted: value.trusted ?? null }
    : { status: 'unavailable', score: null, trusted: null };
}
/** Derive finite evidence only; no source text or custom identifier enters the result. */
export function projectIncidentRecordedEvidence(row, incident, capturedAt, window) {
  return {
    schema: 'stroq-incident-recorded-evidence/1',
    source: 'local',
    capturedAt,
    binding: {
      id: incident.id,
      evidenceSha: incident.evidenceSha,
      sequence: incident.sequence,
      recordedAt: incident.recordedAt,
      kind: incident.kind,
    },
    effect:
      incident.kind === 'policy-deny' ? 'deny' : incident.kind === 'policy-ask' ? 'ask' : null,
    window: { truncated: window.truncated, omitted: window.omitted },
    classes: recordedClasses(row),
    scope: recordedScope(row),
    provenance: recordedOrigins(row, 'provenance', true),
    provenanceIncomplete: recordedOrigins(row, 'provenanceIncomplete', false),
    scan: recordedScan(row, incident.kind === 'content-flag'),
    limitations: [...RECORDED_EVIDENCE_LIMITATIONS],
  };
}

export async function safeDirectory(path, privateMode = false) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    !owned(stat) ||
    (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error('unsafe-location');
  return stat;
}

/** Fixed server-selected names only. Open-handle identity, links and read revision are checked. */
export async function readIncidentFile(
  home,
  parts,
  maxBytes,
  { tail = false, privateMode = false } = {},
) {
  let handle;
  try {
    const root = resolve(home);
    const rootStat = await safeDirectory(root);
    let path = root;
    const parents = [{ path, stat: rootStat }];
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      parents.push({ path, stat: await safeDirectory(path, privateMode) });
    }
    path = join(path, parts.at(-1));
    const before = await lstat(path);
    const safe = (stat) =>
      stat.isFile() &&
      owned(stat) &&
      stat.nlink === 1 &&
      (stat.mode & (privateMode ? 0o077 : 0o022)) === 0;
    if (!safe(before)) return { kind: 'refused' };
    if (!tail && before.size > maxBytes) return { kind: 'limit' };
    handle = await open(path, READ);
    const stat = await handle.stat();
    if (!safe(stat) || !sameFile(before, stat) || (await realpath(path)) !== path)
      return { kind: 'refused' };
    if (!tail && stat.size > maxBytes) return { kind: 'limit' };
    const offset = tail ? Math.max(0, stat.size - maxBytes) : 0;
    const bytes = Buffer.alloc(Math.min(maxBytes, stat.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    const after = await handle.stat();
    if (
      bytesRead !== bytes.length ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      !sameFile(await lstat(path), stat)
    )
      return { kind: 'refused' };
    for (const parent of parents) {
      if (
        !sameFile(
          await safeDirectory(parent.path, privateMode && parent.path !== root),
          parent.stat,
        )
      )
        return { kind: 'refused' };
    }
    let start = 0;
    if (offset > 0) {
      start = bytes.indexOf(10) + 1;
      if (start === 0) return { kind: 'refused' };
    }
    const selected = bytes.subarray(start);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(selected);
    return {
      kind: 'text',
      text,
      bytes: selected,
      truncated: offset > 0,
      revision: hashBytes(selected),
      rootStat,
    };
  } catch (error) {
    return { kind: error?.code === 'ENOENT' ? 'missing' : 'refused' };
  } finally {
    await handle?.close();
  }
}
