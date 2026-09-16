import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isGitExecKey } from '@stroq/core';
import type { Finding } from './findings.js';

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
  | 'git-hook'
  | 'husky-hook'
  | 'devcontainer-command'
  | 'envrc'
  | 'package-install-script';

const PRE_TRUST: ReadonlySet<RepoExecKind> = new Set([
  'git-config-exec',
  'git-config-include',
  'nested-bare-repo',
  'gitattributes-driver',
  'devcontainer-host-command',
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
const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', 'vendor', 'target', 'dist', 'build']);

const readTextOr = (file: string, fallback = ''): string => {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return fallback;
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
};

/**
 * Parses git's INI into dotted keys. Git's own parser accepts more than this — line
 * continuations, quoting rules — but a key this misses is a key `.git/config` sets in
 * a shape no tool writes, and the alternative is shelling out to `git config`, which
 * would execute the repository's configuration to read it.
 */
export function gitConfigEntries(text: string): readonly { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const inner = header[1] ?? '';
      const named = /^(\S+)\s+"(.*)"$/.exec(inner);
      section = named ? `${named[1]}.${named[2]}` : inner.replace(/\s+/g, '.');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || section === '') continue;
    out.push({
      key: `${section}.${line.slice(0, eq).trim()}`,
      value: line
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1'),
    });
  }
  return out;
}

/**
 * `core.fsmonitor = true` is git's own built-in file monitor and runs no command;
 * only a value naming a program does. Reporting the boolean would put a finding on
 * every developer who turned the feature on, which is how a check loses its meaning.
 */
const isBoolean = (value: string): boolean => /^(true|false|yes|no|on|off|1|0)$/i.test(value);

function gitConfigHits(root: string): RepoExecHit[] {
  const file = join(root, '.git', 'config');
  const hits: RepoExecHit[] = [];
  for (const { key, value } of gitConfigEntries(readTextOr(file))) {
    if (!isGitExecKey(key)) continue;
    if (/^core\.fsmonitor$/i.test(key) && isBoolean(value)) continue;
    const include = /^include(if)?\./i.test(key);
    hits.push({
      kind: include ? 'git-config-include' : 'git-config-exec',
      file: '.git/config',
      what: key,
    });
  }
  return hits;
}

/** A driver named here is only executable because `.git/config` defines its command. */
function gitAttributesHits(root: string): RepoExecHit[] {
  const text = readTextOr(join(root, '.gitattributes'));
  const drivers = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)(filter|diff|merge)=([\w.-]+)/g)) {
    drivers.add(`${m[1]}.${m[2]}`);
  }
  const defined = new Set(
    gitConfigEntries(readTextOr(join(root, '.git', 'config')))
      .map((e) => e.key.replace(/\.(clean|smudge|process|textconv|command|driver)$/i, ''))
      .filter((k) => /^(filter|diff|merge)\./i.test(k)),
  );
  return [...drivers]
    .filter((d) => defined.has(d))
    .map((what) => ({ kind: 'gitattributes-driver' as const, file: '.gitattributes', what }));
}

function gitHookHits(root: string): RepoExecHit[] {
  const dir = join(root, '.git', 'hooks');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => !name.endsWith('.sample'))
      .filter((name) => {
        try {
          const stat = statSync(join(dir, name));
          return stat.isFile() && (stat.mode & 0o111) !== 0;
        } catch {
          return false;
        }
      })
      .map((what) => ({ kind: 'git-hook' as const, file: `.git/hooks/${what}`, what }));
  } catch {
    return [];
  }
}

function huskyHits(root: string): RepoExecHit[] {
  const dir = join(root, '.husky');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .map((what) => ({ kind: 'husky-hook' as const, file: `.husky/${what}`, what }));
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

function devcontainerHits(root: string): RepoExecHit[] {
  const candidates = [
    join(root, '.devcontainer', 'devcontainer.json'),
    join(root, '.devcontainer.json'),
  ];
  const hits: RepoExecHit[] = [];
  for (const file of candidates) {
    const text = readTextOr(file);
    if (text === '') continue;
    const rel = relative(root, file);
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

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'] as const;

function packageScriptHits(root: string): RepoExecHit[] {
  const text = readTextOr(join(root, 'package.json'));
  if (text === '') return [];
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as Record<string, unknown>)['scripts'];
  } catch {
    return [];
  }
  if (typeof scripts !== 'object' || scripts === null) return [];
  return INSTALL_SCRIPTS.filter((name) => name in (scripts as Record<string, unknown>)).map(
    (what) => ({ kind: 'package-install-script' as const, file: 'package.json', what }),
  );
}

function envrcHits(root: string): RepoExecHit[] {
  return existsSync(join(root, '.envrc'))
    ? [{ kind: 'envrc', file: '.envrc', what: '.envrc' }]
    : [];
}

/**
 * A bare repository committed into an ordinary one as plain files. Git refuses to
 * check out a path named `.git`, but a bare repository needs only `HEAD`, `objects/`
 * and `refs/`, so it survives a clone — the vector behind CVE-2026-45033, and the one
 * that makes this class of attack deliverable by pull request rather than by zip.
 */
function nestedBareRepos(root: string): { hits: RepoExecHit[]; capped: boolean } {
  const hits: RepoExecHit[] = [];
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0) {
    if (visited >= MAX_DIRS) return { hits, capped: true };
    const dir = queue.shift() as string;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map((e) => e.name));
    if (dir !== root && names.has('HEAD') && names.has('objects') && names.has('refs')) {
      hits.push({
        kind: 'nested-bare-repo',
        file: relative(root, dir),
        what: 'HEAD, objects, refs',
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.git' || SKIP_DIRS.has(entry.name)) continue;
      queue.push(join(dir, entry.name));
    }
  }
  return { hits, capped: false };
}

export function repoSurface(cwd: string): RepoSurface {
  if (!existsSync(join(cwd, '.git'))) {
    return { isRepo: false, preTrust: [], onOpen: [], capped: false };
  }
  const bare = nestedBareRepos(cwd);
  const all = [
    ...gitConfigHits(cwd),
    ...gitAttributesHits(cwd),
    ...bare.hits,
    ...gitHookHits(cwd),
    ...huskyHits(cwd),
    ...devcontainerHits(cwd),
    ...envrcHits(cwd),
    ...packageScriptHits(cwd),
  ];
  return {
    isRepo: true,
    preTrust: all.filter((h) => PRE_TRUST.has(h.kind)),
    onOpen: all.filter((h) => !PRE_TRUST.has(h.kind)),
    capped: bare.capped,
  };
}

const WHY: Readonly<Record<string, string>> = {
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
};

export function repoFindings(surface: RepoSurface): readonly Finding[] {
  return surface.preTrust.map((hit) => ({
    class: 'repo-exec-surface' as const,
    severity: 'critical' as const,
    detail: `${hit.file} — ${hit.what}: ${WHY[hit.kind] ?? 'repository-supplied execution'}`,
    fix:
      hit.kind === 'nested-bare-repo'
        ? `inspect and remove ${hit.file} before opening this repository with an agent`
        : `git config --get ${hit.what} — and remove it if you did not set it`,
  }));
}
