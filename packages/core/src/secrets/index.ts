import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SecretHit, SecretMatch } from '../types.js';
import { withLock } from '../util/lock.js';
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
}

export interface SecretIndex {
  /** Matches among `candidates`, deduped by name+source. No I/O when `candidates` is empty. */
  lookup(candidates: readonly string[], cwd: string): Promise<SecretMatch[]>;
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
  readonly version: 1;
  readonly salt: string;
  readonly builtAt: string;
  readonly sources: readonly IndexedSource[];
  readonly entries: readonly IndexedEntry[];
  readonly canaries: readonly IndexedEntry[];
}

/** Sources larger than this contribute nothing (credential files are tiny). */
export const MAX_SOURCE_BYTES = 262_144;
/** Newest entries beyond this many are dropped. */
export const MAX_ENTRIES = 2000;
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

function projectEnvFiles(cwd: string): string[] {
  try {
    return readdirSync(cwd)
      .filter((f) => PROJECT_ENV.test(f) && !EXAMPLE_ENV.test(f))
      .sort()
      .map((f) => join(cwd, f));
  } catch {
    return [];
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

  private sources(cwd: string): IndexedSource[] {
    const homeFiles = HOME_SOURCES.map((rel) => join(this.home, rel));
    return statSources([...homeFiles, ...projectEnvFiles(cwd)]);
  }

  private async read(): Promise<IndexFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`corrupt secret index: ${this.file}`, { cause: err });
    }
    const index = parsed as IndexFile | null;
    if (!index || typeof index !== 'object' || Array.isArray(index) || index.version !== 1) {
      throw new Error(`corrupt secret index: ${this.file}`);
    }
    return index;
  }

  private async write(index: IndexFile): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(index), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tmp, this.file);
  }

  private async entriesFrom(
    sources: readonly IndexedSource[],
    salt: string,
  ): Promise<IndexedEntry[]> {
    const lists = await Promise.all(
      sources.map(async (source) => {
        try {
          const text = await readFile(source.path, 'utf8');
          const display = displayPath(source.path, this.home);
          return extractFor(source.path, text).map((s) => ({
            hash: hashSecret(salt, s.value),
            name: s.name,
            source: display,
            canary: s.canary,
          }));
        } catch {
          return [];
        }
      }),
    );
    return lists.flat().slice(0, MAX_ENTRIES);
  }

  private async build(cwd: string, previous: IndexFile | null): Promise<IndexFile> {
    const salt = previous?.salt ?? randomBytes(16).toString('hex');
    const sources = this.sources(cwd);
    return {
      version: 1,
      salt,
      builtAt: this.now().toISOString(),
      sources,
      entries: await this.entriesFrom(sources, salt),
      canaries: previous?.canaries ?? [],
    };
  }

  /** Returns a current index, rebuilding (under the lock) when any source changed. */
  private async ensure(cwd: string): Promise<IndexFile> {
    const previous = await this.read();
    if (previous && sameSources(previous.sources, this.sources(cwd))) return previous;
    await mkdir(join(this.file, '..'), { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file}.lock`, async () => {
      const latest = await this.read();
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

  async lookup(candidates: readonly string[], cwd: string): Promise<SecretMatch[]> {
    if (candidates.length === 0) return [];
    const index = await this.ensure(cwd);
    const byHash = new Map<string, IndexedEntry>();
    for (const entry of [...index.entries, ...index.canaries, ...this.liveEntries(index.salt)]) {
      if (!byHash.has(entry.hash)) byHash.set(entry.hash, entry);
    }
    const seen = new Set<string>();
    const hits: SecretMatch[] = [];
    for (const token of candidates) {
      const entry = byHash.get(hashSecret(index.salt, token));
      if (!entry) continue;
      const key = `${entry.name}\n${entry.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ name: entry.name, source: entry.source, canary: entry.canary, token });
    }
    return hits;
  }

  async addCanary(value: string, name = 'STROQ_CANARY_KEY'): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true, mode: PRIVATE_DIR_MODE });
    await withLock(`${this.file}.lock`, async () => {
      const current = (await this.read()) ?? (await this.build('.', null));
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
    const index = await this.read();
    if (!index) return { entries: 0, sources: 0, canaries: 0, builtAt: null };
    return {
      entries: index.entries.length,
      sources: index.sources.length,
      canaries: index.canaries.length,
      builtAt: index.builtAt,
    };
  }
}
