/** Characters a POSIX shell reads as text; anything else makes the word need quoting. */
const SAFE_WORD = /^[\w@%+=:,./-]+$/;

/** `word` as one word of a POSIX shell command line, quoted only when it has to be. */
export const shellQuote = (word: string): string =>
  SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
