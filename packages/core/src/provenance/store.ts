import {
  access,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sessionKey } from '../taint/session-store.js';
import type { AtomKind, ProvenanceRecord } from '../types.js';
import { neutralizeControls } from '../util/controls.js';
import { withLock } from '../util/lock.js';
import { shellQuote } from '../util/shell-quote.js';
import { isFloorKind } from './atom-kinds.js';
import { markerIsStale, pendingMarkerBody } from './pending-marker.js';
import { retain } from './retain.js';

export type ProvenanceInput = Omit<ProvenanceRecord, 'seq' | 'at'>;

export interface ProvenanceStore {
  record(sessionId: string, inputs: readonly ProvenanceInput[]): Promise<void>;
  /** Records whose hash is in `hashes`, most recent first. */
  lookup(sessionId: string, hashes: readonly string[]): Promise<ProvenanceRecord[]>;
  /**
   * Deletes all stored records for a session, and with them the note that its evidence
   * was incomplete; a no-op if none exist. This is what `stroq untaint` calls, and the
   * only way the note goes away.
   */
  clear(sessionId: string): Promise<void>;
  /**
   * Whether this session may have read something that is no longer on record: a record that
   * can raise the floor (a package, a pipe-to-shell, an encoded blob; not a URL or a host) was
   * dropped to stay within the cap, or a result was only partly recorded; or the
   * directory the note would go in cannot be written, so a loss could not be noted. A
   * lookup that finds nothing means "not read" only when this is false.
   *
   * Ask AFTER `lookup`, never before. Setting the note always comes before the records
   * are rewritten, so a lookup that saw records after a drop is followed by an answer of
   * true; asked first, the two could straddle another process's write and read both as
   * clean.
   */
  isIncomplete(sessionId: string): Promise<boolean>;
  /**
   * Whether this session has recorded something a command could be matched against: an atom that
   * can raise the floor (a package, a pipe-to-shell, an encoded blob), or any flagged record.
   * The records of URLs and hosts, and of hashes, do not count: nearly every session has them.
   */
  hasEvidence(sessionId: string): Promise<boolean>;
  /**
   * Whether a marker that a result is being recorded (see `setPending`) is stale at `nowMs`: its
   * deadline has passed, the process that owns it is gone, or it cannot be read or names no owner.
   * That is a result the agent read and the hook did not finish scanning, since a hook that is
   * running answers within its deadline.
   */
  hasStaleMarker(sessionId: string, nowMs?: number): Promise<boolean>;
  /**
   * Whether hashes (the labelled tokens that are not text; see `encodedAtoms`) were left out for
   * want of room, or their file cannot be read. A NARROW loss: it makes a blob that no record
   * accounts for a question, and does not touch packages or pipe-to-shell commands, so that a big
   * lockfile does not make every later install ask. Cleared by `clear`.
   */
  digestsLost(sessionId: string): Promise<boolean>;
  /** Notes that hashes were left out (see `digestsLost`). */
  noteDigestsLost(sessionId: string): Promise<void>;
  /**
   * Notes that evidence for this session was lost or never recorded. Permanent until
   * `clear`: a later short result does not make an earlier loss any less of one.
   */
  markIncomplete(sessionId: string): Promise<void>;
  /**
   * Marks that a result is about to be recorded (`true`) and that it has been (`false`). While
   * it is marked the session reads as incomplete: a process that goes between the two leaves
   * the marker behind, where it would otherwise leave a session that was flagged and has no
   * trace and no note. Unlike the note it is taken off by the one that put it on. Each result
   * supplies its own `owner` and settles only that owner's marker; omitting it addresses the
   * legacy shared marker, which newer callers must leave alone.
   */
  setPending(sessionId: string, pending: boolean, owner?: string): Promise<void>;
}

/** Records beyond this many per session are dropped, the oldest of the least valuable first (see `retain`). */
export const MAX_RECORDS = 2000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/**
 * The note that a session's evidence is incomplete lives beside the records, not in
 * them: `<key>.prov.json` stays the bare array every earlier version reads and writes,
 * so a downgrade or a tool that parses it keeps working. The note's presence is the
 * flag; what is inside is for a person looking at the file.
 */
const INCOMPLETE_SUFFIX = '.prov.incomplete';
const PENDING_SUFFIX = '.prov.pending';
/**
 * Records of hashes live in a file of their own, a bare array like the records file. A reader that
 * does not know the kind never opens it, so an older Stroq sharing the directory is not made to
 * deny every command by a record it cannot parse. Its presence beside a lost-hashes note is read
 * only by this code.
 */
const DIGESTS_SUFFIX = '.prov.digests.json';
const DIGESTS_LOST_SUFFIX = '.prov.digests-lost';
/** The hashes a session keeps; the oldest go first, and that is noted. */
export const MAX_DIGEST_RECORDS = 2000;
/** The kinds of the records file: the ones a 0.26.0 reader knows. A hash is not among them. */
const ATOM_KINDS: ReadonlySet<unknown> = new Set<AtomKind>([
  'url',
  'host',
  'pkg',
  'pipe_shell',
  'encoded',
]);

/**
 * Whether a note could be written in `dir`. A missing directory is made on first use, provided
 * its existing ancestor is a writable directory. A writable file cannot hold a note.
 */
async function canWriteIn(dir: string): Promise<boolean> {
  try {
    if (!(await stat(dir)).isDirectory()) return false;
    await access(dir, constants.W_OK);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    // A dangling symlink is not a missing directory that mkdir can create. Windows may
    // also report ENOENT below a regular file, so check the existing ancestor's type.
    if (await exists(dir)) return false;
    const parent = dirname(dir);
    return parent !== dir && canWriteIn(parent);
  }
}

/** Whether anything is at `path`, a dangling symlink included. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function isProvenanceRecord(
  value: unknown,
  kinds: ReadonlySet<unknown> = ATOM_KINDS,
): value is ProvenanceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['seq'] === 'number' &&
    typeof record['at'] === 'string' &&
    typeof record['tool'] === 'string' &&
    typeof record['source'] === 'string' &&
    kinds.has(record['kind']) &&
    typeof record['hash'] === 'string' &&
    typeof record['excerpt'] === 'string' &&
    typeof record['suspect'] === 'boolean' &&
    (record['flaggedOwn'] === undefined || typeof record['flaggedOwn'] === 'boolean')
  );
}

/**
 * The error for a records file that does not parse. Nothing can be said of what the session read
 * and every command with an atom is denied, so it names the session and the command that starts it
 * over, which the person runs outside the agent: the id is what `stroq log` and the hook's own
 * messages show, and the path holds only a hash of it.
 */
function corruptState(file: string, sessionId: string, cause?: unknown): Error {
  const shown = neutralizeControls(sessionId);
  const message =
    `corrupt provenance state: ${file} (session ${shown}). Stroq cannot say what this session read; ` +
    `to start it over, clear it yourself, outside the agent: stroq untaint --session ${shellQuote(shown)}`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

export class FileProvenanceStore implements ProvenanceStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    /** Test seam: the move that makes a written file the real one. */
    private readonly renameFile: typeof rename = rename,
  ) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}.prov.json`);
  }

  private digestsFile(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}${DIGESTS_SUFFIX}`);
  }

  private digestsLostFile(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}${DIGESTS_LOST_SUFFIX}`);
  }

  private incompleteFile(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}${INCOMPLETE_SUFFIX}`);
  }

  private pendingDir(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}${PENDING_SUFFIX}.d`);
  }

  private pendingFile(sessionId: string, owner?: string): string {
    return owner === undefined
      ? join(this.dir, `${sessionKey(sessionId)}${PENDING_SUFFIX}`)
      : join(this.pendingDir(sessionId), sessionKey(owner));
  }

  private async read(sessionId: string): Promise<ProvenanceRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(sessionId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Fail closed, like the session store: the CLI turns this into `deny`
      // on high-impact tools rather than silently forgetting what was read.
      throw corruptState(this.file(sessionId), sessionId, err);
    }
    if (!Array.isArray(parsed) || !parsed.every((r) => isProvenanceRecord(r))) {
      // Valid JSON but the wrong shape is corruption too: silently treating it
      // as an empty list would let `record` fold it away on the next write, and a
      // record whose `suspect` is not a boolean would read as a clean origin.
      throw corruptState(this.file(sessionId), sessionId);
    }
    return parsed;
  }

  /** The records of hashes, or an error when the file does not parse: a loss of hashes, not of the session. */
  private async readDigests(sessionId: string): Promise<ProvenanceRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.digestsFile(sessionId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    const digestKind: ReadonlySet<unknown> = new Set(['digest']);
    if (!Array.isArray(parsed) || !parsed.every((r) => isProvenanceRecord(r, digestKind)))
      throw new Error('hash records of the wrong shape');
    return parsed;
  }

  private async write(
    sessionId: string,
    records: readonly ProvenanceRecord[],
    target: string = this.file(sessionId),
  ): Promise<void> {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(records), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
      await this.renameFile(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** The error from noting an eviction, or null: it is kept, not thrown, so the records still go in. */
  private async tryNote(sessionId: string): Promise<unknown> {
    try {
      await this.markIncomplete(sessionId);
      return null;
    } catch (err) {
      return err;
    }
  }

  /**
   * Makes the records file one that does not parse, by overwriting its first byte where it is.
   * That needs no new space, so it works on a full disk, and a file that does not parse is what
   * every lookup already fails closed on. It is what a loss that could not be noted leaves
   * behind, until `clear` (untaint) starts the session over.
   */
  private async poison(sessionId: string): Promise<void> {
    try {
      const handle = await open(this.file(sessionId), 'r+');
      try {
        await handle.write('!', 0, 'utf8');
      } finally {
        await handle.close();
      }
    } catch {
      // No file to poison: nothing was recorded to lose.
    }
  }

  async record(sessionId: string, inputs: readonly ProvenanceInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const hashes = inputs.filter((input) => input.kind === 'digest');
    const rest = inputs.filter((input) => input.kind !== 'digest');
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await withLock(`${this.file(sessionId)}.lock`, async () => {
      if (rest.length > 0) await this.recordRest(sessionId, rest);
      if (hashes.length > 0) await this.recordDigests(sessionId, hashes);
    });
  }

  /**
   * Adds hashes to their file, the newest `MAX_DIGEST_RECORDS` kept. The oldest going is a loss,
   * noted before the file is written, like any other.
   */
  private async recordDigests(
    sessionId: string,
    inputs: readonly ProvenanceInput[],
  ): Promise<void> {
    let existing: ProvenanceRecord[] = [];
    try {
      existing = await this.readDigests(sessionId);
    } catch {
      // A file that does not parse is hashes that were lost; it starts over, and says so.
      await this.writeNote(this.digestsLostFile(sessionId), this.digestsLostBody());
    }
    const at = this.now().toISOString();
    const start = existing[existing.length - 1]?.seq ?? 0;
    const added = inputs.map((input, i) => ({ ...input, seq: start + i + 1, at }));
    const all = [...existing, ...added];
    if (all.length > MAX_DIGEST_RECORDS)
      await this.writeNote(this.digestsLostFile(sessionId), this.digestsLostBody());
    await this.write(sessionId, all.slice(-MAX_DIGEST_RECORDS), this.digestsFile(sessionId));
  }

  private digestsLostBody(): string {
    return JSON.stringify({ digestsLost: true, since: this.now().toISOString() });
  }

  async noteDigestsLost(sessionId: string): Promise<void> {
    await this.writeNote(this.digestsLostFile(sessionId), this.digestsLostBody());
  }

  async digestsLost(sessionId: string): Promise<boolean> {
    try {
      if (await exists(this.digestsLostFile(sessionId))) return true;
      await this.readDigests(sessionId);
      return false;
    } catch {
      return true;
    }
  }

  private async recordRest(sessionId: string, inputs: readonly ProvenanceInput[]): Promise<void> {
    const existing = await this.read(sessionId);
    const at = this.now().toISOString();
    const start = existing[existing.length - 1]?.seq ?? 0;
    const added = inputs.map((input, i) => ({ ...input, seq: start + i + 1, at }));
    const { kept, floorLost } = retain([...existing, ...added], MAX_RECORDS);
    // The note first, the records second: a crash between the two leaves a session
    // that says it is incomplete and is not, never one that is and does not say so.
    // A note that cannot be written (the disk is full) does not stop the records going in,
    // and leaves the file failing closed, since nothing else would say a record was dropped.
    // Only the loss of a record that can raise the floor is one to note (see `retain`).
    const noteError = floorLost ? await this.tryNote(sessionId) : null;
    let writeError: unknown = null;
    try {
      await this.write(sessionId, kept);
    } catch (err) {
      writeError = err;
    }
    if (noteError !== null) await this.poison(sessionId);
    if (noteError !== null || writeError !== null) throw noteError ?? writeError;
  }

  /** Writes a small file whose presence is the point, once, atomically and privately. */
  private async writeNote(target: string, body: string): Promise<void> {
    // Idempotent, so it needs no lock: whoever writes it writes the same thing.
    if (await exists(target)) return;
    await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, body, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
      await this.renameFile(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      // Another process may have written the note first, and on Windows renaming onto it then
      // fails (EPERM, EBUSY). The note being there is all that was asked for.
      if (await exists(target).catch(() => false)) return;
      throw err;
    }
  }

  async markIncomplete(sessionId: string): Promise<void> {
    const body = JSON.stringify({ incomplete: true, since: this.now().toISOString() });
    await this.writeNote(this.incompleteFile(sessionId), body);
  }

  async setPending(sessionId: string, pending: boolean, owner?: string): Promise<void> {
    if (!pending) {
      // The directory stays, empty, until `clear`: removing it would race another operation that
      // has made it and is about to write its marker in it, and a marker lost that way is a result
      // that was read and never accounted for.
      await rm(this.pendingFile(sessionId, owner), { force: true });
      return;
    }
    await this.writeNote(this.pendingFile(sessionId, owner), pendingMarkerBody(this.now()));
  }

  async isIncomplete(sessionId: string): Promise<boolean> {
    try {
      if (await exists(this.incompleteFile(sessionId))) return true;
      // A marker that a result is being recorded is a loss only once it is stale: a post that is
      // running (its process alive, its deadline not passed) has lost nothing yet, and a call that
      // runs beside it must not be asked about a package for that. A hook that was killed leaves
      // a marker whose process is gone, and the marker an older version wrote names no owner.
      if (await this.hasStaleMarker(sessionId)) return true;
      // A loss is noted by writing a file here. Where that cannot be done the note cannot
      // exist, and its absence says nothing.
      return !(await canWriteIn(this.dir));
    } catch {
      // A file Stroq cannot even stat is not evidence that nothing was lost.
      return true;
    }
  }

  async hasEvidence(sessionId: string): Promise<boolean> {
    return (await this.read(sessionId)).some((r) => r.suspect || isFloorKind(r.kind));
  }

  async hasStaleMarker(sessionId: string, nowMs: number = Date.now()): Promise<boolean> {
    const files = [this.pendingFile(sessionId)];
    try {
      const owners = await readdir(this.pendingDir(sessionId));
      files.push(...owners.map((owner) => join(this.pendingDir(sessionId), owner)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        // Settled between the listing and the read: nothing is in flight there any more.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return true;
      }
      if (markerIsStale(text, nowMs)) return true;
    }
    return false;
  }

  async lookup(sessionId: string, hashes: readonly string[]): Promise<ProvenanceRecord[]> {
    const wanted = new Set(hashes);
    const found = (await this.read(sessionId)).filter((r) => wanted.has(r.hash)).reverse();
    // Hashes are looked up too, and an unreadable file of them finds none (and is a loss, see `digestsLost`).
    const hashed = await this.readDigests(sessionId).catch((): ProvenanceRecord[] => []);
    return [...found, ...hashed.filter((r) => wanted.has(r.hash)).reverse()];
  }

  async clear(sessionId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await withLock(`${this.file(sessionId)}.lock`, async () => {
      await rm(this.file(sessionId), { force: true });
      await rm(this.digestsFile(sessionId), { force: true });
      await rm(this.digestsLostFile(sessionId), { force: true });
      await rm(this.incompleteFile(sessionId), { force: true });
      await rm(this.pendingFile(sessionId), { force: true });
      await rm(this.pendingDir(sessionId), { recursive: true, force: true });
    });
  }
}
