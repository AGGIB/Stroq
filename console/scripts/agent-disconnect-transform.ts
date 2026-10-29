import {
  deepEqual,
  isObject,
  parseJsonDocument,
  serializeJson,
} from '../../packages/cli/src/harden/json-doc.js';
import type { JsonObject, JsonValue } from '../../packages/cli/src/harden/types.js';

const MAX_BYTES = 1024 * 1024;
const DIRECT = new Set(['cursor']);
const AGENTS = new Set(['claude-code', 'cursor', 'codex']);
function fail(): never {
  throw new Error('invalid-config');
}
function document(text: string) {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('config-too-large');
  const parsed = parseJsonDocument(text);
  if (!parsed.ok) fail();
  return parsed;
}
function metadata(group: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(group).filter(([key]) => key !== 'hooks'));
}

/** Unknown events and altered handlers remain present; suffix matching only counts warnings. */
export function transformAgentDisconnect(text: string | null, agent: string, expected: unknown) {
  if (!AGENTS.has(agent)) throw new Error('unsupported-agent');
  if (text === null)
    return {
      candidateText: null,
      removedHooks: 0,
      preservedHooks: 0,
      remainingLookalikes: 0,
      events: [],
      reformatted: false,
    };
  const parsed = document(text);
  const config: { [key: string]: JsonValue } = structuredClone(parsed.doc);
  if (config.hooks !== undefined && !isObject(config.hooks)) fail();
  if (!isObject(expected) || !isObject(expected.hooks)) fail();
  const expectedHooks = expected.hooks;
  const hooks: { [key: string]: JsonValue } | undefined = isObject(config.hooks)
    ? { ...config.hooks }
    : undefined;
  if (hooks) config.hooks = hooks;
  const events = new Map<string, number>();
  const removeEvent = (value: JsonValue, templates: JsonValue): JsonValue | undefined => {
    if (!Array.isArray(templates)) fail();
    const single = agent === 'codex' && isObject(value);
    const entries = Array.isArray(value) ? value : single ? [value] : null;
    if (entries === null) return value;
    let removed = 0;
    const kept = entries.flatMap((entry): JsonValue[] => {
      if (DIRECT.has(agent)) {
        if (templates.some((template) => deepEqual(entry, template))) {
          removed += 1;
          return [];
        }
        return [entry];
      }
      if (!isObject(entry) || !Array.isArray(entry.hooks)) return [entry];
      const template = templates.find(
        (candidate) =>
          isObject(candidate) &&
          Array.isArray(candidate.hooks) &&
          deepEqual(metadata(entry), metadata(candidate)),
      );
      if (!isObject(template) || !Array.isArray(template.hooks)) return [entry];
      const ownHooks = template.hooks;
      const remaining = entry.hooks.filter(
        (handler) => !ownHooks.some((own) => deepEqual(handler, own)),
      );
      const count = entry.hooks.length - remaining.length;
      removed += count;
      return count === 0 ? [entry] : remaining.length === 0 ? [] : [{ ...entry, hooks: remaining }];
    });
    events.set(currentEvent, (events.get(currentEvent) ?? 0) + removed);
    if (removed === 0) return value;
    return kept.length === 0 ? undefined : single ? kept[0] : kept;
  };
  // The event name is always taken from the bundled current template, never from private data.
  let currentEvent = '';
  for (const [event, templates] of Object.entries(expectedHooks)) {
    currentEvent = event;
    if (hooks && Object.hasOwn(hooks, event)) {
      const next = removeEvent(hooks[event]!, templates);
      if (next === undefined) delete hooks[event];
      else hooks[event] = next;
    }
    if (agent === 'codex' && Object.hasOwn(config, event)) {
      const next = removeEvent(config[event]!, templates);
      if (next === undefined) delete config[event];
      else config[event] = next;
    }
  }
  const removedHooks = [...events.values()].reduce((sum, count) => sum + count, 0);
  if (removedHooks > 0 && isObject(config.hooks) && Object.keys(config.hooks).length === 0)
    delete config.hooks;
  let preservedHooks = 0,
    remainingLookalikes = 0;
  const lookalike = new RegExp(`(?:^|\\s)hook ${agent}(?: \\S+)?$`);
  function count(value: JsonValue, depth = 0) {
    if (depth > 16) fail();
    if (Array.isArray(value)) {
      value.forEach((entry) => count(entry, depth + 1));
      return;
    }
    if (!isObject(value)) return;
    if (typeof value.command === 'string') {
      preservedHooks += 1;
      if (lookalike.test(value.command)) remainingLookalikes += 1;
    }
    if (Array.isArray(value.hooks)) count(value.hooks, depth + 1);
  }
  if (isObject(config.hooks)) Object.values(config.hooks).forEach((value) => count(value));
  if (agent === 'codex') {
    // All plausible root event maps are counted without normalizing or moving them.
    for (const [event, value] of Object.entries(config))
      if (/^[A-Z][A-Za-z0-9]*$/.test(event)) count(value);
  }
  if ([removedHooks, preservedHooks, remainingLookalikes].some((n) => n > 4096))
    throw new Error('config-too-large');
  return {
    candidateText: removedHooks === 0 ? text : serializeJson(config, parsed.layout),
    removedHooks,
    preservedHooks,
    remainingLookalikes,
    events: [...events]
      .filter(([, removed]) => removed > 0)
      .map(([event, removed]) => ({ event, removed })),
    reformatted: removedHooks > 0 && !parsed.roundTrips,
  };
}
