import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  MAX_SCAN_CHARS,
  MAX_TEXT_CHARS,
  candidatesFromText,
  detectPatterns,
  extractEnv,
  extractKeyValues,
  looksLikeToken,
} from '@stroq/core';
import { backupsDirIn } from '../paths.js';
import {
  assertWriteAllowed,
  makePrivateDir,
  nodeFs,
  readTargetText,
  writeFileAtomic,
} from './atomic.js';
import {
  BACKUP_ID_PATTERN,
  HardenError,
  sha256Text,
  type BackupPlan,
  type Fs,
  type HardenEnv,
} from './types.js';

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
  const shape = findCredentialShape(before);
  if (shape === null) return { backup: 'copy', notices: [] };
  return {
    backup: shape === 'unchecked' ? 'none-unchecked' : 'none-credential-text',
    notices: [`no byte backup: ${whyNoCopy(shape)}`],
  };
}

/**
 * Why no copy is kept, in words that are true of that case: a file that was found to hold a
 * credential and a file that was too large to be looked at in full are not the same thing.
 */
const whyNoCopy = (shape: CredentialShape): string =>
  shape === 'unchecked'
    ? 'the file is too large to check for credential-shaped text'
    : 'the file holds credential-shaped text';

// ---------------------------------------------------------------------------------------------
// Storing the copy.

/** How many copies of one file are kept: this one and the four before it. */
export const BACKUPS_KEPT_PER_FILE = 5;

const PRIVATE_FILE_MODE = 0o600;

export interface BackupResult {
  readonly id: string;
  /** Whether a copy was written. */
  readonly stored: boolean;
  /** Why not, when it was not. */
  readonly reason?: string;
}

const isBackupId = (id: string): boolean => BACKUP_ID_PATTERN.test(id);

/**
 * A new id for one apply: the UTC time to the millisecond, so that ids sort in the order they were
 * made, and a random part, so that two made in the same millisecond are not one.
 */
export function newBackupId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Where the copy of `real` made under `id` lives: `<home>/backups/<id>/<sha256 of the path>.bak`. */
export const backupPath = (home: string, id: string, real: string): string =>
  join(backupsDirIn(home), id, `${sha256Text(real)}.bak`);

/** What `backupFile` stored for `real` under `id`, or `null` when there is nothing usable there. */
export function readBackup(env: HardenEnv, real: string, id: string): string | null {
  if (!isBackupId(id)) return null;
  try {
    return readTargetText(backupPath(env.home, id, real));
  } catch {
    return null;
  }
}

/**
 * Removes the oldest copies of `real` until `BACKUPS_KEPT_PER_FILE` are left, counting the one
 * just written (`keepId`), which is never removed whatever its id sorts like. Other files' copies
 * are not looked at, and a directory is removed only when this leaves it empty.
 */
async function prune(fs: Fs, home: string, real: string, keepId: string): Promise<void> {
  const root = backupsDirIn(home);
  const name = `${sha256Text(real)}.bak`;
  const holders: string[] = [];
  for (const id of await fs.readdir(root)) {
    if (id === keepId || !isBackupId(id)) continue;
    const holds = await fs.stat(join(root, id, name)).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (holds) holders.push(id);
  }
  const old = [...holders]
    .sort()
    .reverse()
    .slice(BACKUPS_KEPT_PER_FILE - 1);
  for (const id of old) {
    await fs.unlink(join(root, id, name)).catch(() => undefined);
    await fs.rmdir(join(root, id)).catch(() => undefined);
  }
}

/**
 * Keeps a byte copy of `real`, whose text is `bytes`, as `<home>/backups/<id>/<sha256 of the
 * path>.bak` (directories 0700, the file 0600), and drops the oldest copies of the same file
 * beyond five.
 *
 * Returns `stored: false`, with the reason, and writes nothing when the bytes hold
 * credential-shaped text. Throws for an id that is not a plain name, and when the place it
 * would write to leads out of the Stroq home by a link.
 */
export async function backupFile(
  env: HardenEnv,
  real: string,
  bytes: Uint8Array,
  id: string,
): Promise<BackupResult> {
  if (!isBackupId(id)) {
    throw new HardenError(
      'invalid-backup-id',
      'a backup id is a plain name: letters, digits, dots, hyphens and underscores',
    );
  }
  const shape = findCredentialShape(new TextDecoder().decode(bytes));
  if (shape !== null) return { id, stored: false, reason: whyNoCopy(shape) };
  const fs = env.fs ?? nodeFs;
  const file = backupPath(env.home, id, real);
  // The home is Stroq's own and may be a link on purpose; the only rule is that nothing in it
  // leads out. Asked first, so that no directory is made or changed through such a link.
  const rules = { root: env.home, initRule: false } as const;
  assertWriteAllowed(file, rules);

  await makePrivateDir(fs, backupsDirIn(env.home));
  await makePrivateDir(fs, dirname(file));
  try {
    await writeFileAtomic(file, bytes, { ...rules, mode: PRIVATE_FILE_MODE, fs });
  } catch (err) {
    await fs.rmdir(dirname(file)).catch(() => undefined);
    throw err;
  }
  // A copy that cannot be pruned is still a copy; the next one tries again.
  await prune(fs, env.home, real, id).catch(() => undefined);
  return { id, stored: true };
}
