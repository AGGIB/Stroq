// Whether a name about to be printed holds a piece of a key.
//
// A host, a path or a program name in a report came from a session, and a piece of a key in it is
// as bad as the key: `https://<ten letters of the key>.collect.example`, a folder named after one,
// a path cut out of a key at its `/`. Any six characters of a key, in any case, as it is, as JSON
// writes it or URL-encoded, are a piece. Each piece of each key sets two bits of one fixed table,
// so the table does not grow with the keys, and a name is read once, six characters at a time:
// linear in the keys and in the name, whatever either holds. A name whose six characters only
// happen to set the bits of a piece is hidden too: with the keys of one machine that is rare, and
// hiding a name that held no key costs only the name.
import { keyForms } from './needles.js';

/** A piece of a key this long or longer is not printed; shorter ones are ordinary words. */
export const MIN_PIECE = 6;
/** Bits in the table: 2 MiB, whatever the number of keys. */
const BITS = 1 << 24;
const MASK = BITS - 1;

/** Two hashes of the six characters of `text` at `at`. */
function hashes(text: string, at: number): readonly [number, number] {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = at; i < at + MIN_PIECE; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b + c, 0x85ebca6b) ^ (b >>> 13);
  }
  return [(a >>> 0) & MASK, (Math.imul(b, 0xc2b2ae35) >>> 0) & MASK];
}

/** `%XX` written as the character it stands for, where it stands for one; one pass. */
function percentDecoded(text: string): string {
  if (!text.includes('%')) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '%' && /^[0-9a-f]{2}$/i.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else out += text[i];
  }
  return out;
}

export interface PieceTable {
  /** Whether `text` holds six characters of a key, in any case, as it is or percent-decoded. */
  has(text: string): boolean;
}

export function pieceTable(values: readonly string[]): PieceTable {
  let bits: Uint8Array | null = null;
  const set = (bit: number, table: Uint8Array): void => {
    table[bit >>> 3] = (table[bit >>> 3] ?? 0) | (1 << (bit & 7));
  };
  const isSet = (bit: number, table: Uint8Array): boolean =>
    ((table[bit >>> 3] ?? 0) & (1 << (bit & 7))) !== 0;
  /** Built when first asked: most runs print no name at all. */
  const table = (): Uint8Array => {
    if (bits !== null) return bits;
    const built = new Uint8Array(BITS >>> 3);
    for (const value of values)
      for (const form of keyForms(value)) {
        const lower = form.toLowerCase();
        for (let at = 0; at + MIN_PIECE <= lower.length; at += 1) {
          const [a, b] = hashes(lower, at);
          set(a, built);
          set(b, built);
        }
      }
    bits = built;
    return built;
  };
  const holds = (lower: string, t: Uint8Array): boolean => {
    for (let at = 0; at + MIN_PIECE <= lower.length; at += 1) {
      const [a, b] = hashes(lower, at);
      if (isSet(a, t) && isSet(b, t)) return true;
    }
    return false;
  };
  return {
    has(text: string): boolean {
      if (text.length < MIN_PIECE || values.length === 0) return false;
      const t = table();
      const lower = text.toLowerCase();
      return holds(lower, t) || holds(percentDecoded(text).toLowerCase(), t);
    },
  };
}
