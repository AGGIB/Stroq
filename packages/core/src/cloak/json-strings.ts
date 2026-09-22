/**
 * Reading and rewriting the string LEAVES of a parsed JSON value.
 *
 * Substituting in the serialised line instead would mean matching against JSON's own
 * escaping — `\"`, `\n`, `é` — where a value's offsets no longer line up with the
 * characters the model will actually read. Walking the parsed value keeps every offset
 * in the decoded string it belongs to, which is the invariant the whole cloak rests on.
 *
 * Object KEYS are deliberately left alone. A key is structure: a server that returns
 * a record keyed by email address would have that key rewritten, and the model's reply
 * would then carry a key the server cannot look up. Values are the payload; keys are
 * the schema. `docs/superpowers/specs/2026-09-21-mcp-cloak.md` records this as a
 * stated limit rather than an oversight.
 */

/**
 * How deep the walk goes. A parsed JSON value from the wire is attacker-shaped, and an
 * unbounded recursion on a 100k-deep nesting is a stack overflow inside the proxy —
 * which is a crashed firewall. Anything past this contributes no strings and is copied
 * through unchanged.
 */
export const MAX_JSON_DEPTH = 64;

export function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > MAX_JSON_DEPTH) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      collectStrings(item, depth + 1),
    );
  }
  return [];
}

/**
 * The same walk, but keeping the key each leaf sat under.
 *
 * An array element inherits the array's own key, because `{"attendees":["Peter"]}`
 * labels the element just as plainly as `{"attendee":"Peter"}` does. A top-level
 * string has no key and gets an empty set rather than being dropped.
 *
 * The result is text -> keys rather than a list, because the cloak rewrites by value:
 * the same string under `first_name` and under `note` must be replaced in both, so
 * detection has to see every key it appeared under at once.
 */
export function collectKeyedStrings(
  value: unknown,
  key: string | null = null,
  into: Map<string, Set<string>> = new Map(),
  depth = 0,
): Map<string, Set<string>> {
  if (depth > MAX_JSON_DEPTH) return into;
  if (typeof value === 'string') {
    const keys = into.get(value) ?? new Set<string>();
    if (key !== null) keys.add(key);
    into.set(value, keys);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectKeyedStrings(item, key, into, depth + 1);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
      collectKeyedStrings(item, childKey, into, depth + 1);
    }
  }
  return into;
}

/** The same walk, returning a new value with every string leaf passed through `fn`. */
export function mapStrings(value: unknown, fn: (text: string) => string, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return value;
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        mapStrings(item, fn, depth + 1),
      ]),
    );
  }
  return value;
}
