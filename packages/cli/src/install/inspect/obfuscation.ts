// Whether a file of code looks minified or made hard to read on purpose.
//
// A reading of text cannot say what a file does when the text was made not to be read, so such a file
// is a signal and a blind spot. The five signs are the ones that tools which hide code leave: a line
// of thousands of characters, text made mostly of punctuation, a long run of `\x41` or of the same
// letter as a four-digit unicode escape, a long run of base64, and identifiers of the form `_0x1a2b` that one obfuscator makes. The
// limits were set against about nine thousand files of JavaScript, TypeScript and Python (their
// hand-written code and their bundles) so that hand-written code is not named: the 99th percentile
// of the longest line there is 16,624 characters, of the share of punctuation 0.44, of a base64 run
// 73 characters, and of a run of escapes 4. A bundle is named, and that is right: it cannot be read.
//
// One pass over the text with character tests, no pattern that backtracks.

/** A line longer than this is not written by hand. */
export const LONG_LINE = 4000;
/** The share of non-blank characters that are not letters, digits or underscores; hand-written code is under 0.45. */
export const PUNCTUATION_SHARE = 0.5;
/** A run of this many escapes in a row (`\x41`, or a four-digit unicode escape) is a string that hides its letters. */
export const ESCAPE_RUN = 16;
/** A run of more than this many base64 characters is a blob and not a word or a path. */
export const BASE64_RUN = 200;
/** This many identifiers of the form `_0x1a2b` are the mark of one obfuscator. */
export const HEX_NAMES = 20;
/** A file under this many characters is too small for the share of punctuation to mean anything. */
const MIN_SIZE_FOR_SHARE = 512;
/** The share is measured over this much of the start of a file. */
const SHARE_WINDOW = 64 * 1024;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isHex = (c: number): boolean =>
  isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isBase64 = (c: number): boolean => isAlpha(c) || isDigit(c) || c === 0x2b || c === 0x2f;
const isWordChar = (c: number): boolean => isAlpha(c) || isDigit(c) || c === 0x5f;

/** How many hexadecimal digits follow `at`, up to `most`. */
function hexDigitsAt(text: string, at: number, most: number): number {
  let count = 0;
  while (count < most && isHex(text.charCodeAt(at + count))) count += 1;
  return count;
}

/** The length of the escape that starts at `at` (`\xNN` is 4, `\uNNNN` is 6), or 0. */
function escapeAt(text: string, at: number): number {
  if (text.charCodeAt(at) !== 0x5c) return 0;
  const kind = text.charCodeAt(at + 1);
  if (kind === 0x78 && hexDigitsAt(text, at + 2, 2) === 2) return 4;
  if (kind === 0x75 && hexDigitsAt(text, at + 2, 4) === 4) return 6;
  return 0;
}

/** Whether `_0x` followed by four or more hexadecimal digits starts at `at`, standing on its own. */
function hexNameAt(text: string, at: number): boolean {
  if (
    text.charCodeAt(at) !== 0x5f ||
    text.charCodeAt(at + 1) !== 0x30 ||
    text.charCodeAt(at + 2) !== 0x78
  ) {
    return false;
  }
  return hexDigitsAt(text, at + 3, 4) === 4 && (at === 0 || !isWordChar(text.charCodeAt(at - 1)));
}

/** The signs of a hidden text that `text` shows, in a fixed order; an empty list for text that is not. */
export function obfuscationReasons(text: string): string[] {
  const reasons = new Set<string>();
  let lineLength = 0;
  let base64Run = 0;
  let escapes = 0;
  let hexNames = 0;
  let punctuation = 0;
  let measured = 0;

  for (let at = 0; at < text.length; at += 1) {
    const c = text.charCodeAt(at);
    if (c === 0x0a) lineLength = 0;
    else if (++lineLength > LONG_LINE) reasons.add('a line of thousands of characters');

    base64Run = isBase64(c) ? base64Run + 1 : 0;
    if (base64Run > BASE64_RUN) reasons.add('a long run of base64');

    if (c === 0x5c) {
      const length = escapeAt(text, at);
      if (length > 0) {
        escapes += 1;
        at += length - 1;
        if (escapes >= ESCAPE_RUN) reasons.add('a long run of escape sequences');
        continue;
      }
    }
    escapes = 0;

    if (c === 0x5f && hexNames < HEX_NAMES && hexNameAt(text, at)) {
      hexNames += 1;
      if (hexNames >= HEX_NAMES) reasons.add('identifiers like _0x1a2b');
    }
    if (at < SHARE_WINDOW && c > 0x20) {
      measured += 1;
      if (!isWordChar(c)) punctuation += 1;
    }
  }
  if (
    text.length >= MIN_SIZE_FOR_SHARE &&
    measured > 0 &&
    punctuation / measured >= PUNCTUATION_SHARE
  ) {
    reasons.add('mostly punctuation');
  }
  return [...reasons].sort();
}
