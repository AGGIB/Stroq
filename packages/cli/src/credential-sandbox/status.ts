import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { linkedGit } from '../exposure/linked-git.js';
import { LEGACY_SURFACE_IO } from '../exposure/surface-io.js';
import { claudeConfigDirProblem, claudeUserDir } from '../paths.js';
import { readTargetStrict } from '../harden/read.js';
import { parseJsonDocument } from '../harden/json-doc.js';
import { linkedPath } from './links.js';
import { KEY_PATHS, RETRY_RULE, type KeyPath } from './rules.js';

export interface SandboxLocation {
  readonly home: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly managedDir?: string;
}

export function hasClaudeSettings(where: SandboxLocation): boolean {
  // A settings folder that cannot be named is reported, not passed over.
  if (claudeConfigDirProblem(where.env) !== null) return true;
  return existsSync(claudeUserDir(where.home, where.env)) || existsSync(join(where.cwd, '.claude'));
}

export function readSettingsObject(file: string) {
  const text = readTargetStrict(file);
  if (text === null) return {};
  const parsed = parseJsonDocument(text);
  if (!parsed.ok || !text.trim()) throw new Error('Unreadable agent settings');
  return parsed.doc;
}

const strings = z.array(z.string()).optional();
const schema = z.object({
  sandbox: z
    .object({
      enabled: z.boolean().optional(),
      allowUnsandboxedCommands: z.boolean().optional(),
      filesystem: z
        .object({
          disabled: z.boolean().optional(),
          allowRead: strings,
          allowWrite: strings,
          denyRead: strings,
          allowManagedReadPathsOnly: z.boolean().optional(),
        })
        .optional(),
      credentials: z
        .object({
          files: z.array(z.object({ path: z.string(), mode: z.enum(['deny', 'mask']) })).optional(),
        })
        .optional(),
      excludedCommands: strings,
      network: z.object({ allowManagedDomainsOnly: z.boolean().optional() }).optional(),
    })
    .optional(),
  permissions: z
    .object({ ask: strings, deny: strings, allow: strings, additionalDirectories: strings })
    .optional(),
  allowManagedPermissionRulesOnly: z.boolean().optional(),
});

type Scope = 'user' | 'project' | 'local' | 'managed';
/** A listed key path that is a link whose real place is not listed. Null: the link leads nowhere. */
export interface UnlistedLink {
  readonly path: KeyPath;
  readonly target: string | null;
}
export type ClaudeSandboxStatus =
  | { readonly state: 'unsupported' }
  | { readonly state: 'unknown'; readonly reason?: string }
  | {
      readonly state: 'on' | 'off' | 'filesystem-off';
      /** The settings file that decides the state, for the folder this was asked in. */
      readonly source: Scope | 'default';
      /** Key paths with a deny entry. A link counts only when its target is listed as well. */
      readonly listed: number;
      /** How many of those are listed by this folder's own settings and by no other file. */
      readonly folderOnly: number;
      readonly links: readonly UnlistedLink[];
      readonly overlaps: number;
      readonly retry: 'closed' | 'asks' | 'open';
      readonly excluded: number;
    };

function managedFiles(dir: string) {
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, 'managed-settings.d'), { withFileTypes: true })
      .filter(
        (e) =>
          !e.name.startsWith('.') && e.name.endsWith('.json') && (e.isFile() || e.isSymbolicLink()),
      )
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return [
    join(dir, 'managed-settings.json'),
    ...names.map((name) => join(dir, 'managed-settings.d', name)),
  ];
}

/** In a linked worktree the host also reads the main checkout's local settings. */
function localFiles(cwd: string, home: string, platform: NodeJS.Platform) {
  const file = (dir: string) => join(dir, '.claude', 'settings.local.json');
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      if (platform === 'win32' || dir === home) break;
      const git = join(dir, '.git');
      const uid = process.getuid?.();
      if (
        [dir, git, join(dir, '.claude')].some((path) => {
          const stat = lstatSync(path, { throwIfNoEntry: false });
          return stat && uid !== undefined && (stat.uid !== uid || stat.isSymbolicLink());
        })
      )
        break;
      let root = dir;
      if (!lstatSync(git).isDirectory()) {
        const linked = linkedGit(git, LEGACY_SURFACE_IO);
        if (!linked) throw new Error('Unknown checkout settings');
        if (linked.kind === 'worktree') root = dirname(linked.common);
      }
      return [...new Set([file(cwd), file(root)])];
    }
    if (dir === dirname(dir)) break;
  }
  return [file(cwd)];
}

function layers(where: SandboxLocation) {
  const { home, cwd, platform, env } = where;
  const dir =
    where.managedDir ??
    (platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code');
  const files: [Scope, string][] = [
    ['user', join(claudeUserDir(home, env), 'settings.json')],
    ['project', join(cwd, '.claude/settings.json')],
    ...localFiles(cwd, home, platform).map((f): [Scope, string] => ['local', f]),
    ...managedFiles(dir).map((f): [Scope, string] => ['managed', f]),
  ];
  return files.map(([scope, file]) => ({
    scope,
    base: scope === 'user' || scope === 'managed' ? dirname(file) : cwd,
    ...schema.parse(readSettingsObject(file)),
  }));
}

function location(path: string, home: string, base: string) {
  if (path === '~') return home;
  return path.startsWith('~/') ? resolve(home, path.slice(2)) : resolve(base, path);
}

// Claude's permission patterns and filesystem settings use different absolute path prefixes.
function permissionPath(
  rule: string,
  tool: 'Read' | 'Edit',
  cwd: string,
  home: string,
): string | undefined {
  if (!rule.startsWith(tool + '(') || !rule.endsWith(')')) return undefined;
  const path = rule.slice(tool.length + 1, -1);
  if (path.startsWith('//')) return path.slice(1);
  return location(path.replace(/^\//, ''), home, cwd);
}

function possibleOverlap(key: string, path: string, platform: NodeJS.Platform) {
  // A case-insensitive Mac volume may also match a differently cased allow.
  if (platform === 'darwin') {
    key = key.toLowerCase();
    path = path.toLowerCase();
  }
  const prefix = path.split(/[*?\[\]{}]/, 1)[0]!;
  return path === key || path.startsWith(key + sep) || (prefix !== path && key.startsWith(prefix));
}

type Layer = ReturnType<typeof layers>[number];
const projectLayer = (f: Layer) => f.scope === 'project' || f.scope === 'local';

interface Denied {
  readonly path: string;
  /** Listed by the folder's own settings (project or local), which a repository can ship. */
  readonly folder: boolean;
}

function deniedPaths(where: SandboxLocation, files: Layer[], permFiles: Layer[]): Denied[] {
  const fromSandbox = files.flatMap((f) => {
    const pathOf = (p: string) => ({
      path: location(p, where.home, f.base),
      folder: projectLayer(f),
    });
    return [
      ...(f.sandbox?.credentials?.files ?? []).filter((e) => e.mode === 'deny').map((e) => e.path),
      ...(f.sandbox?.filesystem?.denyRead ?? []),
    ].map(pathOf);
  });
  const fromRules = permFiles.flatMap((f) =>
    (f.permissions?.deny ?? []).flatMap((rule) => {
      const path = permissionPath(rule, 'Read', where.cwd, where.home);
      return path === undefined ? [] : [{ path, folder: projectLayer(f) }];
    }),
  );
  return [...fromSandbox, ...fromRules];
}

function allowedPaths(
  where: SandboxLocation,
  files: Layer[],
  permFiles: Layer[],
  adminRequired: boolean,
): string[] {
  const managedReadOnly =
    files.find(
      (f) =>
        f.scope === 'managed' && f.sandbox?.filesystem?.allowManagedReadPathsOnly !== undefined,
    )?.sandbox?.filesystem?.allowManagedReadPathsOnly === true;
  const ignored = (f: Layer) => adminRequired && projectLayer(f);
  const fromSandbox = files.flatMap((f) =>
    [
      ...(managedReadOnly && f.scope !== 'managed' ? [] : (f.sandbox?.filesystem?.allowRead ?? [])),
      ...(ignored(f) ? [] : (f.sandbox?.filesystem?.allowWrite ?? [])),
    ].map((p) => location(p, where.home, f.base)),
  );
  const fromRules = permFiles.flatMap((f) => {
    if (ignored(f)) return [];
    const edits = (f.permissions?.allow ?? []).flatMap((rule) => {
      const path = permissionPath(rule, 'Edit', where.cwd, where.home);
      return path === undefined ? [] : [path];
    });
    const dirs = (f.permissions?.additionalDirectories ?? []).map((p) =>
      location(p, where.home, where.cwd),
    );
    return [...dirs, ...edits];
  });
  return [...fromSandbox, ...fromRules];
}

/** Whether the real place behind a linked key path is listed, by itself or by a folder above it. */
function targetListed(where: SandboxLocation, id: KeyPath, listed: ReadonlySet<string>) {
  const link = linkedPath(where.home, id);
  if (link === undefined) return { covered: true as const };
  if (link.kind === 'unresolved') return { covered: false as const, target: null };
  const places = [location(link.target, where.home, where.cwd), link.real];
  const covered = [...listed].some((l) => places.some((p) => p === l || p.startsWith(l + sep)));
  return covered ? { covered: true as const } : { covered: false as const, target: link.target };
}

function keyPathCounts(
  where: SandboxLocation,
  files: Layer[],
  permFiles: Layer[],
  adminRequired: boolean,
) {
  const denied = deniedPaths(where, files, permFiles);
  const listed = new Set(denied.map((d) => d.path));
  const outsideFolder = new Set(denied.filter((d) => !d.folder).map((d) => d.path));
  const allows = allowedPaths(where, files, permFiles, adminRequired);
  const keys: string[] = [];
  const links: UnlistedLink[] = [];
  for (const id of KEY_PATHS) {
    const at = location(id, where.home, where.cwd);
    if (!listed.has(at)) continue;
    const target = targetListed(where, id, listed);
    if (target.covered) keys.push(at);
    else links.push({ path: id, target: target.target });
  }
  // Recent hosts ignore some project allowances for user-denied paths. Show possible conflicts only.
  const overlaps = keys.filter((key) =>
    allows.some((p) => possibleOverlap(key, p, where.platform)),
  ).length;
  const folderOnly = keys.filter((key) => !outsideFolder.has(key)).length;
  return { listed: keys.length, folderOnly, links, overlaps };
}

export function claudeSandboxStatus(where: SandboxLocation): ClaudeSandboxStatus {
  if (where.platform !== 'darwin' && where.platform !== 'linux') return { state: 'unsupported' };
  // A relative or empty folder name would have another folder's file read as the user's own.
  const unusable = claudeConfigDirProblem(where.env);
  if (unusable !== null) return { state: 'unknown', reason: unusable };
  try {
    const files = layers(where).reverse();
    const managed = files.filter((f) => f.scope === 'managed');
    const user = files.find((f) => f.scope === 'user');
    const managedOutside = managed.find((f) => f.sandbox?.allowUnsandboxedCommands !== undefined)
      ?.sandbox?.allowUnsandboxedCommands;
    const adminRequired =
      managedOutside === false ||
      managed.find((f) => f.sandbox?.network?.allowManagedDomainsOnly !== undefined)?.sandbox
        ?.network?.allowManagedDomainsOnly === true;
    const enabled = files.find(
      (f) =>
        f.sandbox?.enabled !== undefined &&
        !(
          adminRequired &&
          projectLayer(f) &&
          f.sandbox.enabled === false &&
          user?.sandbox?.enabled === true
        ),
    );
    const managedFs = files.some(
      (f) =>
        f.scope === 'managed' &&
        (f.sandbox?.filesystem || f.sandbox?.credentials?.files?.some((e) => e.mode === 'deny')),
    );
    const disabled = files.find(
      (f) =>
        (f.scope === 'managed' || (f.scope === 'user' && !managedFs)) &&
        f.sandbox?.filesystem?.disabled !== undefined,
    );
    const sandboxOn = enabled?.sandbox?.enabled === true;
    const fsOff =
      sandboxOn &&
      disabled?.sandbox?.filesystem?.disabled === true &&
      !where.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
    const permFiles = files.some((f) => f.scope === 'managed' && f.allowManagedPermissionRulesOnly)
      ? files.filter((f) => f.scope === 'managed')
      : files;
    const allowOutside =
      managedOutside ??
      (user?.sandbox?.allowUnsandboxedCommands === false
        ? false
        : files.find((f) => f.sandbox?.allowUnsandboxedCommands !== undefined)?.sandbox
            ?.allowUnsandboxedCommands);
    return {
      state: fsOff ? 'filesystem-off' : sandboxOn ? 'on' : 'off',
      source: (fsOff ? disabled : enabled)?.scope ?? 'default',
      ...keyPathCounts(where, files, permFiles, adminRequired),
      retry:
        allowOutside === false || permFiles.some((f) => f.permissions?.deny?.includes(RETRY_RULE))
          ? 'closed'
          : permFiles.some((f) => f.permissions?.ask?.includes(RETRY_RULE))
            ? 'asks'
            : 'open',
      excluded: new Set(
        files.flatMap((f) =>
          adminRequired && projectLayer(f) ? [] : (f.sandbox?.excludedCommands ?? []),
        ),
      ).size,
    };
  } catch {
    return { state: 'unknown' };
  }
}

/** Said wherever settings files are read: they are not the session. */
const LIVE_STATE = '/sandbox inside Claude Code shows the live state.';
const TOTAL = KEY_PATHS.length;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function linkNotes(links: readonly UnlistedLink[]): string[] {
  return links.map(({ path, target }) =>
    target === null
      ? `${path} is a link that could not be followed, so it is not counted.`
      : `${path} is a link to ${target}, which is not listed, so it is not counted.`,
  );
}

export function sandboxSummary(s: ClaudeSandboxStatus): string {
  if (s.state === 'unsupported') return 'Claude Code has no native Bash sandbox on this platform.';
  if (s.state === 'unknown')
    return `Claude Code sandbox settings could not be assessed${s.reason === undefined ? '.' : ': ' + s.reason} ${LIVE_STATE}`;
  const mode = s.state === 'filesystem-off' ? 'filesystem isolation off' : s.state;
  const sources = {
    user: 'user settings.json',
    project: 'project settings.json',
    local: 'settings.local.json',
    managed: 'managed settings',
    default: 'default',
  };
  const outside = {
    closed: 'are disabled',
    asks: 'require approval',
    open: 'may proceed without approval',
  }[s.retry];
  const folder = s.folderOnly ? ` (${s.folderOnly} only in this folder's settings)` : '';
  const parts = [
    `Claude Code sandbox ${mode} (${sources[s.source]}).`,
    `${s.listed}/${TOTAL} key paths listed for denial${folder}.`,
    ...(s.state !== 'on' && s.listed > 0
      ? [
          `The list is not in force while ${s.state === 'off' ? 'the sandbox' : 'filesystem isolation'} is off.`,
        ]
      : []),
    `Retries outside the sandbox ${outside}.`,
    ...linkNotes(s.links),
  ];
  if (s.overlaps)
    parts.push(
      `Review possible read exceptions for ${s.overlaps} listed ${plural(s.overlaps, 'path', 'paths')}.`,
    );
  if (s.excluded)
    parts.push(`${s.excluded} excluded command ${plural(s.excluded, 'pattern', 'patterns')}.`);
  return [
    ...parts,
    `This is read from settings files, and a running session can differ. ${LIVE_STATE}`,
  ].join(' ');
}

/** Which file decides, as the card says it: a repository's own file is named as this folder's. */
const DECIDED_BY = {
  user: 'set by your user settings.json',
  project: "set by this folder's .claude/settings.json",
  local: "set by this folder's .claude/settings.local.json",
  managed: 'set by managed settings',
  default: 'no settings file turns it on',
} as const;

/** One status line on a card about past sessions. These settings are current, and are this folder's. */
export function sandboxCardLine(status: ClaudeSandboxStatus): string {
  if (status.state === 'unsupported') return 'Claude Code has no native Bash sandbox here.';
  if (status.state === 'unknown') return 'Claude sandbox settings unknown. See stroq doctor.';
  const mode = status.state === 'filesystem-off' ? 'file isolation off' : status.state;
  const retry = { open: 'open', asks: 'ask', closed: 'off' }[status.retry];
  const { folderOnly, links, overlaps, excluded } = status;
  const folder = folderOnly ? ` (${folderOnly} only in this folder's settings)` : '';
  return [
    `Claude sandbox ${mode} for this folder (${DECIDED_BY[status.source]})`,
    `${status.listed}/${TOTAL} paths${folder}`,
    `outside retry ${retry}`,
    ...(links.length
      ? [`${links.length} link ${plural(links.length, 'target', 'targets')} not listed`]
      : []),
    ...(overlaps
      ? [`${overlaps} possible read ${plural(overlaps, 'exception', 'exceptions')}`]
      : []),
    ...(excluded
      ? [`${excluded} excluded command ${plural(excluded, 'pattern', 'patterns')}`]
      : []),
  ].join(' · ');
}
