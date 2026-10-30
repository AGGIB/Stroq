import type { Dirent } from 'node:fs';
import { LEGACY_SURFACE_IO, type SurfaceReadContext } from './surface-io.js';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isGitExecKey } from '@stroq/core';
import { INSTALL_SCRIPT_NAMES } from './agent-editor.js';
import { hookOutcome } from './hook-outcome.js';
import type { Finding } from './findings.js';
import { plainHookHits } from './plain-hook-folders.js';
import { FILE_NAMES, foldName, gitDirName, looksLikeGitDir } from './git-dir-names.js';

/**
 * What a repository can make run on the machine that opens it.
 *
 * Two groups, and the difference between them is the whole design. `preTrust` is
 * execution the repository carries in its own metadata, which fires before anyone
 * approves anything: git runs the value of `core.fsmonitor` during an index refresh,
 * so an agent orienting itself with `git status` triggers it — the GitSpawn shape
 * (Manifold Security, 2026-09-01). Those are findings, because no ordinary checkout
 * has them and the key set is finite.
 *
 * `onOpen` is the ordinary kind: a husky hook, a `prepare` script, a devcontainer
 * that builds. Thousands of honest repositories carry those, so they are counted and
 * listed and never raised as a finding — `stroq exposure` exits 1 on any finding, and
 * a check that fails on every repository with a pre-commit hook is a check people
 * turn off.
 */
export interface RepoExecHit {
  readonly kind: RepoExecKind;
  /** Repository-relative, so the report never prints the user's home directory. */
  readonly file: string;
  /** The key, hook name or script this hit is about. */
  readonly what: string;
}

export type RepoExecKind =
  | 'git-config-exec'
  | 'git-config-include'
  | 'nested-bare-repo'
  | 'gitattributes-driver'
  | 'devcontainer-host-command'
  | 'git-hook-routine'
  | 'git-hook'
  | 'husky-hook'
  | 'devcontainer-command'
  | 'envrc'
  | 'package-install-script';

export const PRE_TRUST: ReadonlySet<RepoExecKind> = new Set([
  'git-config-exec',
  'git-config-include',
  'nested-bare-repo',
  'gitattributes-driver',
  'devcontainer-host-command',
  'git-hook-routine',
]);

export interface RepoSurface {
  readonly isRepo: boolean;
  readonly preTrust: readonly RepoExecHit[];
  readonly onOpen: readonly RepoExecHit[];
  /** True when the walk stopped at its cap, so `nested-bare-repo` is a lower bound. */
  readonly capped: boolean;
}

/** A repository is a working tree, not a corpus; this is generous for one. */
const MAX_DIRS = 4_000;
const MAX_CONFIG_BYTES = 256 * 1024;
/** Only `node_modules` is skipped: a bare repository under `vendor` or `build` runs as well. */
const SKIP_DIRS = new Set(['node_modules']);

const readTextOr = (
  file: string,
  fallback = '',
  io: SurfaceReadContext = LEGACY_SURFACE_IO,
): string => {
  try {
    const read = io.read(file, MAX_CONFIG_BYTES);
    return read.kind === 'text' ? read.text : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Parses git's INI into dotted keys, the way git reads it (see `parseGitConfig`): no tool's view of
 * the file but git's, and no shelling out to `git config`, which would read the repository's
 * configuration to read it.
 */
export function gitConfigEntries(text: string): readonly { key: string; value: string }[] {
  return parseGitConfig(text).entries;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isAlpha = (c: string): boolean => /^[A-Za-z]$/.test(c);
/** A character of a key or a section name as git takes it: a letter, a digit or `-`. */
const isKeyChar = (c: string): boolean => /^[A-Za-z0-9-]$/.test(c);

/** The escapes git takes in a value; any other one makes the file one git refuses. */
const VALUE_ESCAPES: Readonly<Record<string, string>> = {
  t: '\t',
  b: '\b',
  n: '\n',
  '\\': '\\',
  '"': '"',
};

/** A git config read one character at a time, with the line each one is on. */
class ConfigReader {
  private at: number;
  private line = 1;
  /** The line of the last character read. */
  lineOfLast = 1;
  constructor(private readonly text: string) {
    this.at = text.startsWith('\uFEFF') ? 1 : 0;
  }

  get done(): boolean {
    return this.at >= this.text.length;
  }

  /** The next character; `\r\n` and the end of the file read as a newline, as git reads them. */
  next(): string {
    this.lineOfLast = this.line;
    if (this.done) return '\n';
    let c = this.text[this.at] as string;
    this.at += 1;
    if (c === '\r' && this.text[this.at] === '\n') {
      c = '\n';
      this.at += 1;
    }
    if (c === '\n') this.line += 1;
    return c;
  }
}

/** A section header after its `[`: `[core]`, `[remote "a\"b"]`, `[a.b]`; undefined when git refuses it. */
function readSection(r: ConfigReader): string | undefined {
  let name = '';
  for (;;) {
    if (r.done) return undefined;
    let c = r.next();
    if (c === ']') return name === '' ? undefined : name;
    if (isSpace(c)) {
      // `[name "subsection"]`: blanks, a quoted name whose `\` takes the next character, then `]`.
      for (; isSpace(c); c = r.next()) if (c === '\n' || r.done) return undefined;
      if (c !== '"' || name === '') return undefined;
      let sub = '';
      for (;;) {
        c = r.next();
        if (c === '\n') return undefined;
        if (c === '"') break;
        if (c === '\\') {
          c = r.next();
          if (c === '\n') return undefined;
        }
        sub += c;
      }
      return r.next() === ']' ? `${name}.${sub}` : undefined;
    }
    if (!isKeyChar(c) && c !== '.') return undefined;
    name += c.toLowerCase();
  }
}

/** A value after its `=`, to the end of its line, as git reads it; undefined when git refuses it. */
function readValue(r: ConfigReader): string | undefined {
  let value = '';
  let quote = false;
  let comment = false;
  let blanks = 0;
  for (;;) {
    let c = r.next();
    if (c === '\n') return quote ? undefined : value;
    if (comment) continue;
    if (isSpace(c) && !quote) {
      if (value !== '') blanks += 1;
      continue;
    }
    if (!quote && (c === ';' || c === '#')) {
      comment = true;
      continue;
    }
    value += ' '.repeat(blanks);
    blanks = 0;
    if (c === '\\') {
      c = r.next();
      // A value goes on past the end of its line only here, never from a comment.
      if (c === '\n') continue;
      const escaped = VALUE_ESCAPES[c];
      if (escaped === undefined) return undefined;
      value += escaped;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
}

/**
 * The entries of a git config, read as git reads them: comments and blanks between entries, a
 * section header with a quoted subsection whose `\` takes the next character, a key on the line of
 * its section, a value with quotes, comments and escapes, continued past the end of its line only
 * by a `\` inside the value. Keys and plain section names are in lower case, as git takes them.
 *
 * Git refuses a whole file it cannot read, and runs none of it; a reader that is wrong about a line
 * would skip a key git runs. So the first line git would refuse ends the reading and is reported in
 * `unplaced`, with what was read before it.
 */
export function parseGitConfig(text: string): {
  readonly entries: readonly { key: string; value: string }[];
  readonly unplaced: readonly number[];
} {
  const entries: { key: string; value: string }[] = [];
  const r = new ConfigReader(text);
  const refused = () => ({ entries, unplaced: [r.lineOfLast] });
  let section: string | undefined;
  let comment = false;
  while (!r.done) {
    const c = r.next();
    if (c === '\n') {
      comment = false;
      continue;
    }
    if (comment || isSpace(c)) continue;
    if (c === '#' || c === ';') {
      comment = true;
      continue;
    }
    if (c === '[') {
      section = readSection(r);
      if (section === undefined) return refused();
      continue;
    }
    if (!isAlpha(c) || section === undefined) return refused();
    let name = c.toLowerCase();
    let d = r.next();
    for (; isKeyChar(d); d = r.next()) name += d.toLowerCase();
    while (d === ' ' || d === '\t') d = r.next();
    if (d === '\n') {
      entries.push({ key: `${section}.${name}`, value: 'true' });
      continue;
    }
    if (d !== '=') return refused();
    const value = readValue(r);
    if (value === undefined) return refused();
    entries.push({ key: `${section}.${name}`, value });
  }
  return { entries, unplaced: [] };
}

/** What a hit names for a line of a git config that could not be read. */
export const UNREAD_CONFIG_LINE = 'a line the check could not read';

/**
 * `core.fsmonitor = true` is git's own built-in file monitor and runs no command;
 * only a value naming a program does. Reporting the boolean would put a finding on
 * every developer who turned the feature on, which is how a check loses its meaning.
 */
const isBoolean = (value: string): boolean => /^(true|false|yes|no|on|off|1|0)$/i.test(value);

/** A git config's text; `missing` when there is none, `unread` when it is there and was not read. */
function configText(file: string, io: SurfaceReadContext): string | 'missing' | 'unread' {
  try {
    const read = io.read(file, MAX_CONFIG_BYTES);
    return read.kind === 'text' ? read.text : 'unread';
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? 'missing' : 'unread';
  }
}

/** The keys of a git config that run something, `label` being how the report names the file. */
function gitConfigHits(file: string, label: string, io: SurfaceReadContext): RepoExecHit[] {
  const hits: RepoExecHit[] = [];
  const text = configText(file, io);
  if (text === 'missing') return hits;
  // Too large, not a file, or not readable: what git reads from it is not known.
  if (text === 'unread')
    return [{ kind: 'git-config-exec', file: label, what: `${UNREAD_CONFIG_LINE} (the file)` }];
  const config = parseGitConfig(text);
  // At most one: each says the same, that the file must be read by eye.
  const line = config.unplaced[0];
  if (line !== undefined) io.parseGap?.(file);
  if (line !== undefined)
    hits.push({
      kind: 'git-config-exec',
      file: label,
      what: `${UNREAD_CONFIG_LINE} (line ${line})`,
    });
  for (const { key, value } of config.entries) {
    if (!isGitExecKey(key)) continue;
    if (/^core\.fsmonitor$/i.test(key) && isBoolean(value)) continue;
    const include = /^include(if)?\./i.test(key);
    if (include || (key === 'core.hookspath' && (isAbsolute(value) || /[~$`]/.test(value))))
      io.parseGap?.(file);
    hits.push({
      kind: include ? 'git-config-include' : 'git-config-exec',
      file: label,
      what: key,
    });
  }
  return hits;
}

/**
 * A driver named in an attributes file is only executable because a git config defines its
 * command: `.git/config` in a repository, the folder's own `config` when it is a bare one.
 */
function gitAttributesHits(
  root: string,
  configs: readonly string[],
  attributes: readonly string[],
  io: SurfaceReadContext,
): RepoExecHit[] {
  const defined = new Set(
    configs
      .flatMap((file) => gitConfigEntries(readTextOr(file, '', io)))
      .map((e) => e.key.replace(/\.(clean|smudge|process|textconv|command|driver)$/i, ''))
      .filter((k) => /^(filter|diff|merge)\./i.test(k)),
  );
  const hits: RepoExecHit[] = [];
  for (const file of attributes) {
    const drivers = new Set<string>();
    for (const m of readTextOr(file, '', io).matchAll(/(?:^|\s)(filter|diff|merge)=([\w.-]+)/g)) {
      drivers.add(`${m[1]}.${m[2]}`);
    }
    const label = labelOf(root, file, io);
    for (const what of drivers)
      if (defined.has(what)) hits.push({ kind: 'gitattributes-driver', file: label, what });
  }
  return hits;
}

/**
 * Whether git will run this hook file.
 *
 * On POSIX the executable bit answers it: git skips a hook it cannot execute, so a
 * leftover `pre-commit` with mode 0644 is a file nobody runs and reporting it would
 * be noise. Windows has no such bit — every file there stats as 0o666, or 0o444 when
 * read-only — and Git for Windows runs hooks anyway, through the `sh` it ships with.
 * Applying the POSIX test there does not mis-rank the hooks, it hides all of them:
 * the mask is zero for every file on the platform, so the check silently reports a
 * repository with no hooks at all. Existence is the honest test there, and it is
 * strictly narrower than the platform's own behaviour rather than a relaxation of
 * the POSIX one, which is untouched.
 */
function runsAsGitHook(file: string, plat: NodeJS.Platform, io: SurfaceReadContext): boolean {
  try {
    const stat = io.stat(file);
    if (!stat.isFile()) return false;
    return plat === 'win32' || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** What a hook file that could not be read as text holds: not known, so not ordinary either. */
const UNREAD_HOOK = '\u0000';

/**
 * A hook is ordinary only when it is one of the commit hooks, by its name as a forgiving disk
 * opens it, and its text was read and does not download and run code.
 */
function gitHookHit(dir: string, name: string, io: SurfaceReadContext): RepoExecHit {
  const file = io.label?.(join(dir, name)) ?? `.git/hooks/${name}`;
  const text = readTextOr(join(dir, name), UNREAD_HOOK, io);
  const outcome = hookOutcome(name, text === UNREAD_HOOK ? undefined : text);
  if (outcome === 'routine') return { kind: 'git-hook-routine', file, what: name };
  if (outcome === 'unsafe')
    return {
      kind: 'git-hook-routine',
      file,
      what: `${name}, whose text downloads and runs code, sends a secret out, or could not be read`,
    };
  return { kind: 'git-hook', file, what: name };
}

function gitHookHits(dir: string, plat: NodeJS.Platform, io: SurfaceReadContext): RepoExecHit[] {
  if (!io.exists(dir)) return [];
  try {
    return io
      .entries(dir)
      .map((entry) => entry.name)
      .filter((name) => !name.endsWith('.sample'))
      .filter((name) => runsAsGitHook(join(dir, name), plat, io))
      .map((name) => gitHookHit(dir, name, io));
  } catch {
    return [];
  }
}

/**
 * `initializeCommand` is the one that matters: it runs on the host, before the
 * container exists, so the isolation the rest of the file describes does not apply
 * to it. The others run inside the container and are ordinary build steps.
 */
const DEVCONTAINER_HOST_KEYS = ['initializeCommand'] as const;
const DEVCONTAINER_KEYS = [
  'onCreateCommand',
  'postCreateCommand',
  'postStartCommand',
  'postAttachCommand',
  'updateContentCommand',
] as const;

function devcontainerHits(root: string, io: SurfaceReadContext): RepoExecHit[] {
  const candidates = [
    join(root, '.devcontainer', 'devcontainer.json'),
    join(root, '.devcontainer.json'),
  ];
  const hits: RepoExecHit[] = [];
  for (const file of candidates) {
    const text = readTextOr(file, '', io);
    if (text === '') continue;
    // With `/` between the parts on every system, as every path this reports.
    const rel = labelOf(root, file, io);
    // Read as text rather than JSON: devcontainer.json is jsonc, comments and all,
    // and a parse failure must not hide the key it was looking for.
    for (const key of DEVCONTAINER_HOST_KEYS) {
      if (new RegExp(`"${key}"\\s*:`).test(text))
        hits.push({ kind: 'devcontainer-host-command', file: rel, what: key });
    }
    for (const key of DEVCONTAINER_KEYS) {
      if (new RegExp(`"${key}"\\s*:`).test(text))
        hits.push({ kind: 'devcontainer-command', file: rel, what: key });
    }
  }
  return hits;
}

/** The scripts of the folder's package.json, by name; none when it has none or does not parse. */
function packageScripts(root: string, io: SurfaceReadContext): Readonly<Record<string, unknown>> {
  const text = readTextOr(join(root, 'package.json'), '', io);
  if (text === '') return {};
  try {
    const scripts: unknown = (JSON.parse(text) as Record<string, unknown>)['scripts'];
    return typeof scripts === 'object' && scripts !== null
      ? (scripts as Record<string, unknown>)
      : {};
  } catch {
    io.parseGap?.(join(root, 'package.json'));
    return {};
  }
}

function packageScriptHits(root: string, io: SurfaceReadContext): RepoExecHit[] {
  const scripts = packageScripts(root, io);
  return INSTALL_SCRIPT_NAMES.filter((name) => Object.hasOwn(scripts, name)).map((what) => ({
    kind: 'package-install-script' as const,
    file: 'package.json',
    what,
  }));
}

function envrcHits(root: string, io: SurfaceReadContext): RepoExecHit[] {
  const file = join(root, '.envrc');
  const present = io.exists(file);
  if (present) io.capturePresence?.(file, MAX_CONFIG_BYTES);
  return present ? [{ kind: 'envrc', file: '.envrc', what: '.envrc' }] : [];
}

/** Why a file that only points git elsewhere is reported. */
const POINTS_ELSEWHERE = 'which points git at the folder of another repository';

/** A path under `root`, with `/` between its parts, for a report: `.` for `root` itself. */
const labelOf = (root: string, abs: string, io: SurfaceReadContext): string =>
  io.label?.(abs) ?? (relative(root, abs).split(sep).join('/') || '.');

/**
 * The commands of a folder git takes for a repository: its `config` and `config.worktree`, and,
 * when a `commondir` file names another folder, that folder's two as well. Git reads the config of
 * the folder `commondir` names; one that points out of `root` is reported, not read. Each is read
 * under every name it has on disk: `config` and `CONFIG` are two files on a disk that keeps case,
 * and the one a disk that folds case opens is not known.
 */
function gitDirConfigHits(
  root: string,
  dir: string,
  names: ReadonlyMap<string, readonly string[]>,
  io: SurfaceReadContext,
): RepoExecHit[] {
  const hits: RepoExecHit[] = [];
  const read = (folder: string, found: ReadonlyMap<string, readonly string[]>) => {
    for (const name of [...(found.get('config') ?? []), ...(found.get('config.worktree') ?? [])]) {
      const file = join(folder, name);
      hits.push(...gitConfigHits(file, labelOf(root, file, io), io));
    }
  };
  read(dir, names);
  for (const commondir of names.get('commondir') ?? []) {
    const target = readTextOr(join(dir, commondir), '', io).trim();
    if (target === '') continue;
    const common = resolve(dir, target);
    if (!isWithin(common, root)) {
      hits.push({
        kind: 'nested-bare-repo',
        file: labelOf(root, dir, io),
        what: 'its commondir file points out of this folder, at a config that was not read',
      });
      continue;
    }
    read(common, namesIn(common, io));
  }
  return hits;
}

/** Whether `path` is `root` or inside it: a child folder named `..x` is inside. */
const isWithin = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !isAbsolute(rel))
  );
};

/**
 * The names git looks for in a folder, folded as the most forgiving disk opens them, each with every
 * name it has on disk. A folder named `HEAD` or `commondir` is not what git looks for.
 */
function namesOf(entries: readonly Dirent[]): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const e of entries) {
    const name =
      gitDirName(e.name) ??
      (foldName(e.name) === 'config.worktree' ? 'config.worktree' : undefined);
    if (name === undefined || (e.isDirectory() && FILE_NAMES.has(name))) continue;
    const list = names.get(name);
    if (list === undefined) names.set(name, [e.name]);
    else list.push(e.name);
  }
  return names;
}

function namesIn(dir: string, io: SurfaceReadContext): Map<string, string[]> {
  try {
    return namesOf(io.entries(dir));
  } catch {
    return new Map();
  }
}

/**
 * A bare repository committed into an ordinary one as plain files. Git refuses to check out a path
 * named `.git`, but a bare repository needs only `HEAD`, `objects/` and `refs/`, or `HEAD` and a
 * `commondir` file, so it survives a clone — the vector behind CVE-2026-45033, and the one that
 * makes this class of attack deliverable by pull request rather than by zip. Each one is reported
 * with the commands its config runs, and so is a lone `commondir` or `gitdir` file, which only
 * points git elsewhere. In a folder with no `.git` (`folder`), a `.git` folder or file deeper in
 * came with the folder too, and is read and reported the same way.
 */
function nestedBareRepos(
  root: string,
  withRoot = false,
  folder = false,
  io: SurfaceReadContext = LEGACY_SURFACE_IO,
): { hits: RepoExecHit[]; capped: boolean } {
  const hits: RepoExecHit[] = [];
  const queue: string[] = [root];
  let visited = 0;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (visited >= MAX_DIRS) return { hits, capped: true };
    const dir = next;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = io
        .entries(dir)
        .filter((entry) => !io.skipDirectory?.(join(dir, entry.name)))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      continue;
    }
    // Links and other letter cases too: git opens `Objects` as `objects` on a disk that ignores case.
    const names = namesOf(entries);
    const isBare = looksLikeGitDir(new Set(names.keys()));
    if (isBare && (dir !== root || withRoot)) {
      hits.push({
        kind: 'nested-bare-repo',
        file: labelOf(root, dir, io),
        what: 'HEAD, objects, refs',
      });
      hits.push(...gitDirConfigHits(root, dir, names, io));
      // The root is walked on: what is under it is all this check reads.
      if (dir !== root) continue;
    }
    for (const entry of entries) {
      const folded = foldName(entry.name);
      const isDir = entry.isDirectory() && !entry.isSymbolicLink();
      if (!isBare && !isDir && (folded === 'commondir' || folded === 'gitdir'))
        hits.push({
          kind: 'nested-bare-repo',
          file: labelOf(root, join(dir, entry.name), io),
          what: `a ${folded} file, ${POINTS_ELSEWHERE}`,
        });
      // The repository's own is not read here; in a folder with no `.git`, one deeper in came with it.
      // In a repository, one deeper in (a nested clone, a submodule's `.git` file) was made on this
      // machine, as git checks none out; it is not read either, and a capture records that it was not.
      if (!folder && folded === '.git' && (entry.name === '.git' || !isDir)) {
        if (dir !== root) io.nestedRepository?.(join(dir, entry.name));
        continue;
      }
      if (folder && folded === '.git') {
        if (!isDir)
          hits.push({
            kind: 'nested-bare-repo',
            file: labelOf(root, join(dir, entry.name), io),
            what: `a .git file, ${POINTS_ELSEWHERE}`,
          });
        else queue.push(join(dir, entry.name));
        continue;
      }
      if (!isDir || SKIP_DIRS.has(entry.name)) continue;
      queue.push(join(dir, entry.name));
    }
  }
  return { hits, capped: false };
}

const split = (all: readonly RepoExecHit[], capped: boolean, isRepo: boolean): RepoSurface => ({
  isRepo,
  preTrust: all.filter((h) => PRE_TRUST.has(h.kind)),
  onOpen: all.filter((h) => !PRE_TRUST.has(h.kind)),
  capped,
});

/**
 * What the files of a folder make run whether or not it is a repository: husky hooks, dev
 * container commands, a `.envrc`, install scripts. Both a repository and a plain folder read these.
 */
const workingTreeHits = (
  root: string,
  hooksPaths: readonly string[] = [],
  io: SurfaceReadContext = LEGACY_SURFACE_IO,
): RepoExecHit[] => [
  ...plainHookHits(root, hooksPaths, packageScripts(root, io), io),
  ...devcontainerHits(root, io),
  ...envrcHits(root, io),
  ...packageScriptHits(root, io),
];

/** Existing callers keep legacy IO; capture callers supply a bound metadata layout. */
export function repoSurface(
  cwd: string,
  plat: NodeJS.Platform = process.platform,
  io: SurfaceReadContext = LEGACY_SURFACE_IO,
): RepoSurface {
  if (
    io.gitMetadata?.isRepo === false ||
    (io.gitMetadata === undefined && !io.exists(join(cwd, '.git')))
  )
    return { isRepo: false, preTrust: [], onOpen: [], capped: false };
  const bare = nestedBareRepos(cwd, false, false, io);
  const configs = io.gitMetadata?.configs ?? [join(cwd, '.git', 'config')];
  const hooks =
    io.gitMetadata?.hooks === undefined ? join(cwd, '.git', 'hooks') : io.gitMetadata.hooks;
  const attributes = io.gitMetadata?.attributes ?? [
    join(cwd, '.gitattributes'),
    join(cwd, '.git', 'info', 'attributes'),
  ];
  const all = [
    ...configs.flatMap((config) => gitConfigHits(config, labelOf(cwd, config, io), io)),
    ...gitAttributesHits(cwd, configs, attributes, io),
    ...bare.hits,
    ...(hooks === null ? [] : gitHookHits(hooks, plat, io)),
    ...workingTreeHits(
      cwd,
      configs.flatMap((config) =>
        parseGitConfig(readTextOr(config, '', io))
          .entries.filter((e) => e.key === 'core.hookspath')
          .map((e) => e.value),
      ),
      io,
    ),
  ];
  return split(all, bare.capped, true);
}

/** A plain folder retains the same shared execution-surface detectors. */
export function folderSurface(
  cwd: string,
  io: SurfaceReadContext = LEGACY_SURFACE_IO,
): RepoSurface {
  const bare = nestedBareRepos(cwd, true, true, io);
  const rootIsBare = bare.hits.some((h) => h.file === '.' && h.what === 'HEAD, objects, refs');
  const attributes = rootIsBare
    ? gitAttributesHits(
        cwd,
        [join(cwd, 'config'), join(cwd, 'config.worktree')],
        [join(cwd, '.gitattributes'), join(cwd, 'info', 'attributes')],
        io,
      )
    : [];
  return split([...bare.hits, ...attributes, ...workingTreeHits(cwd, [], io)], bare.capped, false);
}

/** Why each kind of pre-trust execution is a finding; also the SARIF rule text. */
export const WHY: Readonly<Record<string, string>> = {
  'git-config-exec':
    'this repository sets a git configuration key whose value git runs as a command, which happens during an ordinary index refresh — an agent typing `git status` triggers it, before any approval',
  'git-config-include':
    'this repository points git at another configuration file, which can set the keys above from outside the checkout',
  'nested-bare-repo':
    'a bare repository is committed here as plain files, which survives a clone and can carry its own executable configuration',
  'gitattributes-driver':
    'a path in this repository is routed through a driver whose command is defined in its own git configuration',
  'devcontainer-host-command':
    'initializeCommand runs on this machine before the container exists, so the container gives it no isolation',
  'git-hook-routine':
    'git runs this hook during routine use (a `git status` or `git add`, a checkout, a fetch, a merge, any ref update), which an agent does by itself, before any approval; a commit hook is here when its text downloads and runs code, and any other file here may be one a hook sources',
};

export function repoFindings(surface: RepoSurface): readonly Finding[] {
  return surface.preTrust.map((hit) => ({
    class: 'repo-exec-surface' as const,
    severity: 'critical' as const,
    detail: `${hit.file} — ${hit.what}: ${WHY[hit.kind] ?? 'repository-supplied execution'}`,
    fix: hit.what.startsWith(UNREAD_CONFIG_LINE)
      ? `read ${hit.file} in a text editor, not with git, which may run what it names, and remove that line if you did not write it`
      : hit.kind === 'git-hook-routine'
        ? `read ${hit.file} in a text editor and delete it if you did not install it, before you run any git command here`
        : hit.kind !== 'nested-bare-repo'
          ? `git config --get ${hit.what} — and remove it if you did not set it`
          : hit.file === '.'
            ? 'this folder is itself a bare repository: clone it into a new folder and open the clone, which leaves its config behind'
            : `inspect and remove ${hit.file} before opening this repository with an agent`,
  }));
}
