import type { TaggedHit } from './agent-change.js';
import { boundedJson, hit } from './agent-kinds.js';
import { settingsOf } from './agent-surface.js';

/**
 * A coarse net under the readers of Claude Code's, Codex's and Gemini's settings: any key whose
 * path holds one of a few words that may say it keeps the agent from things, which a change adds,
 * edits or takes away, fails, though no reader knows the key. An honest change to such a key, a
 * `model` included, fails too. The readers' own findings for the keys they know stay as they are.
 */

/** Words in a key that say it may keep the agent from things, in any letter case. */
const PROTECTIVE = /sandbox|permission|approval|policy|exclude|trust|allow|deny|mode/i;
/** The most values of one settings file walked; past them, the file is not read. */
const MAX_NODES = 20_000;
/** The deepest a key is looked for; a file nested deeper is not read. */
const MAX_DEPTH = 64;

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
): ReadonlyMap<string, string> | undefined {
  const parsed = settingsOf(path, text);
  if (parsed === undefined) return undefined;
  const found = new Map<string, string>();
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
      const at = [...keys, key];
      if (PROTECTIVE.test(key)) found.set(JSON.stringify(at), boundedJson(child, undefined, true));
      else stack.push([at, child]);
    }
  }
  return found;
}

/** A failing finding for each such key `head` adds, edits or takes away against `base`. */
export function protectiveChanges(
  file: string,
  head: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string>,
): TaggedHit[] {
  const out: TaggedHit[] = [];
  const name = (key: string): string => (JSON.parse(key) as string[]).join('.');
  const finding = (key: string, what: keyof typeof SETTING_CHANGE): TaggedHit => ({
    ...hit('agent-permission-bypass', file, 1, name(key), SETTING_CHANGE[what]),
    status: what === 'added' ? 'new' : 'changed',
  });
  for (const [key, value] of base) {
    const now = head.get(key);
    if (now === undefined) out.push(finding(key, 'removed'));
    else if (now !== value) out.push(finding(key, 'changed'));
  }
  for (const key of head.keys()) if (!base.has(key)) out.push(finding(key, 'added'));
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
