import {
  deepEqual,
  isObject,
  parseJsonDocument,
  serializeJson,
} from '../../packages/cli/src/harden/json-doc.js';
import type { JsonObject, JsonValue } from '../../packages/cli/src/harden/types.js';
import { CODEX_EVENT_NAMES } from '../../packages/cli/src/commands/codex-hooks.js';

type MutableObject = Record<string, JsonValue>;
type Template = { key: string; event: string; group: JsonObject | null; handler: JsonValue };
const DIRECT = new Set(['cursor']);
const AGENTS = new Set(['claude-code', 'cursor', 'codex']);
const BLOCKING = new Set([
  'PreToolUse',
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
]);
function invalid(): never {
  throw new Error('invalid-config');
}
function textOf(value: string | Uint8Array | null): string | null {
  if (value === null) return null;
  try {
    if (typeof value !== 'string' && value.byteLength > 1024 * 1024)
      throw new Error('config-too-large');
    const text =
      typeof value === 'string'
        ? value
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('config-too-large');
    return text;
  } catch (error) {
    if (error instanceof Error && error.message === 'config-too-large') throw error;
    invalid();
  }
}
function document(value: string | Uint8Array | null) {
  const text = textOf(value),
    parsed = parseJsonDocument(text ?? '');
  if (!parsed.ok) invalid();
  return { text, parsed };
}
/** Empty/missing input is an empty object; duplicate keys, lossy JSON and invalid UTF-8 are refused. */
export function parseSetupObject(value: string | Uint8Array | null): JsonObject {
  return document(value).parsed.doc;
}
const metadata = (group: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(group).filter(([key]) => key !== 'hooks'));
function validate(value: JsonObject, agent: string) {
  if (value.hooks !== undefined && !isObject(value.hooks)) invalid();
  if (agent === 'cursor' && value.version !== undefined && value.version !== 1) invalid();
  for (const name of ['disableAllHooks', 'hooksDisabled']) {
    if (value[name] !== undefined && typeof value[name] !== 'boolean') invalid();
    if (value[name] === true) throw new Error('hooks-disabled');
  }
  function entries(value: JsonValue, root = false) {
    const items = root && isObject(value) ? [value] : value;
    if (!Array.isArray(items)) invalid();
    for (const entry of items) {
      if (!isObject(entry)) invalid();
      if (DIRECT.has(agent)) {
        if (typeof entry.command !== 'string') invalid();
      } else if (!Array.isArray(entry.hooks) || entry.hooks.some((hook) => !isObject(hook)))
        invalid();
    }
  }
  if (isObject(value.hooks)) Object.values(value.hooks).forEach((value) => entries(value));
  if (agent === 'codex')
    for (const event of CODEX_EVENT_NAMES)
      if (Object.hasOwn(value, event)) entries(value[event]!, true);
}
function templatesOf(expected: JsonObject, agent: string): Template[] {
  const templates: Template[] = [];
  if (!isObject(expected.hooks)) invalid();
  for (const [event, entries] of Object.entries(expected.hooks)) {
    if (!Array.isArray(entries)) invalid();
    entries.forEach((entry: JsonValue, index: number) => {
      if (DIRECT.has(agent))
        templates.push({ key: `${event}:${index}`, event, group: null, handler: entry });
      else {
        if (!isObject(entry) || !Array.isArray(entry.hooks)) invalid();
        entry.hooks.forEach((handler: JsonValue, hi: number) =>
          templates.push({
            key: `${event}:${index}:${hi}`,
            event,
            group: metadata(entry),
            handler,
          }),
        );
      }
    });
  }
  return templates;
}
function match(templates: Template[], event: string, handler: JsonValue, group: JsonObject | null) {
  return templates.find(
    (t) =>
      t.event === event &&
      deepEqual(t.handler, handler) &&
      (t.group === null ? group === null : group !== null && deepEqual(t.group, group)),
  );
}
function visit(
  config: JsonObject,
  agent: string,
  action: (event: string, handler: JsonValue, group: JsonObject | null) => void,
) {
  function eventEntries(event: string, value: JsonValue) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (DIRECT.has(agent)) action(event, entry, null);
      else if (isObject(entry) && Array.isArray(entry.hooks))
        entry.hooks.forEach((handler) => action(event, handler, metadata(entry)));
    }
  }
  if (isObject(config.hooks))
    Object.entries(config.hooks).forEach(([event, value]) => eventEntries(event, value));
  if (agent === 'codex')
    for (const event of CODEX_EVENT_NAMES)
      if (Object.hasOwn(config, event)) eventEntries(event, config[event]!);
}
function hookEvents(templates: Template[], agent: string) {
  return [...new Set(templates.map((t) => t.event))].map((event) => {
    const wanted = templates.find((t) => t.event === event)!;
    if (!isObject(wanted.handler)) invalid();
    const matcher = wanted.group?.matcher ?? wanted.handler.matcher ?? null;
    return {
      event,
      matcher,
      blocking: BLOCKING.has(event),
      failClosed: agent === 'cursor' ? wanted.handler.failClosed === true : null,
      timeoutSeconds: typeof wanted.handler.timeout === 'number' ? wanted.handler.timeout : null,
    };
  });
}

/** Install only missing current templates. Existing exact registrations stay where the host reads them. */
export function transformAgentSetup(
  value: string | Uint8Array | null,
  agent: string,
  expected: unknown,
) {
  if (!AGENTS.has(agent)) throw new Error('unsupported-agent');
  if (!isObject(expected)) invalid();
  const { text, parsed } = document(value);
  validate(parsed.doc, agent);
  validate(expected, agent);
  const templates = templatesOf(expected, agent);
  let preservedHooks = 0,
    remainingLookalikes = 0;
  const lookalike = new RegExp(`(?:^|\\s)hook\\s+${agent}(?:\\s|$)`);
  visit(parsed.doc, agent, (event, handler, group) => {
    const own = match(templates, event, handler, group);
    if (!own) {
      preservedHooks += 1;
      if (
        isObject(handler) &&
        typeof handler.command === 'string' &&
        lookalike.test(handler.command)
      )
        remainingLookalikes += 1;
    }
  });
  const config: MutableObject = structuredClone(parsed.doc),
    seen = new Set<string>();
  let replacedHooks = 0;
  function dedupe(event: string, value: JsonValue): JsonValue | undefined {
    const single = !Array.isArray(value),
      entries = single ? [value] : value;
    let removed = 0;
    function keep(handler: JsonValue, group: JsonObject | null) {
      const own = match(templates, event, handler, group);
      if (!own) return true;
      if (!seen.has(own.key)) {
        seen.add(own.key);
        return true;
      }
      replacedHooks += 1;
      removed += 1;
      return false;
    }
    const retained = entries.flatMap((entry): JsonValue[] => {
      if (DIRECT.has(agent)) return keep(entry, null) ? [entry] : [];
      if (!isObject(entry) || !Array.isArray(entry.hooks)) invalid();
      const handlers = entry.hooks.filter((handler) => keep(handler, metadata(entry)));
      if (handlers.length === entry.hooks.length) return [entry];
      return handlers.length ? [{ ...entry, hooks: handlers }] : [];
    });
    if (!removed) return value;
    return retained.length === 0 ? undefined : single ? retained[0] : retained;
  }
  // Respect the document's existing root order when choosing which exact duplicate to keep.
  for (const key of Object.keys(config)) {
    if (key === 'hooks' && isObject(config.hooks)) {
      const hooks: MutableObject = { ...config.hooks },
        before = replacedHooks;
      for (const [event, entries] of Object.entries(hooks)) {
        const next = dedupe(event, entries);
        if (next === undefined) delete hooks[event];
        else hooks[event] = next;
      }
      if (replacedHooks > before && Object.keys(hooks).length === 0) delete config.hooks;
      else config.hooks = hooks;
    } else if (agent === 'codex' && CODEX_EVENT_NAMES.includes(key)) {
      const next = dedupe(key, config[key]!);
      if (next === undefined) delete config[key];
      else config[key] = next;
    }
  }
  let addedHooks = 0;
  for (const [event, entries] of Object.entries(expected.hooks as JsonObject)) {
    if (!Array.isArray(entries)) invalid();
    const additions = entries.flatMap((entry: JsonValue): JsonValue[] => {
      if (DIRECT.has(agent)) {
        const own = match(templates, event, entry, null)!;
        if (seen.has(own.key)) return [];
        seen.add(own.key);
        addedHooks += 1;
        return [entry];
      }
      if (!isObject(entry) || !Array.isArray(entry.hooks)) invalid();
      const missing = entry.hooks.filter((handler) => {
        const own = match(templates, event, handler, metadata(entry))!;
        if (seen.has(own.key)) return false;
        seen.add(own.key);
        addedHooks += 1;
        return true;
      });
      return missing.length ? [{ ...entry, hooks: missing }] : [];
    });
    if (!additions.length) continue;
    const hooks: MutableObject = isObject(config.hooks) ? { ...config.hooks } : {};
    hooks[event] = [
      ...(Array.isArray(hooks[event]) ? (hooks[event] as JsonValue[]) : []),
      ...additions,
    ];
    config.hooks = hooks;
  }
  if (agent === 'cursor' && config.version === undefined) config.version = expected.version!;
  const candidateText =
    text !== null && deepEqual(config, parsed.doc) ? text : serializeJson(config, parsed.layout);
  if (
    Buffer.byteLength(candidateText, 'utf8') > 1024 * 1024 ||
    [preservedHooks, replacedHooks, addedHooks, remainingLookalikes].some((n) => n > 4096)
  )
    throw new Error('config-too-large');
  return {
    candidateText,
    hookEvents: hookEvents(templates, agent),
    preservedHooks,
    replacedHooks,
    addedHooks,
    remainingLookalikes,
  };
}
