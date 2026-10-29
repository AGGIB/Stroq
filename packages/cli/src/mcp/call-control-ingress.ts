import { jsonTokens } from '../harden/json-tokens.js';
import { MAX_LINE_CHARS, type SplitLine } from './framing.js';
import { STRICT_MAX_DEPTH } from './strict-limits.js';

/** Preserve wire bytes only when different JSON duplicate-key conventions cannot change the call. */
export function unambiguousControlledClientLine(line: SplitLine, parsed: unknown): boolean {
  if (
    line.oversize ||
    line.text.length > MAX_LINE_CHARS ||
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object'
  )
    return false;
  const keys: (Set<string> | null)[] = [];
  for (const token of jsonTokens(line.text)) {
    if (token.kind === 'open') {
      if (keys.length >= STRICT_MAX_DEPTH) return false;
      keys.push(token.object ? new Set() : null);
    } else if (token.kind === 'close') keys.pop();
    else if (token.kind === 'key') {
      const current = keys[keys.length - 1];
      if (!current || current.has(token.value)) return false;
      current.add(token.value);
    }
  }
  return true;
}
