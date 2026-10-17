/** The text of some bytes, or null when they are not text a person can read: invalid UTF-8, or a NUL in it. */
export function textOf(bytes: Uint8Array | undefined): string | null {
  if (bytes === undefined) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}
