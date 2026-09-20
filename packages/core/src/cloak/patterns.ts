import type { CloakKind, CloakSpan } from './types.js';

/**
 * The structured-PII detectors: regexes run against the ORIGINAL text with
 * `matchAll`, so every span carries a real offset into the exact string it was found
 * in. Nothing here is normalized, base64-decoded or hex-decoded first — a match in a
 * decoded variant has no position in the original, and cloaking at a guessed offset
 * would corrupt the payload. That is also why these are not ATR rules: the scanner's
 * corpus exists to find instruction-like text, reports no offsets, and deliberately
 * fires on decoded variants. A phone number is also not instruction-like text, so
 * putting these in `rules/` would taint every session that reads a contact list.
 *
 * Every quantifier is bounded. An unbounded `+` over two overlapping character
 * classes (which an email pattern naturally has) backtracks quadratically on a long
 * non-matching run, and these run over whole tool results.
 *
 * Each pattern may carry a `validate`: a deterministic check — Luhn, IBAN mod-97, the
 * SSN/ITIN allocation rules, E.164's digit ceiling — that turns a shape into a
 * decision. A candidate that fails its check is dropped entirely rather than retried
 * shorter: a near-miss is much more often an order number than a mangled card.
 */

export interface CloakPattern {
  readonly kind: CloakKind;
  /** Must carry the `g` flag; matched against the original text. */
  readonly re: RegExp;
  /** Deterministic confirmation of a candidate, or `undefined` when the shape is the decision. */
  readonly validate?: (value: string) => boolean;
}

const digitsOf = (value: string): string => value.replace(/\D/g, '');

/** The Luhn check digit, as every payment card carries. */
export function luhn(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * ISO 13616's mod-97 check: move the first four characters to the end, map letters to
 * 10–35, and read the result as one integer that must be ≡ 1 (mod 97). Done digit by
 * digit because the number is far past `Number.MAX_SAFE_INTEGER`.
 */
export function ibanMod97(value: string): boolean {
  const compact = value.replace(/\s/g, '').toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rotated = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rotated) {
    const code = ch.charCodeAt(0);
    const part =
      code >= 65 && code <= 90 ? String(code - 55) : code >= 48 && code <= 57 ? ch : null;
    if (part === null) return false;
    for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * The SSA's own allocation rules, plus the ITIN carve-out. An area of `000`, `666` or
 * `900–999` is never issued as an SSN, and a group of `00` or a serial of `0000` never
 * were either — except that `9xx` with a group in the ITIN ranges IS a real taxpayer
 * number, so it is detected rather than dismissed as a false shape.
 */
export function validSsn(value: string): boolean {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(value);
  if (!m) return false;
  const area = Number(m[1]);
  const group = Number(m[2]);
  const serial = Number(m[3]);
  if (group === 0 || serial === 0) return false;
  if (area === 0 || area === 666) return false;
  if (area < 900) return true;
  // ITIN: area 900–999 with a group the IRS actually allocates.
  return (
    (group >= 70 && group <= 88) || (group >= 90 && group <= 92) || (group >= 94 && group <= 99)
  );
}

/** E.164 caps a subscriber number at 15 digits; below 7 the shape is an ordinary number. */
const plausiblePhone = (value: string): boolean => {
  const n = digitsOf(value).length;
  return n >= 7 && n <= 15;
};

/**
 * Order matters: on a tie in position and length, the pattern listed FIRST wins (see
 * `mergeSpans`). `ssn` precedes `phone` because `123-45-6789` satisfies both shapes
 * and is the more specific reading; `card` precedes `phone` for the same reason,
 * though the E.164 digit ceiling already separates those two.
 */
export const CLOAK_PATTERNS: readonly CloakPattern[] = [
  {
    kind: 'email',
    re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g,
  },
  {
    kind: 'ssn',
    re: /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g,
    validate: validSsn,
  },
  {
    kind: 'iban',
    re: /(?<![A-Za-z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Za-z0-9])/g,
    validate: ibanMod97,
  },
  {
    kind: 'card',
    re: /(?<!\w)(?:\d[ -]?){12,18}\d(?!\w)/g,
    validate: luhn,
  },
  {
    // Either a leading country code or at least three separated groups: a bare run of
    // digits is an order number far more often than it is a telephone number, and a
    // detector that cloaked every 10-digit integer would be uninstalled the same day.
    kind: 'phone',
    re: /(?<![\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)|\d{1,4})(?:[ .-]\d{1,4}){2,4}(?!\w)/g,
    validate: plausiblePhone,
  },
];

/**
 * Every pattern span in `text`, merged so none overlaps and all are in position order.
 * Pure and synchronous: the caller (the composite detector) adds secret spans, which
 * need the index and therefore I/O.
 */
export function detectPatterns(text: string): readonly CloakSpan[] {
  /**
   * The table rank rides alongside the span rather than on it, so a tie between two
   * shapes covering exactly the same characters resolves the documented way without
   * putting an ordering detail into the public `CloakSpan`.
   */
  const found: { readonly span: CloakSpan; readonly rank: number }[] = [];
  for (const [rank, pattern] of CLOAK_PATTERNS.entries()) {
    // A fresh RegExp per call: a shared `g` regex carries `lastIndex` between calls,
    // which would make detection depend on what was scanned before it.
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    for (const m of text.matchAll(re)) {
      const value = m[0];
      if (m.index === undefined || value === '') continue;
      if (pattern.validate && !pattern.validate(value)) continue;
      const span: CloakSpan = {
        kind: pattern.kind,
        start: m.index,
        end: m.index + value.length,
        value,
        restorable: true,
      };
      found.push({ span, rank });
    }
  }
  const ordered = [...found].sort(
    (a, b) => a.span.start - b.span.start || b.span.end - a.span.end || a.rank - b.rank,
  );
  const out: CloakSpan[] = [];
  let end = -1;
  for (const { span } of ordered) {
    if (span.start < end) continue;
    out.push(span);
    end = span.end;
  }
  return out;
}
