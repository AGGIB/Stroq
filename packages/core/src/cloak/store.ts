import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withLock } from '../util/lock.js';
import { mintPlaceholder } from './substitute.js';
import type { CloakEntry, CloakRequest, CloakStore } from './types.js';

/**
 * The cloak dictionary: the ONE place Stroq keeps a value it can turn back into
 * itself.
 *
 * Everything else Stroq writes is one-way by construction — the secret index stores
 * `sha256(salt + value)`, provenance stores a redacted 120-character excerpt, the
 * audit log runs every summary through `redact()`. A dictionary that can restore a
 * value is a different threat model and is therefore a different FILE, off by default,
 * `0600` inside a `0700` directory, and forgetful: an entry idle for `CLOAK_TTL_MS` is
 * dropped on the next read, so the window in which a value is recoverable from disk is
 * the working life of the conversation rather than forever. `SECURITY.md` states this
 * in its own section; `rm -rf ~/.stroq/cloak` removes every dictionary at once.
 *
 * It reuses the machinery the secret index already proved: `withLock` around every
 * mutation (several proxies of one client run at once), write-to-temp-then-rename so a
 * crash never leaves half a file, and self-healing on an unreadable file. The
 * self-healing direction matters: a lost dictionary means a placeholder is forwarded
 * to the server as literal text, never that the wrong value is restored.
 */

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const VERSION = 1;

/**
 * How long an entry survives without being used. Long enough that a conversation
 * paused over lunch still resolves its placeholders, short enough that a laptop
 * stolen the next day carries no dictionary worth reading.
 */
export const CLOAK_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The most entries one dictionary holds. Past it the least recently used go first,
 * and a placeholder whose entry was dropped simply stops resolving — the same
 * fail-safe as an expired one. Without a cap, one `SELECT * FROM customers` would
 * write an unbounded copy of the table to disk.
 */
export const MAX_CLOAK_ENTRIES = 2000;

interface CloakFile {
  readonly version: typeof VERSION;
  /** Monotonic, never reset by pruning: a sequence number is never handed to a second value. */
  readonly nextSeq: number;
  readonly entries: readonly CloakEntry[];
}

const EMPTY: CloakFile = { version: VERSION, nextSeq: 1, entries: [] };

const isEntry = (value: unknown): value is CloakEntry => {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Partial<CloakEntry>;
  return (
    typeof e.placeholder === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.value === 'string' &&
    typeof e.at === 'string'
  );
};

/** A dictionary this build can read, or the empty one. Never throws on bad input. */
export function parseCloakFile(raw: string): CloakFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY;
  const file = parsed as Partial<CloakFile>;
  if (file.version !== VERSION || !Array.isArray(file.entries)) return EMPTY;
  const entries = file.entries.filter(isEntry);
  const nextSeq =
    typeof file.nextSeq === 'number' && Number.isFinite(file.nextSeq) && file.nextSeq >= 1
      ? Math.floor(file.nextSeq)
      : entries.length + 1;
  return { version: VERSION, nextSeq, entries };
}

export class FileCloakStore implements CloakStore {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async read(): Promise<CloakFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      // ENOENT is the ordinary first call; anything else (a permission change, a
      // directory where the file should be) is treated the same way, because the
      // consequence is identical and it is the harmless one.
      return EMPTY;
    }
    return this.prune(parseCloakFile(raw));
  }

  /** Drops entries idle past the TTL. `nextSeq` is deliberately left where it was. */
  private prune(file: CloakFile): CloakFile {
    const cutoff = this.now().getTime() - CLOAK_TTL_MS;
    const entries = file.entries.filter((e) => {
      const at = Date.parse(e.at);
      return Number.isFinite(at) && at >= cutoff;
    });
    return entries.length === file.entries.length ? file : { ...file, entries };
  }

  private async write(file: CloakFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tmp, this.file);
  }

  /** Everything a mutation needs: the lock, a fresh read under it, and the write back. */
  private async update<T>(fn: (file: CloakFile) => { file: CloakFile; result: T }): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file}.lock`, async () => {
      const { file, result } = fn(await this.read());
      await this.write(file);
      return result;
    });
  }

  async assign(
    requests: readonly CloakRequest[],
    avoidIn: string,
  ): Promise<Map<string, CloakEntry>> {
    if (requests.length === 0) return new Map();
    return this.update((current) => {
      const at = this.now().toISOString();
      const byValue = new Map(current.entries.map((e) => [e.value, e] as const));
      const taken = new Set(current.entries.map((e) => e.placeholder));
      const out = new Map<string, CloakEntry>();
      let nextSeq = current.nextSeq;
      for (const request of requests) {
        const existing = byValue.get(request.value);
        if (existing) {
          const refreshed: CloakEntry = { ...existing, at };
          byValue.set(request.value, refreshed);
          out.set(request.value, refreshed);
          continue;
        }
        // A placeholder that already appears in the text being cloaked would be
        // resolved on the way back out to a value the server never sent — so the
        // sequence advances until the literal is absent from both the text and the
        // dictionary. `nextSeq` only ever moves forward, so a number freed by pruning
        // is not handed to a second value while the first may still be in context.
        let placeholder = mintPlaceholder(request.kind, nextSeq);
        while (taken.has(placeholder) || avoidIn.includes(placeholder)) {
          nextSeq += 1;
          placeholder = mintPlaceholder(request.kind, nextSeq);
        }
        nextSeq += 1;
        const entry: CloakEntry = {
          placeholder,
          kind: request.kind,
          value: request.value,
          at,
          ...(request.label === undefined ? {} : { label: request.label }),
        };
        taken.add(placeholder);
        byValue.set(request.value, entry);
        out.set(request.value, entry);
      }
      return {
        file: capped({ version: VERSION, nextSeq, entries: [...byValue.values()] }),
        result: out,
      };
    });
  }

  async lookup(placeholders: readonly string[]): Promise<Map<string, CloakEntry>> {
    if (placeholders.length === 0) return new Map();
    const wanted = new Set(placeholders);
    // Read first, without the lock: the common case is a client line carrying no
    // placeholder at all, and taking a file lock for every `tools/call` would put a
    // directory create and a spin loop on the hot path for nothing.
    const current = await this.read();
    const found = current.entries.filter((e) => wanted.has(e.placeholder));
    if (found.length === 0) return new Map();
    // Something was used, so its idle clock restarts. A failure here must not fail
    // the restore — the values are already in hand.
    const at = this.now().toISOString();
    try {
      await this.update((file) => ({
        file: {
          ...file,
          entries: file.entries.map((e) => (wanted.has(e.placeholder) ? { ...e, at } : e)),
        },
        result: undefined,
      }));
    } catch {
      // Refreshing is housekeeping; losing it costs an early expiry, never a wrong answer.
    }
    return new Map(found.map((e) => [e.placeholder, e] as const));
  }
}

/** The cap, applied least-recently-used first so the entries still in play survive. */
function capped(file: CloakFile): CloakFile {
  if (file.entries.length <= MAX_CLOAK_ENTRIES) return file;
  const byAge = [...file.entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { ...file, entries: byAge.slice(byAge.length - MAX_CLOAK_ENTRIES) };
}
