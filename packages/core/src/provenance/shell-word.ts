/** A word with its quotes and backslashes taken out. */
export interface ShellWord {
  readonly word: string;
  /** A quote in it was never closed. */
  readonly open: boolean;
  /**
   * For each character of `word`: it stood inside quotes or after a backslash, so it is text and
   * not shell syntax. A `)`, `&`, `;` or `|` that is quoted or escaped ends nothing.
   */
  readonly literal: readonly boolean[];
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
 * part of a package's name, or of what comes after the name, is for `readPackageWord` to say, and
 * `literal` says which characters are text because a quote or a backslash made them so.
 */
export function shellWord(token: string): ShellWord {
  let word = '';
  const literal: boolean[] = [];
  let open = false;
  const add = (text: string, isLiteral: boolean): void => {
    word += text;
    for (let k = 0; k < text.length; k += 1) literal.push(isLiteral);
  };
  for (let i = 0; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (char === '\\') {
      if (i + 1 < token.length) add(token.charAt(i + 1), true);
      else add(char, false);
      i += 1;
    } else if (char === "'" || char === '"') {
      const { piece, end } = quoted(token, i);
      if (end === -1) {
        add(token.slice(i), true);
        open = true;
        break;
      }
      add(piece, true);
      i = end;
    } else {
      add(char, false);
    }
  }
  return { word, open, literal };
}
