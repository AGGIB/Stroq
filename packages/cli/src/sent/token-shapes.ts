// The shapes of well-known tokens, for taking one out of a text whether or not Stroq holds it as a key.
//
// Each is a literal prefix and a run of its characters, so each is read in one pass over the text, however
// the text is built.

export const TOKEN_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bglpat-[A-Za-z0-9_-]{15,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bstroq_attack_[0-9a-f]{6,}/g,
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----/g,
];

/** `text` with every token-shaped run replaced by `mark`. */
export function redactTokens(text: string, mark: string): string {
  let out = text;
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, mark);
  return out;
}
