/**
 * JSON with comments, as VS Code and the agents that copy its format read it.
 *
 * `tasks.json`, `settings.json`, `devcontainer.json` and `.code-workspace` files take `//` and
 * `/* *\/` comments and trailing commas, and a strict `JSON.parse` turns one comment into "no
 * file at all": the keyv worm's folder-open task would hide behind a single `// setup` line.
 * The other agent configs are plain JSON to their hosts, and reading them the lenient way can
 * only find more, never less.
 *
 * One pass that knows where a string starts and ends, never a pattern over the whole text, so
 * the work is linear in its length whatever the text is.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const STAR = 0x2a;
const COMMA = 0x2c;
const NEWLINE = 0x0a;
const BYTE_ORDER_MARK = 0xfeff;

const isJsonSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === NEWLINE || code === 0x0d;

/** Where a line comment that starts at `start` ends: at its newline, which is kept. */
function lineCommentEnd(text: string, start: number): number {
  const end = text.indexOf('\n', start);
  return end === -1 ? text.length : end;
}

/** Where a block comment that starts at `start` ends, past its `*\/`; -1 when it never does. */
function blockCommentEnd(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? -1 : end + 2;
}

/** Whether the comma at `at` is followed by nothing but blanks and comments before `}` or `]`. */
function isTrailingComma(chars: readonly string[], at: number): boolean {
  for (let j = at + 1; j < chars.length; j += 1) {
    const code = (chars[j] as string).charCodeAt(0);
    if (isJsonSpace(code)) continue;
    return code === 0x7d || code === 0x5d;
  }
  return false;
}

/**
 * `text` with its comments, its trailing commas and a leading byte order mark turned into
 * spaces. Every newline stays where it was, so an offset in the result is the same offset in
 * the file. A block comment that is never closed is left as it is, and the parse then fails.
 */
export function stripJsonc(text: string): string {
  const chars = text.split('');
  let inString = false;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
  };
  if (text.charCodeAt(0) === BYTE_ORDER_MARK) chars[0] = ' ';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === BACKSLASH) i += 1;
      else if (code === QUOTE) inString = false;
      continue;
    }
    if (code === QUOTE) {
      inString = true;
    } else if (code === SLASH && text.charCodeAt(i + 1) === SLASH) {
      const end = lineCommentEnd(text, i);
      blank(i, end);
      i = end - 1;
    } else if (code === SLASH && text.charCodeAt(i + 1) === STAR) {
      const end = blockCommentEnd(text, i);
      if (end === -1) return chars.join('');
      blank(i, end);
      i = end - 1;
    }
  }
  // Trailing commas are found after the comments are gone, so `1, // c\n}` is one too.
  inString = false;
  for (let i = 0; i < chars.length; i += 1) {
    const code = (chars[i] as string).charCodeAt(0);
    if (inString) {
      if (code === BACKSLASH) i += 1;
      else if (code === QUOTE) inString = false;
    } else if (code === QUOTE) {
      inString = true;
    } else if (code === COMMA && isTrailingComma(chars, i)) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

/** The value in `text` read as JSON with comments, or undefined when it is not one. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text)) as unknown;
  } catch {
    // Not JSON, or nested deeper than the parser walks: either way there is no value to read.
    return undefined;
  }
}

/**
 * The offsets of the newlines of the last text asked about. A file's hits are located one
 * after another in the same text, so it is counted once, not once per hit.
 */
let newlines: { readonly text: string; readonly at: readonly number[] } | undefined;

function newlinesOf(text: string): readonly number[] {
  if (newlines?.text !== text) {
    const at: number[] = [];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) at.push(i);
    newlines = { text, at };
  }
  return newlines.at;
}

/** The line (from 1) that the character at `offset` is on. */
export function lineAt(text: string, offset: number): number {
  const at = newlinesOf(text);
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((at[mid] as number) < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * The line of the last of `needles` found in `text`, each one looked for after the one before
 * it: `["\"hooks\"", "\"SessionStart\"", "\"node x.mjs\""]` finds the command under that event.
 * A needle that is not there is skipped. 1 when none is found, so a report always has a line.
 */
export function lineOf(text: string, needles: readonly string[]): number {
  let at = -1;
  let from = 0;
  for (const needle of needles) {
    if (needle === '') continue;
    const found = text.indexOf(needle, from);
    if (found === -1) continue;
    at = found;
    from = found + needle.length;
  }
  return at === -1 ? 1 : lineAt(text, at);
}
