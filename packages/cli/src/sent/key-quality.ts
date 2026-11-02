// Whether a value read from a key file is worth tracing: does it look like a secret, or like an example?
//
// A `.env` that a framework's quick start wrote, or a team's template, holds values that are the same on
// thousands of machines and in every session that touched the file: `super-secret-jwt-token-with-at-least-
// 32-characters-long`, `changeme`, `your-api-key-here`, the keys the vendors print in their documentation.
// Tracing one finds it in every session and "sends" it with every request that ran near it, and the report
// says a key was sent that is no key. So a value is traced only if it passes these, in this order (the
// first that fails says why):
//
//   placeholder  an example's words (`your-…`, `…-here`, `changeme`, `replace-with-…`), a run of `x` (`xxxxxxxx`,
//                the middle of `sk-xxxx…`)
//   example      a value the vendors print in their documentation (AWS's `…EXAMPLE…`, Stripe's `sk_test_4eC39…`)
//   not-random   a character repeated eight times, too little entropy (a repeated pair, `123123123123`), or
//                one class of character and short
//                (`abcdefghijklmnop`, `123456789012`)
//   words        mostly common words, in whole runs of letters (`super-secret-jwt-token…`, `mysecretpassword`,
//                `password123`, `correct-horse-battery-staple`)
//
// A vendor-shaped token (`sk-…`, `AKIA…`, `ghp_…`, a JWT) is a credential whatever its words, once it passed
// the first three. A weak password a person chose (`hunter2hunter2`, `Welcome2024!`) is traced: it is a real
// secret and low in entropy by nature, and it is not mostly words. A passphrase of nothing but common words is
// the one case this cannot tell from an example, and it is not traced; the report counts the values not
// traced, so the user sees how many there are.
//
// Nothing here backtracks and every step reads the value once; a long value is cut at `MAX_READ`.
import { COMMON_WORDS } from './common-words.js';

/** Why a value is not traced. */
export type NotTraced = 'placeholder' | 'example' | 'not-random' | 'words';

export type Judgement =
  { readonly traced: true } | { readonly traced: false; readonly why: NotTraced };

/** The most characters of a value read. */
const MAX_READ = 4_096;
/** Entropy (bits for each character) under which a value of 12 or more characters is not random. */
const MIN_ENTROPY = 2.5;
/** Under this many characters a value of one class of character is not random. */
const ONE_CLASS_BELOW = 24;
/** The share of a value's letters and digits that whole runs of common words cover, from which it is words. */
const WORDS_SHARE = 0.7;
/** The fewest letters and digits a value has to be judged by its words. */
const MIN_FOR_WORDS = 8;
/** The longest run of letters taken apart into words. */
const MAX_RUN = 64;

/** Words a placeholder is made of, beyond the common ones. */
const EXTRA_WORDS = `
secret secrets super token tokens key keys password passwd pass jwt worker workers local development
production staging test testing dev prod change changeme replace here your example sample dummy
placeholder default admin administrator root user api app access auth bearer client server database
session cookie signing salt private public long short least characters character string random
generated value insert enter fill todo demo mock this that for only use correct horse battery staple
my me is it of to in on or up id db os ok do be by we he hmac secretkey apikey webhook encryption
master main internal external service account credentials credential
`
  .split(/\s+/)
  .filter((w) => w !== '');

const WORDS: ReadonlySet<string> = new Set(
  [...COMMON_WORDS, ...EXTRA_WORDS].filter((w) => w.length >= 2),
);
const LONGEST_WORD = Math.max(...[...WORDS].map((w) => w.length));

/** Words and signs an example is made of. */
const PLACEHOLDER = [
  /^(?:your|insert|enter|paste|replace|change|fill|put)[-_. ]/,
  /(?:^|[-_.])(?:here|placeholder|example|sample|dummy|changeme|replaceme|todo)(?:$|[-_.])/,
  /changeme|change-me|change_me|replace-?me|placeholder|your[-_]?(?:api|secret|token|key|password)/,
  /x{6,}/,
];

/** What the vendors print in their documentation. */
const EXAMPLE = [
  /example/,
  /^sk_test_[4]ec39hqlyjwdarjtt1zdp7dc$/,
  /^pk_test_tyoomqauvdedq54ni?tphi7jx$/,
  /^pk_test_tyoomqauvdedq54nitphi7jx$/,
];

/** The shapes of vendor tokens: a credential whatever else it resembles. */
const VENDOR = [
  /^sk-[A-Za-z0-9_-]{10,}$/,
  /^sk_(?:live|test)_[A-Za-z0-9]{12,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  /^AIza[0-9A-Za-z_-]{30,}$/,
  /^npm_[A-Za-z0-9]{20,}$/,
  /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
];

/** Shannon entropy of a text, in bits for each character. */
function entropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / [...text].length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether the letters of `run` (lower case) are a sequence of whole words, by the shortest way. */
function isWords(run: string): boolean {
  const n = run.length;
  const reach: boolean[] = new Array<boolean>(n + 1).fill(false);
  reach[0] = true;
  for (let i = 0; i < n; i += 1) {
    if (!reach[i]) continue;
    for (let len = 2; len <= LONGEST_WORD && i + len <= n; len += 1)
      if (WORDS.has(run.slice(i, i + len))) reach[i + len] = true;
  }
  return reach[n] === true;
}

/** The share of a value's letters and digits that whole runs of words cover. */
function wordShare(value: string): number {
  let covered = 0;
  let total = 0;
  for (const part of value.toLowerCase().split(/[^a-z0-9]+/)) {
    total += part.length;
    for (const run of part.split(/[0-9]+/)) {
      if (run.length >= 2 && run.length <= MAX_RUN && isWords(run)) covered += run.length;
    }
  }
  return total === 0 ? 0 : covered / total;
}

/** How many classes of character a value has: lower case, upper case, digits, signs. */
function classes(value: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  let sign = false;
  for (const c of value) {
    if (c >= 'a' && c <= 'z') lower = true;
    else if (c >= 'A' && c <= 'Z') upper = true;
    else if (c >= '0' && c <= '9') digit = true;
    else sign = true;
  }
  return [lower, upper, digit, sign].filter(Boolean).length;
}

const no = (why: NotTraced): Judgement => ({ traced: false, why });

/** Whether a value read from a key file is traced, and if not, why. */
export function judgeValue(raw: string): Judgement {
  const value = raw.slice(0, MAX_READ);
  const lower = value.toLowerCase();
  if (PLACEHOLDER.some((re) => re.test(lower))) return no('placeholder');
  if (EXAMPLE.some((re) => re.test(lower))) return no('example');
  if (/(.)\1{7,}/.test(value) || (value.length >= 12 && entropy(value) < MIN_ENTROPY))
    return no('not-random');
  if (VENDOR.some((re) => re.test(value))) return { traced: true };
  if (classes(value) === 1 && value.length < ONE_CLASS_BELOW) return no('not-random');
  const alnum = value.replace(/[^A-Za-z0-9]/g, '').length;
  if (alnum >= MIN_FOR_WORDS && wordShare(value) >= WORDS_SHARE) return no('words');
  return { traced: true };
}
