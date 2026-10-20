import type { TaggedHit } from './agent-change.js';
import { boundedJson, hit } from './agent-kinds.js';
import { settingsOf } from './agent-surface.js';

/**
 * A coarse net under the readers of Claude Code's, Codex's and Gemini's settings: any key whose
 * path holds one of a few words that may say it keeps the agent from things, which a change adds,
 * edits or takes away, fails, though no reader knows the key. An honest change to such a key, a
 * `model_provider` included, fails too; only the top-level `model` with a plain name is left out.
 * The readers' own findings for the keys they know stay as they are.
 */

/** Words in a key that say it may keep the agent from things, in any letter case. */
const PROTECTIVE = /sandbox|permission|approval|policy|exclude|trust|allow|deny|mode/i;
/** The most values of one settings file walked; past them, the file is not read. */
const MAX_NODES = 20_000;
/** The deepest a key is looked for; a file nested deeper is not read. */
const MAX_DEPTH = 64;

/**
 * The one key left out: the top-level `model` holding a plain name, which picks a model and can
 * send nothing elsewhere. A provider, a table, a `model` deeper in, or a name with an address in
 * it is not this.
 */
const isModelName = (key: string, value: unknown): boolean =>
  key === 'model' && typeof value === 'string' && !value.includes('://');

/**
 * Lists whose growth only adds protection, by their path of keys (`*` for any one key): a deny or
 * ask rule, a tool kept out. One may grow without the net failing; see `onlyGrows`.
 */
const GROW_ONLY: readonly (readonly string[])[] = [
  ['permissions', 'deny'],
  ['permissions', 'ask'],
  ['tools', 'exclude'],
  ['excludeTools'],
  ['mcpServers', '*', 'excludeTools'],
];
const fits = (path: readonly string[], pattern: readonly string[], whole: boolean): boolean =>
  (whole ? path.length === pattern.length : path.length < pattern.length) &&
  path.every((key, i) => pattern[i] === '*' || pattern[i] === key);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ownOf = (o: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(o, key) ? o[key] : undefined;
const same = (a: unknown, b: unknown): boolean =>
  a !== undefined &&
  b !== undefined &&
  boundedJson(a, undefined, true) === boundedJson(b, undefined, true);

/**
 * Whether `now` only adds to `before` at `path`, so that nothing that kept the agent from things
 * is gone: at a list of `GROW_ONLY`, both are lists of plain strings (`before` may be missing) and
 * every element of `before` is still in `now`; above one, both are objects (`before` may be
 * missing) and each of their keys only adds to the other in the same sense; anywhere else, the
 * two are the same. Proof for a mild outcome, so anything else is not.
 */
function onlyGrows(path: readonly string[], before: unknown, now: unknown): boolean {
  if (GROW_ONLY.some((p) => fits(path, p, true))) {
    const was = before ?? [];
    if (!isStrings(was) || !isStrings(now)) return false;
    const kept = new Set(now);
    return was.every((x) => kept.has(x));
  }
  if (GROW_ONLY.some((p) => fits(path, p, false)) && isObject(now)) {
    const was = before ?? {};
    if (!isObject(was)) return false;
    const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
    return [...keys].every((k) => onlyGrows([...path, k], ownOf(was, k), ownOf(now, k)));
  }
  return same(before, now);
}

/** A protective key's value: as text, compared, and as read, for `onlyGrows`. */
export interface ProtectiveValue {
  readonly text: string;
  readonly value: unknown;
}

/** What a finding for such a key says happened to it. */
export const SETTING_CHANGE = {
  added: '(a protective setting added)',
  changed: '(a protective setting changed)',
  removed: '(a protective setting taken away)',
} as const;

/**
 * The keys of a settings file whose path holds one of those words, the outermost on each path,
 * each with its value as text, by the path of keys written as JSON, so a key with a dot in it is
 * one key. Undefined when the file does not parse, or is bigger or deeper than this walks.
 */
export function protectiveKeys(
  path: string,
  text: string,
): ReadonlyMap<string, ProtectiveValue> | undefined {
  const parsed = settingsOf(path, text);
  if (parsed === undefined) return undefined;
  const found = new Map<string, ProtectiveValue>();
  const stack: (readonly [keys: readonly string[], value: unknown])[] = [[[], parsed.doc]];
  let left = MAX_NODES;
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [keys, value] = next;
    if (typeof value !== 'object' || value === null) continue;
    if (keys.length >= MAX_DEPTH) return undefined;
    const children: [string, unknown][] = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);
    left -= children.length;
    if (left < 0) return undefined;
    for (const [key, child] of children) {
      if (keys.length === 0 && isModelName(key, child)) continue;
      const at = [...keys, key];
      if (PROTECTIVE.test(key))
        found.set(JSON.stringify(at), { text: boundedJson(child, undefined, true), value: child });
      else stack.push([at, child]);
    }
  }
  return found;
}

/**
 * A failing finding for each such key `head` adds, edits or takes away against `base`, but one a
 * change only adds protection to (see `onlyGrows`).
 */
export function protectiveChanges(
  file: string,
  head: ReadonlyMap<string, ProtectiveValue>,
  base: ReadonlyMap<string, ProtectiveValue>,
): TaggedHit[] {
  const out: TaggedHit[] = [];
  const name = (key: string): string => (JSON.parse(key) as string[]).join('.');
  const finding = (key: string, what: keyof typeof SETTING_CHANGE): TaggedHit => ({
    ...hit('agent-permission-bypass', file, 1, name(key), SETTING_CHANGE[what]),
    status: what === 'added' ? 'new' : 'changed',
  });
  const grows = (key: string, before: unknown, now: unknown): boolean =>
    onlyGrows(JSON.parse(key) as string[], before, now);
  for (const [key, was] of base) {
    const now = head.get(key);
    if (now === undefined) out.push(finding(key, 'removed'));
    else if (now.text !== was.text && !grows(key, was.value, now.value))
      out.push(finding(key, 'changed'));
  }
  for (const [key, now] of head)
    if (!base.has(key) && !grows(key, undefined, now.value)) out.push(finding(key, 'added'));
  return out;
}

/** A failing finding that what kept the agent from things in `path` before the change is not known. */
export const protectionsUnknown = (path: string, why: string): TaggedHit => ({
  ...hit(
    'unreadable-config',
    path,
    1,
    'protections',
    `whether the change took away a setting that kept the agent from things was not worked out: ${why}`,
  ),
  status: 'changed',
});
