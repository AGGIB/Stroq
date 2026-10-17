// A piece of text as one word of a POSIX shell, for a command that is printed for a person to paste.

/** Characters that a POSIX shell reads as themselves anywhere in a word (no `~`, which expands at the start). */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** `text` as it stands when it is plain, and between single quotes (a quote in it written as `'\''`) when it is not. */
export const shellWord = (text: string): string =>
  PLAIN_WORD.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
