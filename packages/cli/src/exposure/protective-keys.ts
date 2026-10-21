import { settle, type TaggedHit } from './agent-change.js';
import { boundedJson, hit, isProtection, type AgentHit } from './agent-kinds.js';
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
 * A rule Claude Code reads in a deny or ask list: `Tool`, `Tool(...)` with no bracket inside, or
 * `mcp__server` and `mcp__server__tool`. A malformed one can make it refuse the whole settings file
 * or permissions block, and every rule there with it.
 */
const CLAUDE_RULE =
  /^(?:[A-Za-z][A-Za-z0-9_]*(?:\([^()\n]*\))?|mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?)$/;
/** A tool Gemini reads in an exclude list: a name, with `(...)` after it or not. */
const GEMINI_TOOL = /^[A-Za-z][A-Za-z0-9_.-]*(?:\([^()\n]*\))?$/;
/** The longest element a list may gain. */
const MAX_RULE = 512;

/**
 * Lists whose growth only adds protection, by their path of keys (`*` for any one key), each with
 * what an element it gains must be: a deny or ask rule, a tool kept out. One may grow without the
 * net failing; see `onlyGrows`.
 */
const GROW_ONLY: readonly (readonly [path: readonly string[], rule: RegExp])[] = [
  [['permissions', 'deny'], CLAUDE_RULE],
  [['permissions', 'ask'], CLAUDE_RULE],
  [['tools', 'exclude'], GEMINI_TOOL],
  [['excludeTools'], GEMINI_TOOL],
  [['mcpServers', '*', 'excludeTools'], GEMINI_TOOL],
];
const fits = (path: readonly string[], pattern: readonly string[], whole: boolean): boolean =>
  (whole ? path.length === pattern.length : path.length < pattern.length) &&
  path.every((key, i) => pattern[i] === '*' || pattern[i] === key);

/**
 * Whether `now` keeps every element of `before` and gains only elements `rule` reads, each at most
 * `MAX_RULE` characters, and none a second copy of one it has.
 */
export function onlyGains(
  before: readonly string[],
  now: readonly string[],
  rule: RegExp,
): boolean {
  const count = (list: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const x of list) counts.set(x, (counts.get(x) ?? 0) + 1);
    return counts;
  };
  const was = count(before);
  const is = count(now);
  for (const x of was.keys()) if (!is.has(x)) return false;
  for (const [x, n] of is) {
    const had = was.get(x) ?? 0;
    if (n <= had) continue;
    if (had > 0 || n - had > 1) return false;
    if (x.length > MAX_RULE || !rule.test(x)) return false;
  }
  return true;
}
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
 * `now` only gains well-formed elements (see `onlyGains`); above one, both are objects (`before` may be
 * missing) and each of their keys only adds to the other in the same sense; anywhere else, the
 * two are the same. Proof for a mild outcome, so anything else is not.
 */
function onlyGrows(path: readonly string[], before: unknown, now: unknown): boolean {
  const list = GROW_ONLY.find(([p]) => fits(path, p, true));
  if (list !== undefined) {
    const was = before ?? [];
    if (!isStrings(was) || !isStrings(now)) return false;
    return onlyGains(was, now, list[1]);
  }
  if (GROW_ONLY.some(([p]) => fits(path, p, false)) && isObject(now)) {
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

/** The readers' findings for a list whose growth only adds protection, by name, with its rule. */
const GROWING_FINDINGS: ReadonlyMap<string, RegExp> = new Map([
  ['permissions.ask', CLAUDE_RULE],
  ['permissions.deny', CLAUDE_RULE],
  ['tools.exclude', GEMINI_TOOL],
  ['excludeTools', GEMINI_TOOL],
]);

/** A finding's value as a list of plain strings, or undefined when it is not one, or was cut. */
function stringList(value: string): string[] | undefined {
  try {
    const list: unknown = JSON.parse(value);
    return isStrings(list) ? list : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `tagged` (the readers' findings of `head`, tagged against `base` in order) with each new or
 * changed finding for a list of `GROWING_FINDINGS` that only grew put back as there before: the
 * base had none, or every element it had is still there, all plain strings, and each one gained
 * is well formed (see `onlyGains`). Anything else, a value cut for its length included, stays as
 * it was.
 */
export function growthOnly(
  head: readonly AgentHit[],
  base: readonly AgentHit[],
  tagged: readonly TaggedHit[],
): TaggedHit[] {
  return tagged.map((t, i) => {
    const h = head[i];
    if (h === undefined || t.status === 'present' || !isProtection(h)) return t;
    const rule = GROWING_FINDINGS.get(h.name);
    if (rule === undefined) return t;
    const now = stringList(h.value);
    const was = base.find((b) => b.file === h.file && b.name === h.name && isProtection(b));
    const before = was === undefined ? [] : stringList(was.value);
    if (now === undefined || before === undefined) return t;
    return onlyGains(before, now, rule) ? settle(h, 'present') : t;
  });
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
