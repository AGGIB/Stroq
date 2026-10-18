/** A word with its quotes and backslashes taken out. */
export interface ShellWord {
  readonly word: string;
  /** A quote in it was never closed. */
  readonly open: boolean;
}

/** What the quote that opens at `at` holds, and where it closes (-1 if it never does). */
function quoted(token: string, at: number): { piece: string; end: number } {
  const quote = token.charAt(at);
  let piece = '';
  for (let i = at + 1; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (char === quote) return { piece, end: i };
    if (
      quote === '"' &&
      char === '\\' &&
      i + 1 < token.length &&
      '$`"\\'.includes(token.charAt(i + 1))
    ) {
      piece += token.charAt(i + 1);
      i += 1;
      continue;
    }
    piece += char;
  }
  return { piece, end: -1 };
}

/**
 * `token` as the shell reads a word. Outside quotes a backslash takes itself out in front of the
 * character after it (`e\vil` is `evil`) and stays at the end of a word, where it is the mark of
 * a continuation. Single quotes keep what they hold; double quotes keep it too, except that a
 * backslash in them escapes only `$`, a backtick, `"` and itself. A quote that is never closed is
 * left in the word, with the rest of the token after it, and the word is `open`.
 *
 * What the word holds is left as it is, `$` and backticks included: whether a character in it is
 * part of a package's name, or of what comes after the name, is for `readPackageWord` to say.
 */
export function shellWord(token: string): ShellWord {
  let word = '';
  let open = false;
  for (let i = 0; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (char === '\\') {
      word += i + 1 < token.length ? token.charAt(i + 1) : char;
      i += 1;
    } else if (char === "'" || char === '"') {
      const { piece, end } = quoted(token, i);
      if (end === -1) {
        word += token.slice(i);
        open = true;
        break;
      }
      word += piece;
      i = end;
    } else {
      word += char;
    }
  }
  return { word, open };
}
