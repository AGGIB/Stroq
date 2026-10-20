// Whether a text holds a key, and a text as the coarse rules read it.
import { keyForms, shellJoined } from './needles.js';

/**
 * Whether a text holds a key's value, in any of its spellings, as it is or as a shell joins its
 * words (`"Pa\$\$w0rd"`, `'a'\''b'`, `sk_""live`).
 */
export function valueHolds(key: { readonly value: string }): (text: string) => boolean {
  const forms = keyForms(key.value);
  return (text) =>
    forms.some((f) => text.includes(f)) ||
    (/['"\\]/.test(text) && forms.some((f) => shellJoined(text).includes(f)));
}

/**
 * A text as the coarse rules compare names in it: the quotes and backslashes a shell splits words
 * with taken out, in lower case. A name is in a text when it is a substring of this.
 */
export const plainText = (text: string): string => shellJoined(text).toLowerCase();
