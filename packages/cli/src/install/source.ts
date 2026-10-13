// How a source given to `stroq vet --online` is parsed and checked.
//
// Sources:
//  - `npm:<package>[@version|tag]`
//  - `github:<owner>/<repo>[#ref][:subdir]`
//  - `https://<host>/<path>.tgz` (.tar.gz, .tar)
//
// The parsing holds every part to its length and shape before any network call is made.
import { checkEntryPath } from './safe-path.js';
import { LIMITS } from './types.js';

export interface NpmSource {
  readonly type: 'npm';
  readonly name: string;
  readonly version: string;
}

export interface GitHubSource {
  readonly type: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly commit?: string;
  readonly subdir?: string;
}

export interface UrlSource {
  readonly type: 'url';
  readonly url: URL;
  readonly host: string;
}

export type OnlineSource = NpmSource | GitHubSource | UrlSource;

export class SourceSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceSyntaxError';
  }
}

const SOURCE_PART_MAX = {
  npmName: 214,
  version: 256,
  owner: 39,
  repo: 100,
  ref: 255,
} as const;

const HOST_MAX = 253;
const HOST_LABEL_MAX = 63;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const NUMBER = /^(?:[0-9]+|0x[0-9a-f]*)$/i;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

export function isHostName(text: string): boolean {
  if (text.length > HOST_MAX || text === 'localhost') return false;
  const labels = text.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (NUMBER.test(last)) return false;
  return labels.every((part) => part.length <= HOST_LABEL_MAX && HOST_LABEL.test(part));
}

const NPM_UNSCOPED = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const NPM_SCOPE = /^@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const NPM_VERSION_OR_TAG = /^[a-zA-Z0-9_.-]+$/;

function parseNpmSource(spec: string): NpmSource {
  if (spec.length === 0) {
    throw new SourceSyntaxError('npm source needs a package name: npm:<package>[@version]');
  }
  let name: string;
  let version = 'latest';

  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash === -1) {
      throw new SourceSyntaxError(`scoped npm package name is missing '/': ${spec}`);
    }
    const scope = spec.slice(0, slash);
    if (!NPM_SCOPE.test(scope)) {
      throw new SourceSyntaxError(`invalid npm package scope: ${scope}`);
    }
    const rest = spec.slice(slash + 1);
    const at = rest.indexOf('@');
    if (at === -1) {
      name = `${scope}/${rest}`;
      const pkgPart = rest;
      if (!NPM_UNSCOPED.test(pkgPart)) {
        throw new SourceSyntaxError(`invalid npm package name: ${name}`);
      }
    } else {
      const pkgPart = rest.slice(0, at);
      name = `${scope}/${pkgPart}`;
      if (!NPM_UNSCOPED.test(pkgPart)) {
        throw new SourceSyntaxError(`invalid npm package name: ${name}`);
      }
      version = rest.slice(at + 1);
    }
  } else {
    const at = spec.indexOf('@');
    if (at === -1) {
      name = spec;
    } else {
      name = spec.slice(0, at);
      version = spec.slice(at + 1);
    }
    if (!NPM_UNSCOPED.test(name)) {
      throw new SourceSyntaxError(`invalid npm package name: ${name}`);
    }
  }

  if (name.length > SOURCE_PART_MAX.npmName) {
    throw new SourceSyntaxError(
      `npm package name is over ${SOURCE_PART_MAX.npmName} characters: ${name}`,
    );
  }
  if (version.length === 0) {
    throw new SourceSyntaxError(`npm version or tag after '@' cannot be empty`);
  }
  if (version.length > SOURCE_PART_MAX.version) {
    throw new SourceSyntaxError(
      `npm version or tag is over ${SOURCE_PART_MAX.version} characters: ${version}`,
    );
  }
  if (!NPM_VERSION_OR_TAG.test(version)) {
    throw new SourceSyntaxError(`invalid npm version or tag: ${version}`);
  }

  return { type: 'npm', name, version };
}

const GITHUB_OWNER = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const GITHUB_REPO = /^[a-zA-Z0-9_.-]+$/;

function parseGitHubSource(spec: string): GitHubSource {
  if (spec.length === 0) {
    throw new SourceSyntaxError(
      'github source needs owner and repo: github:<owner>/<repo>[#ref][:subdir]',
    );
  }
  let withoutSubdir = spec;
  let subdir: string | undefined;

  const colon = spec.indexOf(':');
  if (colon !== -1) {
    withoutSubdir = spec.slice(0, colon);
    subdir = spec.slice(colon + 1);
    if (subdir.length === 0) {
      throw new SourceSyntaxError('subdirectory after ":" cannot be empty');
    }
    if (subdir.length > LIMITS.maxPathBytes) {
      throw new SourceSyntaxError(`subdirectory is over ${LIMITS.maxPathBytes} bytes: ${subdir}`);
    }
    const check = checkEntryPath(subdir);
    if (!check.ok) {
      throw new SourceSyntaxError(`subdirectory is not a valid path: ${check.reason}`);
    }
  }

  let repoPart = withoutSubdir;
  let ref = 'HEAD';

  const hash = withoutSubdir.indexOf('#');
  if (hash !== -1) {
    repoPart = withoutSubdir.slice(0, hash);
    ref = withoutSubdir.slice(hash + 1);
    if (ref.length === 0) {
      throw new SourceSyntaxError('ref after "#" cannot be empty');
    }
    if (ref.length > SOURCE_PART_MAX.ref) {
      throw new SourceSyntaxError(`ref is over ${SOURCE_PART_MAX.ref} characters`);
    }
    if (/[\p{Cc}\p{Cf}\p{Cs}\s]/u.test(ref)) {
      throw new SourceSyntaxError('ref cannot contain whitespace or control characters');
    }
  }

  const slash = repoPart.indexOf('/');
  if (slash === -1) {
    throw new SourceSyntaxError(
      `github source needs both owner and repo separated by '/': github:<owner>/<repo>[#ref][:subdir]`,
    );
  }
  const owner = repoPart.slice(0, slash);
  const repo = repoPart.slice(slash + 1);

  if (owner.length === 0 || owner.length > SOURCE_PART_MAX.owner || !GITHUB_OWNER.test(owner)) {
    throw new SourceSyntaxError(`invalid GitHub owner: "${owner}"`);
  }
  if (
    repo.length === 0 ||
    repo.length > SOURCE_PART_MAX.repo ||
    !GITHUB_REPO.test(repo) ||
    repo === '.' ||
    repo === '..' ||
    repo.endsWith('.git')
  ) {
    throw new SourceSyntaxError(`invalid GitHub repository: "${repo}"`);
  }

  const commit = COMMIT_HEX.test(ref.toLowerCase()) ? ref.toLowerCase() : undefined;

  return {
    type: 'github',
    owner,
    repo,
    ref,
    ...(commit ? { commit } : {}),
    ...(subdir ? { subdir } : {}),
  };
}

function parseUrlSource(spec: string): UrlSource {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    throw new SourceSyntaxError(`invalid URL: ${spec}`);
  }

  if (url.protocol !== 'https:') {
    throw new SourceSyntaxError('https only: non-https URLs are not read');
  }
  if (url.username !== '' || url.password !== '') {
    throw new SourceSyntaxError('URLs with user credentials are not allowed');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new SourceSyntaxError('non-standard ports are not allowed');
  }
  if (!isHostName(url.hostname)) {
    throw new SourceSyntaxError(
      `host "${url.hostname}" is refused: must be a valid domain name, not localhost or an IP address`,
    );
  }

  const path = url.pathname.toLowerCase();
  if (!path.endsWith('.tgz') && !path.endsWith('.tar.gz') && !path.endsWith('.tar')) {
    throw new SourceSyntaxError('URL must point to a tar archive ending in .tgz, .tar.gz, or .tar');
  }

  if (url.search !== '' || url.hash !== '') {
    throw new SourceSyntaxError('query parameters and fragments are not permitted on archive URLs');
  }

  return { type: 'url', url, host: url.hostname };
}

/**
 * Parses an online source string into a typed OnlineSource.
 * Throws SourceSyntaxError if the source is malformed or violates security boundaries.
 */
export function parseOnlineSource(source: string): OnlineSource {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new SourceSyntaxError(
      'give the package or address to read: npm:<package>[@version], github:<owner>/<repo>[#ref][:subdir], or https://...tgz',
    );
  }
  const text = source.trim();
  if (text.startsWith('npm:')) {
    return parseNpmSource(text.slice('npm:'.length));
  }
  if (text.startsWith('github:')) {
    return parseGitHubSource(text.slice('github:'.length));
  }
  if (text.startsWith('https://')) {
    return parseUrlSource(text);
  }
  if (text.startsWith('http://')) {
    throw new SourceSyntaxError('https only: plain http is refused');
  }
  throw new SourceSyntaxError(
    `unknown source format "${text}": expected npm:<package>, github:<owner>/<repo>, or https://...tgz`,
  );
}
