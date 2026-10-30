import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redact, stableStringify } from '@stroq/core';
import {
  countHttp,
  entryRunsStrict,
  wrapperIndex,
} from '../../packages/cli/src/commands/mcp-config.ts';
import { isObject, parseJsonDocument } from '../../packages/cli/src/harden/json-doc.ts';

export const MCP_SOURCE_TYPES = [
  'claude-desktop-manual',
  'cursor-project',
  'cursor-user',
  'claude-code-project',
  'devin-cascade-current',
  'windsurf-legacy-ide',
  'windsurf-legacy',
] as const;
export type McpSourceType = (typeof MCP_SOURCE_TYPES)[number];
export type McpAgent = 'claude-code' | 'claude-desktop' | 'cursor' | 'windsurf';
export type McpRoot = { path: string; ino: number; dev: number };
export interface McpSource {
  source: McpSourceType;
  agent: McpAgent;
  scope: 'project' | 'user';
  root: McpRoot;
  file: string;
  relativePath: string;
  applicability:
    | 'supported'
    | 'legacy-unverified'
    | 'client-unverified'
    | 'platform-unsupported'
    | 'configuration-unavailable';
}
export interface McpSourceOptions {
  project: string;
  userHome: string;
  platform?: NodeJS.Platform;
  environment?: Readonly<Record<string, string | undefined>>;
  deadline?: number;
}
const MAX_CONFIG = 256 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const same = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) =>
  a.ino === b.ino && a.dev === b.dev;
const fail = (code: string): never => {
  throw new Error(`mcp-source-${code}`);
};
const checkDeadline = (deadline?: number) => {
  if (deadline !== undefined && Date.now() >= deadline) fail('limit');
};
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
async function rootAt(path: string): Promise<McpRoot> {
  if (!isAbsolute(path)) return fail('unsafe');
  try {
    const canonical = await realpath(path);
    const stat = await lstat(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('unsafe');
    return { path: canonical, ino: stat.ino, dev: stat.dev };
  } catch {
    return fail('unsafe');
  }
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return fail('unsafe');
  }
}
function environmentBase(root: McpRoot, setting: string | undefined, fallback: string) {
  if (setting === undefined || setting === '') return join(root.path, fallback);
  if (setting.length > 4096 || !isAbsolute(setting) || /[\u0000-\u001f\u007f]/.test(setting))
    return null;
  const base = resolve(setting);
  if (!within(root.path, base)) return null;
  return base;
}

/** Only explicit server-selected roots and environment inputs; never consults the host profile. */
export async function discoverMcpSources(options: McpSourceOptions): Promise<McpSource[]> {
  checkDeadline(options.deadline);
  const project = await rootAt(options.project),
    user = await rootAt(options.userHome);
  const platform = options.platform,
    environment = options.environment ?? {};
  const windows = platform === 'win32';
  const supported = platform === 'darwin' || platform === 'linux';
  const appData = windows
    ? environmentBase(user, environment.APPDATA, join('AppData', 'Roaming'))
    : null;
  const xdg = windows ? null : environmentBase(user, environment.XDG_CONFIG_HOME, '.config');
  const desktop =
    platform === 'darwin'
      ? join(user.path, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : windows
        ? join(
            appData ?? join(user.path, 'AppData', 'Roaming'),
            'Claude',
            'claude_desktop_config.json',
          )
        : join(user.path, '.config', 'Claude', 'claude_desktop_config.json');
  const current = windows
    ? join(appData ?? join(user.path, 'AppData', 'Roaming'), 'devin', 'mcp_config.json')
    : join(xdg ?? join(user.path, '.config'), 'devin', 'mcp_config.json');
  const legacyIde = join(user.path, '.codeium', 'windsurf', 'mcp_config.json');
  const preferIde = await exists(legacyIde);
  const sources: McpSource[] = [];
  const add = (
    source: McpSourceType,
    agent: McpAgent,
    scope: McpSource['scope'],
    root: McpRoot,
    file: string,
    applicability: McpSource['applicability'],
  ) => {
    if (!within(root.path, file) || file === root.path) return fail('unsafe');
    if (sources.some((known) => known.file === file)) return;
    sources.push({
      source,
      agent,
      scope,
      root,
      file,
      relativePath: relative(root.path, file),
      applicability,
    });
  };
  // Distinct source identities stay compatible. A workspace alias of the profile
  // must retain Cursor's user scope so the preview describes its full effect.
  add(
    'claude-desktop-manual',
    'claude-desktop',
    'user',
    user,
    desktop,
    windows && appData === null
      ? 'configuration-unavailable'
      : platform === 'darwin'
        ? 'supported'
        : platform === 'linux'
          ? 'client-unverified'
          : 'platform-unsupported',
  );
  add(
    preferIde ? 'windsurf-legacy-ide' : 'windsurf-legacy',
    'windsurf',
    'user',
    user,
    preferIde ? legacyIde : join(user.path, '.codeium', 'mcp_config.json'),
    'legacy-unverified',
  );
  if (project.path !== user.path)
    add(
      'cursor-project',
      'cursor',
      'project',
      project,
      join(project.path, '.cursor', 'mcp.json'),
      supported ? 'supported' : 'platform-unsupported',
    );
  add(
    'cursor-user',
    'cursor',
    'user',
    user,
    join(user.path, '.cursor', 'mcp.json'),
    supported ? 'supported' : 'platform-unsupported',
  );
  add(
    'claude-code-project',
    'claude-code',
    'project',
    project,
    join(project.path, '.mcp.json'),
    supported ? 'supported' : 'platform-unsupported',
  );
  add(
    'devin-cascade-current',
    'windsurf',
    'user',
    user,
    current,
    (windows ? appData === null : xdg === null)
      ? 'configuration-unavailable'
      : windows
        ? 'platform-unsupported'
        : 'client-unverified',
  );
  return sources;
}

async function namedFile(source: McpSource) {
  const { root, relativePath, file } = source;
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    !within(root.path, file) ||
    join(root.path, relativePath) !== file ||
    !MCP_SOURCE_TYPES.includes(source.source)
  )
    return fail('unsafe');
  const base = await lstat(root.path);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    !same(root, base) ||
    (await realpath(root.path)) !== root.path
  )
    return fail('conflict');
  let at = root.path;
  const parts = relativePath.split(sep);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === '.' || parts[i] === '..') return fail('unsafe');
    at = join(at, parts[i]!);
    let stat;
    try {
      stat = await lstat(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('missing');
      return fail('unsafe');
    }
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    )
      return fail('unsafe');
    if (i === parts.length - 1) return stat;
  }
  return fail('unsafe');
}

/** Full raw bytes and strict parse from one bounded regular-file capture; internal data only. */
export async function readMcpSource(source: McpSource) {
  let handle;
  try {
    // An invalid explicit config base is a source-specific gap. Its bounded default
    // locator is metadata only; never read it as a fallback to the rejected setting.
    if (source.applicability === 'configuration-unavailable') return fail('unsafe');
    const named = await namedFile(source);
    if (named.size > MAX_CONFIG) return fail('limit');
    handle = await open(
      source.file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !same(named, before)) return fail('conflict');
    if (before.size > MAX_CONFIG) return fail('limit');
    const bytes = Buffer.alloc(before.size);
    let filled = 0;
    while (filled < bytes.length) {
      const read = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!read.bytesRead) break;
      filled += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat(),
      current = await namedFile(source);
    if (
      filled !== bytes.length ||
      extra.bytesRead ||
      !same(before, after) ||
      !same(after, current) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.nlink !== 1
    )
      return fail('conflict');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return fail('invalid');
    }
    const parsed = parseJsonDocument(text);
    if (!parsed.ok || (Object.hasOwn(parsed.doc, 'mcpServers') && !isObject(parsed.doc.mcpServers)))
      return fail('invalid');
    const sha256 = hash(bytes);
    return {
      bytes,
      text,
      doc: parsed.doc,
      layout: parsed.layout,
      roundTrips: parsed.roundTrips,
      sha256,
      fileSha256: sha256,
      byteLength: bytes.length,
      mode: before.mode & 0o777,
      fileIdentity: {
        ino: before.ino,
        dev: before.dev,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      },
      root: source.root,
    };
  } catch (error) {
    const message = (error as Error).message;
    if (/^mcp-source-(?:missing|unsafe|invalid|conflict|limit)$/.test(message)) throw error;
    return fail('unsafe');
  } finally {
    await handle?.close();
  }
}

export function mcpArtifactId(source: McpSource, name: string) {
  const locator = source.source === 'devin-cascade-current' ? `${source.source}\0${name}` : name;
  return `item-${hash(`mcp\0${source.agent}\0${source.scope}\0${locator}`).slice(0, 24)}`;
}
const safeName = (name: string, fallback: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(name) &&
  redact(name) === name &&
  !/(?:^|[\/ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[\/ .-])/.test(name) &&
  !/(?:^|\/)\.env|(?:^|[ \/_.-])(?:env|secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ \/_.-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
    name,
  )
    ? name
    : fallback;
export function mcpArtifact(source: McpSource, name: string, sha256: string) {
  const id = mcpArtifactId(source, name);
  return {
    id,
    name: safeName(name, `MCP server ${id.slice(-8)}`),
    agent: source.agent,
    scope: source.scope,
    sha256,
  };
}
export function mcpEntryMetadata(entry: unknown) {
  const known =
    isObject(entry) &&
    (!Object.hasOwn(entry, 'args') ||
      (Array.isArray(entry.args) &&
        entry.args.length <= 256 &&
        entry.args.every((arg) => typeof arg === 'string')));
  const http = known && countHttp({ mcpServers: { inspected: entry } }) === 1;
  const stdio = known && typeof entry.command === 'string' && entry.command.length > 0 && !http;
  const valid = known && (http || stdio);
  const wrapped = stdio && wrapperIndex(Array.isArray(entry.args) ? entry.args : []) !== null;
  return {
    valid,
    sha256: valid ? hash(stableStringify(entry)) : null,
    mcp: {
      transport: http ? ('http' as const) : stdio ? ('stdio' as const) : ('unknown' as const),
      wrapper: !valid
        ? ('unknown' as const)
        : wrapped
          ? ('configured' as const)
          : ('not-configured' as const),
      strict: Boolean(wrapped && entryRunsStrict(entry)),
    },
  };
}

/** Fixed known sources only. Callers must not return this internal raw capture to a browser. */
export async function resolveMcpArtifactById(
  options: McpSourceOptions & { id: string; expectedSha256: string },
) {
  if (!/^item-[a-f0-9]{24}$/.test(options.id) || !/^[a-f0-9]{64}$/.test(options.expectedSha256))
    return fail('conflict');
  let total = 0;
  for (const source of await discoverMcpSources(options)) {
    checkDeadline(options.deadline);
    let capture;
    try {
      capture = await readMcpSource(source);
    } catch {
      continue;
    }
    const servers =
      Object.hasOwn(capture.doc, 'mcpServers') && isObject(capture.doc.mcpServers)
        ? capture.doc.mcpServers
        : {};
    for (const [name, entry] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
      if (total++ >= 128) return fail('limit');
      if (mcpArtifactId(source, name) !== options.id) continue;
      const metadata = mcpEntryMetadata(entry);
      if (!metadata.valid || metadata.sha256 !== options.expectedSha256) return fail('conflict');
      return {
        ...source,
        ...capture,
        name,
        entry,
        entrySha256: metadata.sha256,
        artifact: mcpArtifact(source, name, metadata.sha256),
        mcp: metadata.mcp,
      };
    }
  }
  return fail('conflict');
}
export const resolveMcpSource = resolveMcpArtifactById;
