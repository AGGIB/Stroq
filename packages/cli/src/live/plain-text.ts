// Text from outside, made into a line a person can read and a terminal will not obey.

/** A detail is one line a person reads: the longest of them. */
export const MAX_DETAIL_CHARS = 160;

/** Text from outside made into one line of plain characters, for a field that is printed. */
export function plainText(text: string, max: number = MAX_DETAIL_CHARS): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .trim()
    .slice(0, max);
}
