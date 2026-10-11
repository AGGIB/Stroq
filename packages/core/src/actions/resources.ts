import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolResources } from '../types.js';
import { MAX_URL_CHARS, commandUrls } from './classify-bash.js';
import { monitorSocket, monitorSocketHost } from './monitor-socket.js';
import { createResourcePathResolver } from './resource-path.js';

/**
 * What a tool call reaches, as data: the files it reads or writes, the addresses it contacts,
 * and whether it runs a shell. A task's scope is held against this, and the scope must fail
 * closed, so every reader below is honest about what it could not determine: `pathsComplete`
 * is false whenever the call may touch something the lists do not name.
 *
 * Pure apart from a bounded filesystem walk per listed path (`resource-path.ts`). Bounded,
 * because every argument is the agent's: at most `MAX_RESOURCE_PATHS`
 * paths and `MAX_RESOURCE_URLS` addresses, a path longer than any filesystem opens is not
 * listed, and a reader that fails for any reason answers "I do not know" and never throws.
 *
 * Paths are lexical: made absolute against the working directory and cleaned of `.`, `..` and
 * doubled separators, never expanded (`~` is the tool's to expand, see `describe`) and never
 * folded to one case (a case-sensitive filesystem has two files there).
 */
export const MAX_RESOURCE_PATHS = 256;
export const MAX_RESOURCE_URLS = 256;
/** Past the longest path a filesystem opens (Windows long paths); not listed, and the list says so. */
const MAX_PATH_CHARS = 32 * 1024;

type Op = 'read' | 'write';
type ResourcePath = ToolResources['paths'][number];
type ResourceUrl = ToolResources['urls'][number];

/** A value an MCP call's arguments held that reads as a path (see `scanPaths` in `classify-tool.ts`). */
export interface ScannedPath {
  readonly path: string;
  /** Under a key that names where the tool writes. */
  readonly dest: boolean;
  /** Read only because it looks like a path, under a key nobody said was one. */
  readonly weak: boolean;
}

interface PathRequest {
  readonly raw: string;
  readonly op: Op;
  /** The directory a relative `raw` is relative to. */
  readonly base: string;
}

/** A call that was not understood: nothing is listed, and the lists are not the whole of it. */
const unknown = (shell: boolean): ToolResources => ({
  paths: [],
  pathsComplete: false,
  urls: [],
  shell,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The hook must not throw on what the agent sent, and a throw there is an allow on some
 * hosts. "I do not know" is the answer that fails closed in a scope, so it is what a reader
 * that fails gives, rather than the error.
 */
function guarded(shell: boolean, build: () => ToolResources): ToolResources {
  try {
    return build();
  } catch {
    return unknown(shell);
  }
}

/**
 * `raw` made into the path it names, or how far that could be done. `~` stays as written and
 * unresolved: whether it is the home directory or a directory called `~` is the tool's to say,
 * and joined to the working directory it would sit inside a project scope when it may not be
 * there at all. Relative to a working directory that is not absolute (an adapter that had none)
 * it is resolved against the hook's own, which is not the session's, so it is unresolved too.
 */
function describe(raw: string, base: string): { path: string; resolved: boolean } | null {
  if (raw === '' || raw.length > MAX_PATH_CHARS || raw.includes('\0')) return null;
  if (raw.startsWith('~')) return { path: raw, resolved: false };
  return { path: resolve(base, raw), resolved: isAbsolute(raw) || isAbsolute(base) };
}

/**
 * The paths asked for, each once per way it is used, with where a link on the way really leads.
 * `complete` is false when one could not be resolved or the cap cut the list. The link is looked
 * for in a new file's directory too, because a write through a linked directory lands outside it.
 */
function listPaths(requests: readonly PathRequest[]): {
  paths: readonly ResourcePath[];
  complete: boolean;
} {
  const resolveResourcePath = createResourcePathResolver();
  const seen = new Set<string>();
  const paths: ResourcePath[] = [];
  let complete = true;
  for (const { raw, op, base } of requests) {
    const described = describe(raw, base);
    if (described === null || !described.resolved) complete = false;
    if (described === null) continue;
    // Keep parent steps until the filesystem has followed links: link/../x is not necessarily
    // the same file as x. Prefixing a relative spelling must not normalize it either.
    const absolute = isAbsolute(raw) ? raw : `${base}${sep}${raw}`;
    const target = described.resolved ? resolveResourcePath(absolute) : null;
    if (target === null) complete = false;
    const real = target === described.path ? null : target;
    const key = `${op}\0${described.path}\0${real ?? ''}`;
    if (seen.has(key)) continue;
    if (paths.length >= MAX_RESOURCE_PATHS) return { paths, complete: false };
    seen.add(key);
    paths.push({ path: described.path, ...(real === null ? {} : { real }), op });
  }
  return { paths, complete };
}

const ofPaths = (requests: readonly PathRequest[], complete: boolean): ToolResources => {
  const listed = listPaths(requests);
  return {
    paths: listed.paths,
    pathsComplete: complete && listed.complete,
    urls: [],
    shell: false,
  };
};

/** The fields a file tool names its file in; the classifier reads the same three. */
const FILE_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * Read, Write, Edit, MultiEdit and NotebookEdit act on the file their field names. Every field
 * that could name it is listed: a call whose fields disagree reaches both, and a scope has to
 * hold for both. A field that is there and is not a path, or no field at all, is a call whose
 * file is not known.
 */
function ofNamedFiles(
  input: Readonly<Record<string, unknown>>,
  op: Op,
  cwd: string,
): ToolResources {
  const requests: PathRequest[] = [];
  let complete = true;
  for (const field of FILE_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value !== '') requests.push({ raw: value, op, base: cwd });
    else complete = false;
  }
  return ofPaths(requests, complete && requests.length > 0);
}

/** Absent, null and empty all mean "the default": the working directory. */
const named = (value: unknown): value is string => typeof value === 'string' && value !== '';
const unnamed = (value: unknown): boolean => value === undefined || value === null || value === '';

const SEARCH_FIELDS = /^(path|file_path|notebook_path|directory|root|files|paths)$/i;

/** Grep/LS roots, including directory aliases; cwd is the default, not a descendant inventory. */
function ofSearch(input: Readonly<Record<string, unknown>>, cwd: string): ToolResources {
  const requests: PathRequest[] = [];
  let complete = true;
  for (const [key, value] of Object.entries(input)) {
    if (!SEARCH_FIELDS.test(key)) continue;
    if (unnamed(value)) continue;
    if (Array.isArray(value) && !/^(paths|files)$/i.test(key)) {
      complete = false;
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const path of values) {
      if (!named(path)) complete = false;
      else requests.push({ raw: path, op: 'read', base: cwd });
      if (requests.length > MAX_RESOURCE_PATHS) return ofPaths(requests, false);
    }
  }
  if (requests.length === 0) {
    return complete ? ofPaths([{ raw: cwd, op: 'read', base: cwd }], true) : unknown(false);
  }
  return ofPaths(requests, complete);
}

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const WINDOWS = process.platform === 'win32';

/** `*`, `?`, `[`, `{` and `(` (the opener of an extended pattern such as `+(a|b)`). */
const isWildcard = (code: number): boolean =>
  code === 0x2a || code === 0x3f || code === 0x5b || code === 0x7b || code === 0x28;

/**
 * The part of a glob pattern that is a plain path: everything before the directory that holds the
 * first wildcard (`/etc/ssh/*.conf` is `/etc/ssh`), or the whole pattern when it has none. Empty
 * when the first directory already has one. One pass over the pattern.
 */
function globRoot(pattern: string): string {
  let lastSeparator = -1;
  for (let i = 0; i < pattern.length; i += 1) {
    const code = pattern.charCodeAt(i);
    if (code === SLASH || (WINDOWS && code === BACKSLASH)) lastSeparator = i;
    else if (isWildcard(code)) {
      // A separator at the very start is the root itself (`/**/x` is `/`), not an empty name.
      return pattern.slice(0, lastSeparator === 0 ? 1 : Math.max(lastSeparator, 0));
    }
  }
  return pattern;
}

const climbs = (root: string): boolean => root.split(WINDOWS ? /[\\/]/ : '/').includes('..');

/**
 * Glob looks under `path` (the working directory by default), but a pattern that is absolute
 * starts where it says, and one that climbs (`../../**`) leaves `path` by the way up. The root of
 * such a pattern is read as well. A pattern that is missing or too long to be read is a pattern
 * whose root is not known.
 */
function ofGlob(input: Readonly<Record<string, unknown>>, cwd: string): ToolResources {
  const path = input['path'];
  const pattern = input['pattern'];
  if (!unnamed(path) && !named(path)) return unknown(false);
  const patternKnown = typeof pattern === 'string' && pattern.length <= MAX_PATH_CHARS;
  const root = patternKnown ? globRoot(pattern) : '';
  const starts = root !== '' && (isAbsolute(root) || root.startsWith('~'));
  // What a relative root is relative to: the directory the search starts in.
  const searchBase =
    named(path) && !path.startsWith('~') ? (isAbsolute(path) ? path : `${cwd}${sep}${path}`) : cwd;
  const requests: PathRequest[] = [];
  if (named(path)) requests.push({ raw: path, op: 'read', base: cwd });
  else if (!starts) requests.push({ raw: cwd, op: 'read', base: cwd });
  if (starts || (root !== '' && climbs(root)))
    requests.push({ raw: root, op: 'read', base: searchBase });
  return ofPaths(requests, patternKnown);
}

/**
 * The files a file tool reads or writes: Read, Write, Edit, MultiEdit, NotebookEdit, Grep,
 * Glob and LS. A tool this does not know, and an input that is not an object, are not understood.
 */
export function resourcesOfFileTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ToolResources {
  return guarded(false, () => {
    if (!isRecord(toolInput)) return unknown(false);
    switch (toolName) {
      case 'Read':
        return ofNamedFiles(toolInput, 'read', cwd);
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return ofNamedFiles(toolInput, 'write', cwd);
      case 'Grep':
      case 'LS':
        return ofSearch(toolInput, cwd);
      case 'Glob':
        return ofGlob(toolInput, cwd);
      default:
        return unknown(false);
    }
  });
}

/** The address text, cut at the length of one, and whether it was cut. */
const cutUrl = (url: string): { text: string; cut: boolean } =>
  url.length > MAX_URL_CHARS
    ? { text: url.slice(0, MAX_URL_CHARS), cut: true }
    : { text: url, cut: false };

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** The local path a `file:` URL names, or null when it names none (a host on another machine). */
function pathOfFileUrl(url: URL): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * WebFetch reaches one address. A `file:` URL is a read of a local path instead. A text that is
 * no address is listed with no host, not dropped: a client may make something of it that Stroq
 * does not.
 */
export function resourcesOfWebFetch(url: unknown): ToolResources {
  return guarded(false, () => {
    if (typeof url !== 'string' || url === '') return unknown(false);
    const { text, cut } = cutUrl(url);
    const parsed = parseUrl(text);
    if (parsed?.protocol !== 'file:')
      return {
        paths: [],
        pathsComplete: !cut,
        urls: [{ url: text, host: parsed?.hostname ?? '' }],
        shell: false,
      };
    const local = pathOfFileUrl(parsed);
    return local === null
      ? unknown(false)
      : ofPaths([{ raw: local, op: 'read', base: local }], !cut);
  });
}

/** What a `file:` value in an MCP call's arguments names: undefined if it is not one, null if it names no local path. */
function fileUriPath(value: string): string | null | undefined {
  // A URL parser drops control characters and spaces before the scheme and tabs and line breaks
  // inside it, so `  fi\tle:///x` is a `file:` URI; a server that parses it opens the file.
  let from = 0;
  while (from < value.length && value.charCodeAt(from) <= 0x20) from += 1;
  const head = value.slice(from, from + 64).replace(/[\t\r\n]/g, '');
  if (!/^file:/i.test(head)) return undefined;
  const parsed = parseUrl(value);
  return parsed?.protocol === 'file:' ? pathOfFileUrl(parsed) : null;
}

/**
 * A value that a server may expand into more than one path, or into another one: a wildcard or a
 * variable. `[`, `]`, `{` and `}` are not here, because a route file is called `[slug]`.
 */
const EXPANDS = /[*?$]/;

/**
 * The paths an MCP call's arguments name, found by `scanPaths` in `classify-tool.ts` (which is why
 * they are handed in: one scan, and this file does not import that one). Written when the tool
 * writes or the key names a destination, read otherwise and for any value read only because it
 * looks like a path: the same verb logic as the classification. A value that looks like a path
 * and cannot be resolved (`~`, a `file:` URI that names no local file, a wildcard, a variable, a
 * NUL byte) leaves the list not complete, and so does a scan that was cut short.
 */
export function resourcesOfMcp(
  entries: readonly ScannedPath[],
  scanComplete: boolean,
  write: boolean,
  cwd: string,
): ToolResources {
  return guarded(false, () => {
    const requests: PathRequest[] = [];
    let complete = scanComplete;
    for (const entry of entries) {
      const uri = fileUriPath(entry.path);
      const raw = uri === undefined ? entry.path : uri;
      if (raw === null || EXPANDS.test(raw)) complete = false;
      if (raw === null) continue;
      const op = !entry.weak && (write || entry.dest) ? 'write' : 'read';
      requests.push({ raw, op, base: cwd });
    }
    return ofPaths(requests, complete);
  });
}

/** The address of a Monitor WebSocket, cut like any other, with the host a client would connect to. */
function socketUrl(url: string): ResourceUrl {
  const { text } = cutUrl(url);
  return { url: text, host: monitorSocketHost(text) ?? '' };
}

/**
 * Bash, PowerShell and Monitor run a shell, and a shell command can touch any path (a variable,
 * a glob, a script it runs), so the paths are never complete. The addresses are those the text
 * of the command names, which is a lower bound and not a promise: it does not see the one a
 * variable or an encoded program builds. A Monitor WebSocket is an address as well.
 */
export function resourcesOfShellTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): ToolResources {
  return guarded(true, () => {
    const input = isRecord(toolInput) ? toolInput : {};
    const command = input['command'];
    const fromCommand =
      typeof command === 'string' ? commandUrls(command, MAX_RESOURCE_URLS).urls : [];
    const socket = toolName === 'Monitor' ? monitorSocket(input) : null;
    const fromSocket = socket === null || socket.url === '' ? [] : [socketUrl(socket.url)];
    const urls = new Map<string, ResourceUrl>();
    for (const found of [...fromCommand, ...fromSocket]) {
      if (urls.size < MAX_RESOURCE_URLS && !urls.has(found.url)) urls.set(found.url, found);
    }
    return { paths: [], pathsComplete: false, urls: [...urls.values()], shell: true };
  });
}
