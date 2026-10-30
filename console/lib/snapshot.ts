import type { Agent, ToolCall } from './data';

/** The v1 bridge is observational: it cannot assess current protection or keys. */
export interface LocalSnapshot {
  readonly schema: 'stroq-console/1';
  readonly source: 'local';
  readonly generatedAt: string;
  readonly calls: readonly ToolCall[];
  readonly agents: readonly Agent[];
  readonly keys: readonly [];
  readonly limitations: readonly string[];
}

const SNAPSHOT_KEYS = ['schema', 'source', 'generatedAt', 'calls', 'agents', 'keys', 'limitations'];
const CALL_KEYS = [
  'id',
  'sessionId',
  'decision',
  'label',
  'raw',
  'agent',
  'date',
  'time',
  'rule',
  'reason',
  'evidenceSha',
];
const AGENT_KEYS = ['id', 'name', 'version', 'state', 'checks', 'next'];
const AGENT_NAMES = ['Claude Code', 'Cursor', 'Codex CLI', 'Unknown host'];
const HOSTS: ReadonlyArray<readonly [string, string]> = [
  ['claude-code', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['codex', 'Codex CLI'],
];
const DECISIONS = ['block', 'ask', 'flag', 'allow', 'nj'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
  );
}

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function member(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

function optionalString(row: Record<string, unknown>, key: string, max: number): boolean {
  return !Object.hasOwn(row, key) || boundedString(row[key], max);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function date(value: unknown): value is string {
  return typeof value === 'string' && DATE.test(value) && timestamp(`${value}T00:00:00.000Z`);
}

function call(value: unknown): value is ToolCall {
  if (!closed(value, CALL_KEYS)) return false;
  if (!boundedString(value.id, 128) || !IDENTIFIER.test(value.id)) return false;
  if (!member(value.decision, DECISIONS) || !member(value.agent, AGENT_NAMES)) return false;
  if (!boundedString(value.label, 300) || !boundedString(value.raw, 1024)) return false;
  if (!date(value.date) || typeof value.time !== 'string' || !TIME.test(value.time)) return false;
  if (!optionalString(value, 'rule', 128) || !optionalString(value, 'reason', 1000)) return false;
  if (Object.hasOwn(value, 'evidenceSha')) {
    const journal = /^audit-([1-9]\d*)$/.exec(value.id);
    if (
      typeof value.evidenceSha !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.evidenceSha) ||
      !journal ||
      !Number.isSafeInteger(Number(journal[1]))
    )
      return false;
  }
  // Session names are never returned by the bridge, only its stable pseudonym.
  return (
    !Object.hasOwn(value, 'sessionId') ||
    (typeof value.sessionId === 'string' && /^session-[a-f0-9]{16}$/.test(value.sessionId))
  );
}

function agent(value: unknown): value is Agent {
  if (!closed(value, AGENT_KEYS)) return false;
  if (!HOSTS.some(([id, name]) => value.id === id && value.name === name)) return false;
  if (!boundedString(value.version, 80) || value.state !== 'unver') return false;
  if (!optionalString(value, 'next', 128)) return false;
  const checks = value.checks;
  // v1 reads no installation config, host binary or current policy. Accepting
  // "ok" or a current-proof check here would turn historical evidence into a
  // protection claim the bridge cannot make, even if all four checks say yes.
  return (
    Array.isArray(checks) &&
    checks.length === 4 &&
    checks[0] === 'na' &&
    member(checks[1], ['yes', 'na']) &&
    member(checks[2], ['yes', 'no', 'notyet']) &&
    checks[3] === 'na'
  );
}

function rows<T extends { readonly id: string }>(
  value: unknown,
  max: number,
  validate: (row: unknown) => row is T,
): value is readonly T[] {
  if (!Array.isArray(value) || value.length > max) return false;
  const ids = new Set<string>();
  // for-of visits sparse slots, unlike every(), so a hole cannot pass as a row.
  for (const row of value) {
    if (!validate(row) || ids.has(row.id)) return false;
    ids.add(row.id);
  }
  return true;
}

function valid(value: unknown): value is LocalSnapshot {
  if (
    !closed(value, SNAPSHOT_KEYS) ||
    value.schema !== 'stroq-console/1' ||
    value.source !== 'local'
  )
    return false;
  if (
    !timestamp(value.generatedAt) ||
    !rows(value.calls, 500, call) ||
    !rows(value.agents, 4, agent)
  )
    return false;
  if (!Array.isArray(value.keys) || value.keys.length !== 0) return false;
  if (!Array.isArray(value.limitations) || value.limitations.length > 32) return false;
  for (const limitation of value.limitations) if (!boundedString(limitation, 1000)) return false;
  return true;
}

/** Fail closed as a whole; never let a partly valid snapshot reach React. */
export function validateSnapshot(value: unknown): value is LocalSnapshot {
  try {
    return valid(value);
  } catch {
    return false;
  }
}
