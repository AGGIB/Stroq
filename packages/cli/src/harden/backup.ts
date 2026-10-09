import {
  MAX_SCAN_CHARS,
  MAX_TEXT_CHARS,
  candidatesFromText,
  detectPatterns,
  extractEnv,
  extractKeyValues,
  looksLikeToken,
} from '@stroq/core';
import type { BackupPlan } from './types.js';

/**
 * Deciding whether a file may be copied.
 *
 * A byte copy of a settings file is one more file on the disk, and if the settings hold a
 * credential (an `env` block with a token, an MCP server started with a key) it is one more copy
 * of the credential, in a place the owner did not put it and will not think to clean. So the
 * engine looks at the pre-image first, with the same detectors that guard secrets everywhere else
 * in Stroq, and keeps no copy of a file that holds anything credential-shaped. Undo of such a file
 * works on the entries Stroq added alone, which is what it does for any file that was edited
 * afterwards anyway.
 *
 * This is a heuristic, and it leans toward "do not copy": a false alarm costs the byte copy
 * (undo is surgical instead) and a miss costs a credential in one more place.
 */

/** What kind of credential-shaped text a file holds. Never the text itself. */
export type CredentialShape =
  /** A token of a known vendor's shape (`ghp_`, `AKIA`, `sk-`, `npm_`, a JWT ...), anywhere. */
  | 'vendor-token'
  /** A value that is not a location or a placeholder, under a name that says it is a secret. */
  | 'named-secret'
  /** A payment card, an IBAN or a social security number, each checked by its own check digit. */
  | 'personal-data'
  /** Too large to be checked all the way through, which is not the same as clean. */
  | 'unchecked';

export const NO_BYTE_BACKUP_NOTICE = 'no byte backup: the file holds credential-shaped text';

/**
 * `extractKeyValues` reads at most this many lines and `MAX_TEXT_CHARS` characters of what it is
 * given, and drops the rest without a word, so a long file is handed to it in pieces.
 */
const CHUNK_LINES = 4_000;
const CHUNK_CHARS = MAX_TEXT_CHARS / 2;

/**
 * Not emails (they are in every config that names its owner, and are not credentials) and not
 * phone numbers (a date is one). Cards, IBANs and social security numbers carry check digits, so
 * a hit is a fact and not a shape.
 */
const PERSONAL_KINDS: ReadonlySet<string> = new Set(['card', 'iban', 'ssn']);

function* lineChunks(text: string): Generator<string> {
  let chunk: string[] = [];
  let chars = 0;
  for (const line of text.split('\n')) {
    if (chunk.length >= CHUNK_LINES || chars + line.length + 1 > CHUNK_CHARS) {
      yield chunk.join('\n');
      chunk = [];
      chars = 0;
    }
    chunk.push(line);
    chars += line.length + 1;
  }
  if (chunk.length > 0) yield chunk.join('\n');
}

/**
 * Every string in a JSON document, with the name it hangs under (the nearest key above it), asked
 * of the same rule that reads an environment: "does this name say secret, and is this value one?".
 * Walked with a stack of its own: a hostile file can be nested far deeper than the call stack.
 */
function jsonHoldsNamedSecret(text: string): boolean {
  let root: unknown;
  try {
    root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return false;
  }
  const pending: { readonly value: unknown; readonly name: string | null }[] = [
    { value: root, name: null },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, name } = next;
    if (typeof value === 'string') {
      if (name !== null && extractEnv({ [name]: value }).length > 0) return true;
    } else if (Array.isArray(value)) {
      for (const item of value as unknown[]) pending.push({ value: item, name });
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) pending.push({ value: item, name: key });
    }
  }
  return false;
}

function holdsNamedSecret(text: string): boolean {
  for (const chunk of lineChunks(text)) if (extractKeyValues(chunk).length > 0) return true;
  return jsonHoldsNamedSecret(text);
}

/**
 * What kind of credential-shaped text `text` holds, or `null` when it holds none. It never
 * throws and never returns any part of the text.
 */
export function findCredentialShape(text: string): CredentialShape | null {
  if (text.length > MAX_SCAN_CHARS) return 'unchecked';
  // The vendor shape goes first: the name-aware reader below also takes such a value under any
  // name, and "a token of a known shape" is the more exact thing to say about it.
  if (candidatesFromText(text).some((candidate) => looksLikeToken(candidate.token))) {
    return 'vendor-token';
  }
  if (holdsNamedSecret(text)) return 'named-secret';
  if (detectPatterns(text).some((span) => PERSONAL_KINDS.has(span.kind))) return 'personal-data';
  return null;
}

/**
 * What a plan tells the owner about the copy: whether one will be kept for `before` (the file's
 * text now, or `null` when there is no file), and the sentence to show when it will not.
 */
export function planBackup(before: string | null): {
  readonly backup: BackupPlan;
  readonly notices: readonly string[];
} {
  if (before === null) return { backup: 'none-new-file', notices: [] };
  if (findCredentialShape(before) === null) return { backup: 'copy', notices: [] };
  return { backup: 'none-credential-text', notices: [NO_BYTE_BACKUP_NOTICE] };
}
