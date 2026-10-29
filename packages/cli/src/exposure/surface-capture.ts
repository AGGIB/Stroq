import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import type { RegularFileRead } from '@stroq/core';
import { foldName, gitDirName } from './git-dir-names.js';
import type { SurfaceReadContext } from './surface-io.js';
import {
  surfaceHash,
  surfacePin,
  surfaceWithin,
  same,
  absent,
  failure,
  type SurfaceObservation,
  type SurfaceSource,
  type SurfaceExclusion,
  type SurfaceDependency,
  type SurfaceBinding,
  type SurfaceLimits,
  type SurfaceRole,
  type SurfaceGapCode,
} from './surface-binding.js';
export * from './surface-binding.js';

/** Captured bytes are cached only for the duration of one bounded detector pass. */
export class SurfaceCapture implements SurfaceReadContext {
  readonly observations: SurfaceObservation[] = [];
  readonly sources: SurfaceSource[] = [];
  readonly exclusions: SurfaceExclusion[] = [];
  private readonly ignored = new Set<string>();
  gitMetadata?: NonNullable<SurfaceReadContext['gitMetadata']>;
  private readonly dependencies = new Map<string, SurfaceDependency>();
  private readonly texts = new Map<string, { text: string; size: number }>();
  private readonly external = new Map<
    string,
    { label: string; files: readonly string[]; hooks: boolean }
  >();
  private readonly directoryCache = new Map<string, Dirent[]>();
  private bytes = 0;
  private directories = 0;
  private entriesRead = 0;
  readonly root: string;
  readonly limits: Required<SurfaceLimits>;
  stableDigest = (text: string): string => `sha256:${surfaceHash(text)}`;
  constructor(
    project: string,
    limits: SurfaceLimits = {},
    private readonly deadline = Date.now() + 15_000,
    ignoredRoots: readonly string[] = [],
  ) {
    this.root = realpathSync(project);
    const ceilings = {
      maxBytes: 8 * 1024 * 1024,
      maxFiles: 1024,
      maxDirectories: 8_000,
      maxEntries: 100_000,
      maxObservations: 256,
    };
    this.limits = { ...ceilings, ...limits };
    for (const key of Object.keys(ceilings) as (keyof SurfaceLimits)[]) {
      const value = this.limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key])
        throw failure('invalid-limits');
    }
    if (!Number.isSafeInteger(deadline) || ignoredRoots.length > 16)
      throw failure('invalid-limits');
    const root = lstatSync(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw failure('unsafe-root');
    this.track(this.root, 'stat', root);
    for (const selected of ignoredRoots) {
      let ancestor = resolve(selected);
      const missing: string[] = [];
      for (;;) {
        try {
          ancestor = realpathSync(ancestor);
          break;
        } catch (error) {
          if (!absent(error) || dirname(ancestor) === ancestor)
            throw failure('context-unavailable');
          missing.unshift(basename(ancestor));
          ancestor = dirname(ancestor);
        }
      }
      const canonical = resolve(ancestor, ...missing);
      if (surfaceWithin(canonical, this.root)) throw failure('context-unavailable');
      if (!surfaceWithin(this.root, canonical)) continue;
      if (missing.length === 0 && !lstatSync(canonical).isDirectory())
        throw failure('context-unavailable');
      this.ignored.add(canonical);
      const path = relative(this.root, canonical).split(sep).join('/');
      this.exclusions.push({ reason: 'stroq-data', path, sha256: surfaceHash(path) });
    }
    this.exclusions.sort((a, b) => a.path.localeCompare(b.path));
  }
  skipDirectory = (path: string): boolean =>
    [...this.ignored].some((root) => surfaceWithin(root, resolve(path)));
  allowMetadata(root: string, label: string, files: readonly string[], hooks = false): void {
    this.external.set(root, { label, files, hooks });
  }
  private allowed(path: string): boolean {
    if (this.skipDirectory(path)) return false;
    if (surfaceWithin(this.root, path)) return true;
    for (const [root, access] of this.external) {
      const rel = relative(root, path).split(sep).join('/');
      if (
        rel === '' ||
        access.files.some((file) => file === rel || file.startsWith(`${rel}/`)) ||
        (access.hooks && (rel === 'hooks' || /^hooks\/[^/]+$/.test(rel)))
      )
        return true;
    }
    return false;
  }
  describe(path: string): { path: string; role: SurfaceRole } {
    const absolute = resolve(path);
    for (const [root, access] of [...this.external].sort(([a], [b]) => b.length - a.length))
      if (surfaceWithin(root, absolute))
        return {
          role: 'git-metadata',
          path: `${access.label}${absolute === root ? '' : `/${relative(root, absolute).split(sep).join('/')}`}`,
        };
    return {
      role: 'workspace',
      path: surfaceWithin(this.root, absolute)
        ? relative(this.root, absolute).split(sep).join('/') || '.'
        : 'outside-workspace',
    };
  }
  label = (path: string): string => {
    const item = this.describe(path);
    return item.role === 'workspace' ? item.path : `git-metadata/${item.path}`;
  };
  gap(code: SurfaceGapCode, path: string): void {
    const observation = { code, ...this.describe(path) };
    if (this.observations.some((old) => same(old, observation))) return;
    if (this.observations.length >= this.limits.maxObservations) {
      if (!this.observations.some((old) => old.code === 'limit' && old.path === '.'))
        this.observations[this.observations.length - 1] = {
          code: 'limit',
          path: '.',
          role: 'workspace',
        };
      return;
    }
    this.observations.push(observation);
  }
  parseGap = (path: string): void => {
    this.gap('unparsed', path);
  };
  nestedRepository = (path: string): void => {
    this.gap('nested-repository', path);
  };
  /**
   * Whether anything is at `path`, which is outside the workspace, from its own entry: it is neither
   * opened nor followed. The answer is bound like any other dependency, so a later change there makes
   * the capture stale, and an answer the disk would not give counts as something there.
   */
  presentOutside = (path: string): boolean => {
    try {
      this.track(path, 'stat', lstatSync(path));
      return true;
    } catch (error) {
      if (!absent(error)) return true;
      this.track(path, 'stat', null);
      return false;
    }
  };
  private check(path: string, followFinal = true): string {
    if (Date.now() > this.deadline) {
      this.gap('limit', path);
      throw failure('ETIMEDOUT');
    }
    const absolute = resolve(path);
    const permitted = this.allowed(absolute);
    if (!permitted) {
      this.gap('outside-root', absolute);
      throw failure('EACCES');
    }
    // Resolve existing ancestors individually so a new link cannot escape between discovery and read.
    const allowedRoot =
      [...this.external.keys()]
        .filter((root) => surfaceWithin(root, absolute))
        .sort((a, b) => b.length - a.length)[0] ?? this.root;
    const parts = relative(allowedRoot, absolute).split(sep).filter(Boolean);
    let current = allowedRoot;
    for (let i = 0; i < parts.length; i += 1) {
      current = resolve(current, parts[i]!);
      let stat: Stats;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (absent(error)) {
          this.track(current, 'stat', null);
          return absolute;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        if ([...this.external.keys()].some((root) => surfaceWithin(root, current))) {
          this.gap('git-metadata-unverified', current);
          throw failure('EACCES');
        }
        if (!followFinal && i === parts.length - 1) {
          this.track(current, 'link', stat, { target: readlinkSync(current) });
          continue;
        }
        const target = realpathSync(current);
        this.track(current, 'link', stat, { target: readlinkSync(current) });
        if (!this.allowed(target)) {
          this.gap('outside-root', current);
          throw failure('EACCES');
        }
      } else if (i < parts.length - 1) this.track(current, 'stat', stat);
    }
    return absolute;
  }
  private track(
    path: string,
    kind: SurfaceDependency['kind'],
    stat: Stats | null,
    extra: Partial<SurfaceDependency> = {},
  ): void {
    const key = `${kind}\0${path}`;
    const item = { path, kind, pin: stat === null ? null : surfacePin(stat), ...extra };
    const before = this.dependencies.get(key);
    if (before !== undefined && !same(before, item)) {
      this.gap('source-changed', path);
      throw failure('ESTALE');
    }
    this.dependencies.set(key, item);
  }
  private failed(path: string, error: unknown): never {
    if (
      !absent(error) &&
      !['ESTALE', 'ETIMEDOUT', 'E2BIG', 'EILSEQ'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      this.gap('unreadable', path);
    if (absent(error)) {
      try {
        this.track(path, 'stat', lstatSync(path));
      } catch (probe) {
        if (absent(probe)) this.track(path, 'stat', null);
        else throw probe;
      }
    }
    throw error;
  }
  exists = (path: string): boolean => {
    try {
      this.lstat(path);
      return true;
    } catch {
      return false;
    }
  };
  lstat = (path: string): Stats => {
    try {
      const absolute = this.check(path, false);
      const stat = lstatSync(absolute);
      if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
        this.gap('not-regular', path);
      this.track(absolute, 'stat', stat);
      return stat;
    } catch (error) {
      return this.failed(path, error);
    }
  };
  stat = (path: string): Stats => {
    const real = this.realpath(path);
    return this.lstat(real);
  };
  realpath = (path: string): string => {
    try {
      const absolute = this.check(path, false);
      const real = realpathSync(absolute);
      this.track(absolute, 'stat', lstatSync(absolute));
      return real;
    } catch (error) {
      return this.failed(path, error);
    }
  };
  readlink = (path: string): string => {
    try {
      const absolute = this.check(path, false);
      const target = readlinkSync(absolute);
      this.track(absolute, 'link', lstatSync(absolute), { target });
      return target;
    } catch (error) {
      return this.failed(path, error);
    }
  };
  entries = (path: string): Dirent[] => {
    try {
      const absolute = this.check(this.realpath(path));
      const cached = this.directoryCache.get(absolute);
      if (cached !== undefined) return [...cached];
      if (++this.directories > this.limits.maxDirectories) {
        this.gap('limit', path);
        throw failure('E2BIG');
      }
      const before = lstatSync(absolute);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        this.gap('not-regular', path);
        throw failure('EACCES');
      }
      const handle = opendirSync(absolute);
      const entries: Dirent[] = [];
      let listingComplete = true;
      try {
        for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
          if (++this.entriesRead > this.limits.maxEntries) {
            this.gap('limit', path);
            listingComplete = false;
            break;
          }
          entries.push(entry);
        }
      } finally {
        handle.closeSync();
      }
      const after = lstatSync(absolute);
      if (!same(surfacePin(before), surfacePin(after))) {
        this.gap('source-changed', path);
        throw failure('ESTALE');
      }
      const namesSha256 = surfaceHash(
        JSON.stringify(
          entries
            .map((entry) => [
              entry.name,
              entry.isDirectory(),
              entry.isFile(),
              entry.isSymbolicLink(),
            ])
            .sort(),
        ),
      );
      this.track(absolute, 'directory', after, {
        namesSha256,
        entryCount: entries.length,
        listingComplete,
      });
      this.directoryCache.set(absolute, entries);
      return [...entries];
    } catch (error) {
      return this.failed(path, error);
    }
  };
  read = (path: string, maxBytes: number): RegularFileRead => {
    let fd: number | undefined;
    try {
      const absolute = this.check(this.realpath(path));
      const cached = this.texts.get(absolute);
      if (cached !== undefined) {
        if (cached.size > maxBytes) {
          this.gap('too-large', path);
          return { kind: 'too-large', size: cached.size };
        }
        return { kind: 'text', ...cached };
      }
      fd = openSync(
        absolute,
        constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1) {
        this.gap('not-regular', path);
        return { kind: 'not-regular' };
      }
      if (
        this.describe(path).role === 'git-metadata' &&
        process.getuid !== undefined &&
        before.uid !== process.getuid()
      ) {
        this.gap('git-metadata-unverified', path);
        throw failure('EACCES');
      }
      if (before.size > maxBytes) {
        this.track(absolute, 'file', before);
        this.gap('too-large', path);
        return { kind: 'too-large', size: before.size };
      }
      if (
        this.bytes + before.size > this.limits.maxBytes ||
        this.sources.length >= this.limits.maxFiles
      ) {
        this.gap('limit', path);
        throw failure('E2BIG');
      }
      const bytes = Buffer.alloc(before.size);
      let filled = 0;
      while (filled < bytes.length) {
        const got = readSync(fd, bytes, filled, bytes.length - filled, filled);
        if (got === 0) break;
        filled += got;
      }
      const extra = Buffer.alloc(1);
      const overflow = readSync(fd, extra, 0, 1, filled);
      const after = fstatSync(fd);
      if (
        filled !== bytes.length ||
        overflow !== 0 ||
        !same(surfacePin(before), surfacePin(after)) ||
        !same(surfacePin(after), surfacePin(lstatSync(absolute)))
      ) {
        this.gap('source-changed', path);
        throw failure('ESTALE');
      }
      const sha256 = surfaceHash(bytes);
      this.track(absolute, 'file', after, { sha256 });
      this.bytes += bytes.length;
      this.sources.push({ kind: 'file', ...this.describe(path), sha256, mode: after.mode & 0o777 });
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        this.gap('invalid-utf8', path);
        throw failure('EILSEQ');
      }
      const result = { text, size: filled };
      this.texts.set(absolute, result);
      return { kind: 'text', ...result };
    } catch (error) {
      return this.failed(path, error);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  capturePresence = (path: string, maxBytes: number): void => {
    try {
      this.read(path, maxBytes);
    } catch {
      /* gap already recorded */
    }
  };
  captureStructure(path: string): void {
    const location = this.describe(path);
    if (
      this.sources.some((source) => source.path === location.path && source.role === location.role)
    )
      return;
    try {
      if (this.sources.length >= this.limits.maxFiles) {
        this.gap('limit', path);
        return;
      }
      const stat = this.lstat(path);
      if (stat.isSymbolicLink()) {
        this.sources.push({
          kind: 'link',
          ...location,
          sha256: surfaceHash(this.readlink(path)),
          mode: stat.mode & 0o777,
        });
        return;
      }
      if (stat.isDirectory()) {
        const shape = this.entries(path)
          .filter(
            (entry) =>
              gitDirName(entry.name) !== undefined || foldName(entry.name) === 'config.worktree',
          )
          .map((entry) => [entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()])
          .sort();
        this.sources.push({
          kind: 'directory',
          ...location,
          sha256: surfaceHash(JSON.stringify(shape)),
          mode: stat.mode & 0o777,
        });
        return;
      }
      this.capturePresence(path, 1024 * 1024);
    } catch {
      /* observed refusal remains a gap */
    }
  }
  binding(): SurfaceBinding {
    const dependencies = [...this.dependencies.values()].sort((a, b) =>
      `${a.path}\0${a.kind}`.localeCompare(`${b.path}\0${b.kind}`),
    );
    return {
      version: 1,
      root: this.root,
      dependencies,
      sha256: surfaceHash(JSON.stringify(dependencies)),
    };
  }
}
