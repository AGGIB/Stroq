/** A plain JSON object — not an array, not `null`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A tool's arguments as a record, whatever shape the agent sent them in. MCP
 * arguments arrive as a JSON string officially and as an object in some
 * community builds; Codex sends `tool_input` as a JSON value that is usually an
 * object and sometimes a string. A string that is not a JSON object, and any
 * other non-object value (array, number, boolean), is kept verbatim under `raw`
 * rather than dropped to `{}` — the secret-egress candidate extractor scans
 * `JSON.stringify(toolInput)`, so a value that disappears here is a value that
 * can never be caught leaving through this call. `undefined`/`null` alone become
 * `{}`: there is nothing to keep.
 */
export function toolInputRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return { raw: JSON.stringify(value) };
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // not JSON at all — fall through to the raw string below
  }
  return { raw: value };
}
