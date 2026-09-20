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
