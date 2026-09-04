import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SecretHit, SecretMatch } from '../types.js';
import { withLock } from '../util/lock.js';
import type { SecretCandidate } from './candidates.js';
import {
  extractDockerAuths,
  extractEnv,
  extractKeyValues,
  extractNetrc,
  type ExtractedSecret,
} from './extract.js';

export interface SecretIndexStats {
  readonly entries: number;
  readonly sources: number;
  readonly canaries: number;
  readonly builtAt: string | null;
  /** Some project `.env*` files or entries were dropped: the guard is incomplete. */
  readonly truncated: boolean;
  /** Sources that exist but could not be read or parsed, so contributed nothing. */
  readonly unreadable: number;
  /** The index file exists but is unusable (unparsable or a stale version); it rebuilds. */
  readonly corrupt: boolean;
}

export interface SecretIndex {
  /** One match per matching candidate, deduped. No I/O when `candidates` is empty. */
  lookup(candidates: readonly SecretCandidate[], cwd: string): Promise<SecretMatch[]>;
  addCanary(value: string, name?: string): Promise<void>;
  stats(): Promise<SecretIndexStats>;
}

interface IndexedEntry extends SecretHit {
  readonly hash: string;
}
interface IndexedSource {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}
interface IndexFile {
  readonly version: typeof INDEX_VERSION;
  readonly salt: string;
  readonly builtAt: string;
  readonly sources: readonly IndexedSource[];
  readonly entries: readonly IndexedEntry[];
  readonly canaries: readonly IndexedEntry[];
  readonly truncated: boolean;
  readonly unreadable: number;
}
/** Read result that distinguishes "no index yet" from "index there but unusable". */
interface LoadedIndex {
  readonly index: IndexFile | null;
  readonly corrupt: boolean;
}
/** Entries plus the health of the read that produced them. */
interface BuiltEntries {
  readonly entries: readonly IndexedEntry[];
  readonly unreadable: number;
  readonly truncated: boolean;
}

/** Bumped whenever the file shape changes; an older file is rebuilt from its sources. */
const INDEX_VERSION = 2;
/** Sources larger than this contribute nothing (credential files are tiny). */
export const MAX_SOURCE_BYTES = 262_144;
/** Cap on indexed entries: the FIRST N in source order (home sources first) are kept. */
export const MAX_ENTRIES = 2000;
/** Cap on project `.env*` files read, sorted by name; home sources are never dropped. */
export const MAX_PROJECT_ENV_FILES = 32;
const HOME_SOURCES = ['.aws/credentials', '.npmrc', '.netrc', '.docker/config.json'];
const PROJECT_ENV = /^\.env(\.[\w-]+)?$/;
const EXAMPLE_ENV = /\.(example|sample|template|dist)$/;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export function hashSecret(salt: string, value: string): string {
  return createHash('sha256').update(`${salt}\n${value}`).digest('hex').slice(0, 32);
}

export function displayPath(path: string, home: string): string {
  return home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function extractFor(path: string, text: string): ExtractedSecret[] {
  const name = basename(path);
  if (name === '.netrc') return extractNetrc(text);
  if (name === 'config.json') return extractDockerAuths(text);
  return extractKeyValues(text);
}

/** The first `MAX_PROJECT_ENV_FILES` `.env*` files in the project, sorted by name. */
function projectEnvFiles(cwd: string): { readonly files: string[]; readonly truncated: boolean } {
  try {
    const found = readdirSync(cwd)
      .filter((f) => PROJECT_ENV.test(f) && !EXAMPLE_ENV.test(f))
      .sort();
    return {
      files: found.slice(0, MAX_PROJECT_ENV_FILES).map((f) => join(cwd, f)),
      truncated: found.length > MAX_PROJECT_ENV_FILES,
    };
  } catch {
    return { files: [], truncated: false };
  }
}

function statSources(paths: readonly string[]): IndexedSource[] {
  return paths.flatMap((path) => {
    try {
      const s = statSync(path);
      return s.isFile() && s.size <= MAX_SOURCE_BYTES
        ? [{ path, mtimeMs: s.mtimeMs, size: s.size }]
        : [];
    } catch {
      return [];
    }
  });
}

/** A usable index file, or `null` when the text is not one (unparsable or a stale version). */
function parseIndex(raw: string): IndexFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const index = parsed as IndexFile | null;
  if (!index || typeof index !== 'object' || Array.isArray(index)) return null;
  if (index.version !== INDEX_VERSION) return null;
  const shaped =
    typeof index.salt === 'string' &&
    typeof index.builtAt === 'string' &&
    typeof index.truncated === 'boolean' &&
    typeof index.unreadable === 'number' &&
    Array.isArray(index.sources) &&
    Array.isArray(index.entries) &&
    Array.isArray(index.canaries);
  return shaped ? index : null;
}

function sameSources(a: readonly IndexedSource[], b: readonly IndexedSource[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.path === b[i]?.path && s.mtimeMs === b[i]?.mtimeMs && s.size === b[i]?.size)
  );
}

export class FileSecretIndex implements SecretIndex {
  constructor(
    private readonly file: string,
    private readonly home: string,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private sources(cwd: string): { readonly list: IndexedSource[]; readonly truncated: boolean } {
    const homeFiles = HOME_SOURCES.map((rel) => join(this.home, rel));
    const project = projectEnvFiles(cwd);
    return { list: statSources([...homeFiles, ...project.files]), truncated: project.truncated };
  }

  /**
   * The current index, plus whether a file was there but unusable (corrupt, wrong shape
   * or an older version) — `doctor` reports that instead of "not built yet". The index is
   * fully derivable from its sources, so unlike the session and provenance stores it
   * self-heals by rebuilding instead of failing closed; any canaries recorded in a corrupt
   * file are lost, which is an acceptable trade-off for never hard-denying.
   */
  private async load(): Promise<LoadedIndex> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { index: null, corrupt: false };
      throw err;
    }
    const index = parseIndex(raw);
    return { index, corrupt: index === null };
  }

  private async readOrNull(): Promise<IndexFile | null> {
    return (await this.load()).index;
  }

  private async write(index: IndexFile): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(index), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tmp, this.file);
  }

  /** Reads sources one at a time — a handful of tiny files, so concurrency buys nothing. */
  private async entriesFrom(
    sources: readonly IndexedSource[],
    salt: string,
  ): Promise<BuiltEntries> {
    const all: IndexedEntry[] = [];
    let unreadable = 0;
    for (const source of sources) {
      try {
        const text = await readFile(source.path, 'utf8');
        const display = displayPath(source.path, this.home);
        for (const s of extractFor(source.path, text)) {
          all.push({
            hash: hashSecret(salt, s.value),
            name: s.name,
            source: display,
            canary: s.canary,
          });
        }
      } catch {
        unreadable += 1;
      }
    }
    return { entries: all.slice(0, MAX_ENTRIES), unreadable, truncated: all.length > MAX_ENTRIES };
  }

  private async build(cwd: string, previous: IndexFile | null): Promise<IndexFile> {
    const salt = previous?.salt ?? randomBytes(16).toString('hex');
    const sources = this.sources(cwd);
    const built = await this.entriesFrom(sources.list, salt);
    return {
      version: INDEX_VERSION,
      salt,
      builtAt: this.now().toISOString(),
      sources: sources.list,
      entries: built.entries,
      canaries: previous?.canaries ?? [],
      truncated: sources.truncated || built.truncated,
      unreadable: built.unreadable,
    };
  }

  /** Returns a current index, rebuilding (under the lock) when any source changed. */
  private async ensure(cwd: string): Promise<IndexFile> {
    const previous = await this.readOrNull();
    if (previous && sameSources(previous.sources, this.sources(cwd).list)) return previous;
    await mkdir(join(this.file, '..'), { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file}.lock`, async () => {
      const latest = await this.readOrNull();
      const next = await this.build(cwd, latest);
      await this.write(next);
      return next;
    });
  }

  private liveEntries(salt: string): IndexedEntry[] {
    return extractEnv(this.env).map((s) => ({
      hash: hashSecret(salt, s.value),
      name: s.name,
      source: 'env',
      canary: s.canary,
    }));
  }

  async lookup(candidates: readonly SecretCandidate[], cwd: string): Promise<SecretMatch[]> {
    if (candidates.length === 0) return [];
    const index = await this.ensure(cwd);
    const byHash = new Map<string, IndexedEntry>();
    for (const entry of [...index.entries, ...index.canaries, ...this.liveEntries(index.salt)]) {
      if (!byHash.has(entry.hash)) byHash.set(entry.hash, entry);
    }
    const seen = new Set<string>();
    const hits: SecretMatch[] = [];
    // Deduped by token AND raw form: the same value can appear twice in one command,
    // once plain and once encoded, and both spellings must be redactable.
    for (const { token, raw } of candidates) {
      const key = `${token}\n${raw}`;
      if (seen.has(key)) continue;
      const entry = byHash.get(hashSecret(index.salt, token));
      if (!entry) continue;
      seen.add(key);
      hits.push({ name: entry.name, source: entry.source, canary: entry.canary, token, raw });
    }
    return hits;
  }

  async addCanary(value: string, name = 'STROQ_CANARY_KEY'): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true, mode: PRIVATE_DIR_MODE });
    await withLock(`${this.file}.lock`, async () => {
      const current = (await this.readOrNull()) ?? (await this.build('.', null));
      const entry: IndexedEntry = {
        hash: hashSecret(current.salt, value),
        name,
        source: 'canary',
        canary: true,
      };
      await this.write({ ...current, canaries: [...current.canaries, entry] });
    });
  }

  async stats(): Promise<SecretIndexStats> {
    const { index, corrupt } = await this.load();
    if (!index) {
      return {
        entries: 0,
        sources: 0,
        canaries: 0,
        builtAt: null,
        truncated: false,
        unreadable: 0,
        corrupt,
      };
    }
    return {
      entries: index.entries.length,
      sources: index.sources.length,
      canaries: index.canaries.length,
      builtAt: index.builtAt,
      truncated: index.truncated,
      unreadable: index.unreadable,
      corrupt: false,
    };
  }
}
