import { createHmac, randomBytes } from 'node:crypto';

/**
 * What of a repository config's text may be written into a finding. A value can hold a secret
 * anywhere: an env variable, a header, an argument, an address. So nothing of an env, a header or
 * an argument is written, only its keys, a digest under a key made for this run and a length; an
 * address loses its user, its password, its query and its fragment; an Authorization, Bearer or
 * Basic text is removed. A value shown otherwise than it is ends in that digest, so a change to
 * it is still a change, while nothing printed matches a guessed text outside this run.
 *
 * Every step is one pass or a scan that does not go back, so the work is linear in the text.
 */

/** A key for this run only. */
const RUN_KEY = randomBytes(32);
/** A digest of `text` under this run's key: equal texts match within a run, and nothing else. */
export const keyed = (text: string): string =>
  `keyed:${createHmac('sha256', RUN_KEY).update(text).digest('hex').slice(0, 16)}`;

/** Keys whose values are never shown: their keys are, or a count. */
const HIDDEN_KEYS =
  /"(?:env|environment|headers|args|remoteEnv|containerEnv|secrets|httpHeaders)":/gi;
/** A word of text, between blanks and quotes: an address is scrubbed word by word. */
const WORD = /[^\s'"`]+/g;
/** The user and password of an address, from each `://` to the `@` before the next `/`. */
const USERINFO = /:\/\/[^/@]*@/g;

/**
 * A word with its addresses scrubbed: from its first `://` on, the first `?` or `#` and all after
 * it are cut, and each user and password before a host goes. One pass over the word.
 */
function scrubWord(word: string): string {
  const scheme = word.indexOf('://');
  if (scheme === -1) return word;
  const rest = word.slice(scheme);
  const query = rest.search(/[?#]/);
  const kept = query === -1 ? word : word.slice(0, scheme + query);
  return kept.replace(USERINFO, '://');
}

/** An Authorization field and what follows it, with or without a scheme word. */
const AUTHORIZATION =
  /\b(authorization)(["']?[ \t]*[:=][ \t]*["']?)((?:bearer|basic|token)[ \t]+)?[^\s"'`,;}]+/gi;
/** A Bearer or Basic credential on its own. */
const SCHEME = /\b(bearer|basic)([ \t]+)[^\s"'`,;}]+/gi;

const REMOVED = '[removed]';

/** Where the JSON value that starts at `at` ends, past it; -1 when it does not end in `text`. */
function jsonEnd(text: string, at: number): number {
  const open = text[at];
  if (open === '"') {
    for (let i = at + 1; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '"') return i + 1;
    }
    return -1;
  }
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** What a hidden JSON value is shown as: the keys of an object, the length of a list. */
function hiddenAs(json: string): string {
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value)) return JSON.stringify(`${value.length} items`);
    if (typeof value === 'object' && value !== null) return JSON.stringify(Object.keys(value));
  } catch {
    // Cut or not JSON: nothing of it is shown.
  }
  return JSON.stringify(REMOVED);
}

/** `text` with the values of the keys in `HIDDEN_KEYS` replaced by their keys or a count. */
function hideFields(text: string): string {
  let out = '';
  let from = 0;
  for (const match of text.matchAll(HIDDEN_KEYS)) {
    const at = (match.index as number) + match[0].length;
    if (at < from) continue;
    const end = jsonEnd(text, at);
    const first = text[at];
    if (first !== '"' && first !== '{' && first !== '[') continue;
    out += text.slice(from, at);
    if (end === -1) return `${out}${JSON.stringify(REMOVED)}`;
    out += first === '"' ? JSON.stringify(REMOVED) : hiddenAs(text.slice(at, end));
    from = end;
  }
  return out + text.slice(from);
}

/** `text` as it may be shown: addresses scrubbed, credentials removed, hidden fields hidden. */
export function shownValue(text: string): string {
  return hideFields(
    text
      .replace(WORD, scrubWord)
      .replace(AUTHORIZATION, `$1$2$3${REMOVED}`)
      .replace(SCHEME, `$1$2${REMOVED}`),
  );
}

/** The value of a finding shown as `shown` while it is `raw`: with a digest and a length of `raw`. */
export const withDigest = (shown: string, raw: string): string =>
  `${shown === '' ? '' : `${shown} `}(${keyed(raw)}, ${raw.length} chars)`;
