import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { linkedGit } from '../exposure/linked-git.js';
import { LEGACY_SURFACE_IO } from '../exposure/surface-io.js';
import { claudeUserDir } from '../paths.js';
import { readTargetStrict } from '../harden/read.js';
import { parseJsonDocument } from '../harden/json-doc.js';
import { KEY_PATHS, RETRY_RULE } from './rules.js';

export interface SandboxLocation {
  readonly home: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly managedDir?: string;
}

export function hasClaudeSettings(where: SandboxLocation): boolean {
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
export type ClaudeSandboxStatus =
  | { readonly state: 'unsupported' }
  | { readonly state: 'unknown' }
  | {
      readonly state: 'on' | 'off' | 'filesystem-off';
      readonly source: Scope | 'default';
      readonly listed: number;
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

function keyPathCounts(
  where: SandboxLocation,
  files: Layer[],
  permFiles: Layer[],
  adminRequired: boolean,
) {
  const managedReadOnly =
    files.find(
      (f) =>
        f.scope === 'managed' && f.sandbox?.filesystem?.allowManagedReadPathsOnly !== undefined,
    )?.sandbox?.filesystem?.allowManagedReadPathsOnly === true;
  const listed = new Set<string>();
  const allows: string[] = [];
  for (const f of files) {
    const pathOf = (p: string) => location(p, where.home, f.base);
    for (const e of f.sandbox?.credentials?.files ?? [])
      if (e.mode === 'deny') listed.add(pathOf(e.path));
    for (const p of f.sandbox?.filesystem?.denyRead ?? []) listed.add(pathOf(p));
    for (const p of [
      ...(managedReadOnly && f.scope !== 'managed' ? [] : (f.sandbox?.filesystem?.allowRead ?? [])),
      ...(adminRequired && projectLayer(f) ? [] : (f.sandbox?.filesystem?.allowWrite ?? [])),
    ])
      allows.push(pathOf(p));
  }
  for (const f of permFiles) {
    for (const p of adminRequired && projectLayer(f)
      ? []
      : (f.permissions?.additionalDirectories ?? []))
      allows.push(location(p, where.home, where.cwd));
    for (const rule of adminRequired && projectLayer(f) ? [] : (f.permissions?.allow ?? [])) {
      const path = permissionPath(rule, 'Edit', where.cwd, where.home);
      if (path) allows.push(path);
    }
    for (const rule of f.permissions?.deny ?? []) {
      const path = permissionPath(rule, 'Read', where.cwd, where.home);
      if (path) listed.add(path);
    }
  }
  const keys = KEY_PATHS.map((p) => location(p, where.home, where.cwd)).filter((p) =>
    listed.has(p),
  );
  // Recent hosts ignore some project allowances for user-denied paths. Show possible conflicts only.
  const overlaps = keys.filter((key) =>
    allows.some((p) => possibleOverlap(key, p, where.platform)),
  ).length;
  return { listed: keys.length, overlaps };
}

export function claudeSandboxStatus(where: SandboxLocation): ClaudeSandboxStatus {
  if (where.platform !== 'darwin' && where.platform !== 'linux') return { state: 'unsupported' };
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

export function sandboxSummary(s: ClaudeSandboxStatus): string {
  if (s.state === 'unsupported') return 'Claude Code has no native Bash sandbox on this platform.';
  if (s.state === 'unknown')
    return 'Claude Code sandbox settings could not be assessed. Check /sandbox in your session.';
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
  const parts = [
    `Claude Code sandbox ${mode} (${sources[s.source]}).`,
    `${s.listed}/${KEY_PATHS.length} key paths listed for denial.`,
    `Retries outside the sandbox ${outside}.`,
  ];
  if (s.overlaps)
    parts.push(
      `Review possible read exceptions for ${s.overlaps} listed ${s.overlaps === 1 ? 'path' : 'paths'}.`,
    );
  if (s.excluded)
    parts.push(`${s.excluded} excluded command ${s.excluded === 1 ? 'pattern' : 'patterns'}.`);
  return [...parts, 'Check /sandbox in your session.'].join(' ');
}

/** One status line on a card about past sessions. These settings are current. */
export function sandboxCardLine(status: ClaudeSandboxStatus): string {
  if (status.state === 'unsupported') return 'Claude Code has no native Bash sandbox here.';
  if (status.state === 'unknown') return 'Claude sandbox settings unknown. See stroq doctor.';
  const mode = status.state === 'filesystem-off' ? 'file isolation off' : status.state;
  const retry = { open: 'open', asks: 'ask', closed: 'off' }[status.retry];
  return [
    `Claude sandbox ${mode} (config)`,
    `${status.listed}/${KEY_PATHS.length} paths`,
    `outside retry ${retry}`,
    ...(status.overlaps
      ? [`${status.overlaps} possible read ${status.overlaps === 1 ? 'exception' : 'exceptions'}`]
      : []),
    ...(status.excluded
      ? [`${status.excluded} excluded command ${status.excluded === 1 ? 'pattern' : 'patterns'}`]
      : []),
  ].join(' · ');
}
