// Commands the console offers to copy. The user pastes them into a terminal, so what is shown must
// be exactly what is copied, and no value from a log or a repository may add words to a command.

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

// Control characters (including newlines), line separators, zero-width and bidi-override
// characters, and every other character Unicode lets a renderer draw as nothing (the soft hyphen,
// the combining grapheme joiner, the Arabic letter mark, Hangul fillers, Khmer inherent vowels,
// Mongolian selectors, the word joiner, invisible operators, interlinear annotation, shorthand and
// musical format controls, tags and the variation-selector supplement): anything that can run, hide
// or reorder text in a terminal or a page. The variation selectors U+FE00-FE0F are left out: they
// change how a visible character is drawn, and an emoji carries one. Listed as code point ranges,
// not as a pattern, so no editor or formatter can turn them into raw characters.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x206a, 0x206f],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

/**
 * The first character of `text` in the table above, as its code point, or null when there is none.
 * `laidOut` names characters the caller puts there itself, such as the line breaks of its own layout.
 */
export function unsafeCodePoint(text: string, laidOut: readonly number[] = []): number | null {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (laidOut.includes(code)) continue;
    if (UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to)) return code;
  }
  return null;
}

/** Every code point in the table, for a closed list of messages that each name one. */
export function unsafeCodePoints(): number[] {
  return UNSAFE_RANGES.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i),
  );
}

const hasUnsafeChar = (text: string): boolean => unsafeCodePoint(text) !== null;

/** A command longer than this would scroll out of view in its one-line box. */
export const MAX_COMMAND_LENGTH = 240;

/** Quotes one argument for a POSIX shell, so it stays one word whatever it contains. */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (PLAIN_WORD.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Builds a command line from words, quoting every one that needs it. */
export function commandLine(...words: readonly string[]): string {
  return words.map(shellQuote).join(' ');
}

/** True when the whole command fits its box and holds nothing a terminal could misread. */
export function isCopyable(command: string): boolean {
  return command.length > 0 && command.length <= MAX_COMMAND_LENGTH && !hasUnsafeChar(command);
}
