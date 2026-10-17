// A piece of text as one word of a POSIX shell, for a command that is printed for a person to paste.

/** Characters that a POSIX shell reads as themselves anywhere in a word (no `~`, which expands at the start). */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Characters that cannot be shown as they are: the controls, and what shows nothing or changes what is shown. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const UNSHOWABLE_EACH = new RegExp(UNSHOWABLE.source, 'gu');

/** `text` as it stands when it is plain, and between single quotes (a quote in it written as `'\''`) when it is not. */
export const shellWord = (text: string): string =>
  PLAIN_WORD.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Text that comes from a lock, a config or a path, as a word of a command that is printed. When it can be shown as it
 * is, it is a shell word (so the command can be pasted). When it holds a control or an invisible character, or is
 * longer than `units`, it is not trusted text: it is cut, in double quotes, with every such character written out, so
 * it cannot move the cursor or hide itself, and the command is then to be read and not pasted.
 */
export function commandWord(text: string, units: number): string {
  if (text !== '' && text.length <= units && !UNSHOWABLE.test(text)) return shellWord(text);
  const clipped = text.length > units ? `${text.slice(0, units)}...` : text;
  return JSON.stringify(clipped).replace(
    UNSHOWABLE_EACH,
    (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`,
  );
}
