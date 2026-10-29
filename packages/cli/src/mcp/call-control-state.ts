import { createHash } from 'node:crypto';
import { parseStrictJson } from '../../../core/src/scope/strict-json.js';
import { stateMac } from '../state-mac.js';
import {
  callControlError,
  callControlSha,
  callControlUuid,
  MCP_CALL_CONTROL_LIMITS as LIMIT,
  type McpCallControlCurrent,
  type McpCallControlDecision,
  type McpCallControlEvent,
  type McpCallControlSnapshot,
} from './call-control-types.js';

const SCHEMA = 'stroq-mcp-call-control-native-state/1' as const;
export const callControlDigest = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const actions = ['configure-paused', 'pause', 'resume', 'rebind-paused'];
function boundedJson(value: unknown): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 16_384 || depth > 16) callControlError('mcp-call-control-limit');
    if (v !== null && typeof v === 'object') {
      for (const child of Object.values(v)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
export const missingCallControlState = (): McpCallControlSnapshot => ({
  schema: SCHEMA,
  history: 'missing',
  revision: null,
  homeBinding: null,
  events: [],
  controls: [],
});

function validateEvent(v: unknown): McpCallControlEvent {
  if (
    !record(v) ||
    !exact(v, ['id', 'controlId', 'previousEventId', 'action', 'invocationSha256', 'at']) ||
    !callControlUuid(v.id) ||
    !callControlUuid(v.controlId) ||
    (v.previousEventId !== null && !callControlUuid(v.previousEventId)) ||
    !actions.includes(String(v.action)) ||
    !callControlSha(v.invocationSha256) ||
    !timestamp(v.at)
  )
    return callControlError('mcp-call-control-invalid');
  return {
    id: v.id,
    controlId: v.controlId,
    previousEventId: v.previousEventId as string | null,
    action: v.action as McpCallControlEvent['action'],
    invocationSha256: v.invocationSha256,
    at: v.at,
  };
}

function reduceEvents(events: readonly McpCallControlEvent[]): McpCallControlCurrent[] {
  if (events.length > LIMIT.events) callControlError('mcp-call-control-limit');
  const seen = new Set<string>();
  const currents = new Map<string, McpCallControlCurrent>();
  let previousTime = '';
  for (const e of events) {
    const current = currents.get(e.controlId);
    if (seen.has(e.id) || e.at < previousTime || e.previousEventId !== (current?.eventId ?? null))
      callControlError('mcp-call-control-invalid');
    if (e.action === 'configure-paused' ? !!current : !current)
      callControlError('mcp-call-control-invalid');
    if (current) {
      if (
        e.action === 'rebind-paused'
          ? e.invocationSha256 === current.invocationSha256
          : e.invocationSha256 !== current.invocationSha256
      )
        callControlError('mcp-call-control-invalid');
      if (
        (e.action === 'pause' && current.mode === 'paused') ||
        (e.action === 'resume' && current.mode === 'enabled')
      )
        callControlError('mcp-call-control-invalid');
    }
    currents.set(e.controlId, {
      controlId: e.controlId,
      invocationSha256: e.invocationSha256,
      mode: e.action === 'resume' ? 'enabled' : 'paused',
      eventId: e.id,
      at: e.at,
    });
    if (currents.size > LIMIT.controls) callControlError('mcp-call-control-limit');
    seen.add(e.id);
    previousTime = e.at;
  }
  return [...currents.values()].sort((a, b) => a.controlId.localeCompare(b.controlId));
}

/**
 * With a key, the integrity field is an HMAC under the home's state key (`state-mac.ts`), so a history
 * rewritten by a process that does not hold the key no longer parses. Without one it is a plain digest,
 * which only catches accidents; the files layer always passes the key.
 *
 * It does not stop a rollback: a writer that kept an older history this home signed (from before a
 * pause, say) can put it back, and it parses. The history only grows, so its event count, inside the
 * signed body, is its sequence: a running connection refuses a history shorter than, or no longer
 * starting with, the one it has already accepted (`call-control-guard.ts`). A connection that starts
 * after the old history was put back has nothing to compare it with and accepts it.
 */
export function encodeCallControlState(
  events: readonly McpCallControlEvent[],
  homeBinding: string,
  key: Buffer | null = null,
): Buffer {
  if (!callControlSha(homeBinding)) callControlError('mcp-call-control-invalid');
  const validated = events.map(validateEvent);
  const body = {
    schema: SCHEMA,
    homeBinding,
    events: validated,
    controls: reduceEvents(validated),
  };
  const bytes = Buffer.from(
    JSON.stringify({
      ...body,
      sha256:
        key === null
          ? callControlDigest(JSON.stringify(body))
          : stateMac(key, 'mcp-call-control-history', JSON.stringify(body)),
    }),
  );
  if (bytes.length > LIMIT.liveBytes) callControlError('mcp-call-control-limit');
  return bytes;
}

export function parseCallControlState(
  bytes: Buffer,
  homeBinding: string,
  key: Buffer | null = null,
): McpCallControlSnapshot {
  if (bytes.length > LIMIT.liveBytes) callControlError('mcp-call-control-limit');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return callControlError('mcp-call-control-invalid');
  }
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !record(parsed.value)) return callControlError('mcp-call-control-invalid');
  boundedJson(parsed.value);
  const v = parsed.value;
  if (
    !exact(v, ['schema', 'homeBinding', 'events', 'controls', 'sha256']) ||
    v.schema !== SCHEMA ||
    !callControlSha(v.homeBinding) ||
    !callControlSha(v.sha256) ||
    !Array.isArray(v.events) ||
    !Array.isArray(v.controls)
  )
    return callControlError('mcp-call-control-invalid');
  if (v.homeBinding !== homeBinding) callControlError('mcp-call-control-unavailable');
  const events = v.events.map(validateEvent);
  // Re-encoding under the same key and comparing bytes checks the integrity field as well.
  const canonical = encodeCallControlState(events, homeBinding, key);
  if (!bytes.equals(canonical)) callControlError('mcp-call-control-invalid');
  return {
    schema: SCHEMA,
    history: 'ready',
    revision: callControlDigest(bytes),
    homeBinding,
    events,
    controls: reduceEvents(events),
  };
}

export function nextCallControlEvent(
  state: McpCallControlSnapshot,
  input: McpCallControlDecision,
  now: Date,
): McpCallControlEvent {
  if (
    !record(input) ||
    !exact(input, [
      'controlId',
      'invocationSha256',
      'action',
      'operationId',
      'expectedRevision',
      'expectedEventId',
    ]) ||
    !callControlUuid(input.controlId) ||
    !callControlUuid(input.operationId) ||
    !callControlSha(input.invocationSha256) ||
    !actions.includes(input.action) ||
    (input.expectedRevision !== null && !callControlSha(input.expectedRevision)) ||
    (input.expectedEventId !== null && !callControlUuid(input.expectedEventId))
  )
    return callControlError('mcp-call-control-invalid');
  const current = state.controls.find((c) => c.controlId === input.controlId);
  if (
    input.expectedRevision !== state.revision ||
    input.expectedEventId !== (current?.eventId ?? null) ||
    state.events.some((e) => e.id === input.operationId)
  )
    callControlError('mcp-call-control-stale');
  if (input.action === 'configure-paused' ? !!current : !current)
    callControlError('mcp-call-control-stale');
  if (
    current &&
    ((input.action === 'resume' &&
      (current.mode !== 'paused' || current.invocationSha256 !== input.invocationSha256)) ||
      (input.action === 'pause' && current.mode === 'paused') ||
      (input.action === 'rebind-paused' && current.invocationSha256 === input.invocationSha256))
  )
    callControlError('mcp-call-control-stale');
  let at: string;
  try {
    at = now.toISOString();
  } catch {
    return callControlError('mcp-call-control-invalid');
  }
  if (!timestamp(at)) callControlError('mcp-call-control-invalid');
  if (state.events.length && at < state.events[state.events.length - 1]!.at)
    callControlError('mcp-call-control-stale');
  // Each enabled connection keeps one event for a later stronger Pause. Setup,
  // rebind of a paused slot and Resume cannot spend another connection's reserve.
  // Historical ledgers remain readable. Emergency Pause can improve a historical
  // reserve deficit, but it still cannot exceed the hard event cap.
  const enabledAfter =
    state.controls.filter(
      (control) => control.controlId !== input.controlId && control.mode === 'enabled',
    ).length + Number(input.action === 'resume');
  const remaining = LIMIT.events - state.events.length - 1;
  if (remaining < 0 || (input.action !== 'pause' && remaining < enabledAfter))
    callControlError('mcp-call-control-limit');
  return {
    id: input.operationId,
    controlId: input.controlId,
    previousEventId: current?.eventId ?? null,
    action: input.action,
    invocationSha256: input.action === 'pause' ? current!.invocationSha256 : input.invocationSha256,
    at,
  };
}
