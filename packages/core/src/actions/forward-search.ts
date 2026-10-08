/**
 * Searches that only move forward, for the readers that look for the closing quote or the next
 * delimiter from every match: asked afresh, a command with many matches and no answer re-read the
 * rest of itself from each one.
 */

/** `text.indexOf(char, position)` for positions that only move forward, remembering the answer until a position passes it. */
export function forwardIndexOf(text: string, char: string): (position: number) => number {
  let from = Infinity;
  let at = -1;
  return (position) => {
    if (position < from || (at !== -1 && at < position)) {
      from = position;
      at = text.indexOf(char, position);
    }
    return at;
  };
}

/** `forwardIndexOf` for the first of several characters. */
export function forwardSearch(text: string, chars: RegExp): (position: number) => number {
  const pattern = new RegExp(chars.source, 'g');
  let from = Infinity;
  let at = -1;
  return (position) => {
    if (position < from || (at !== -1 && at < position)) {
      from = position;
      pattern.lastIndex = position;
      at = pattern.exec(text)?.index ?? -1;
    }
    return at;
  };
}

/**
 * The index of the first `"` at or after a position that a backslash does not escape, with
 * the answer remembered for positions that only move forward (see `forwardIndexOf`). A match
 * begins right after an opening quote, never in the middle of a run of backslashes, so a
 * quote's being escaped does not depend on where the search began.
 */
export function forwardUnescapedQuote(text: string): (position: number) => number {
  let from = Infinity;
  let at = -1;
  return (position) => {
    if (position < from || (at !== -1 && at < position)) {
      from = position;
      at = -1;
      for (let i = position; i < text.length; i += 1) {
        const ch = text.charAt(i);
        if (ch === '\\') i += 1;
        else if (ch === '"') {
          at = i;
          break;
        }
      }
    }
    return at;
  };
}

/** A double-quoted body as the shell hands it on: `\"`, `\$`, a backtick and `\\` lose the backslash. */
export const unescapeDouble = (body: string): string => body.replace(/\\(["$`\\])/g, '$1');
