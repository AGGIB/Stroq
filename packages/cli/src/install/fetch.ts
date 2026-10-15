// Safe Install network layer (`stroq vet --online`).
//
// The only network module in the CLI: an injectable Transport, HTTPS only, at most 3 redirects to
// the source's own hosts, IP literals and localhost refused, Accept-Encoding: identity, no tokens and
// no .npmrc. The limits of Safe Install apply, and the stream is cut if compressed bytes exceed 20 MiB.
import { createHash } from 'node:crypto';
import { readTarArchive } from './archive-tar.js';
import {
  isHostName,
  type GitHubSource,
  type NpmSource,
  type OnlineSource,
  type UrlSource,
} from './source.js';
import { buildTree } from './tree.js';
import { LIMITS, type SourceRef, type Tree, type TreeEntry } from './types.js';

export type FetchErrorCode =
  | 'https-only'
  | 'forbidden-host'
  | 'too-many-redirects'
  | 'bad-redirect'
  | 'timeout'
  | 'limit'
  | 'not-found'
  | 'bad-status'
  | 'no-integrity'
  | 'bad-integrity'
  | 'bad-source'
  | 'unreadable';

export class FetchError extends Error {
  readonly code: FetchErrorCode;

  constructor(code: FetchErrorCode, message: string) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}

export interface HttpRequestOptions {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: {
    get(name: string): string | null;
  };
  readonly body: Uint8Array;
}

export type Transport = (url: URL, options: HttpRequestOptions) => Promise<HttpResponse>;

export interface FetchOptions {
  readonly transport?: Transport;
  readonly onHost?: (host: string) => void;
  readonly signal?: AbortSignal;
}

export interface FetchedTree {
  readonly tree: Tree;
  readonly blindSpots: readonly string[];
  readonly sourceRef: SourceRef;
}

const MAX_REDIRECTS = 3;
const NPM_REGISTRY_HOST = 'registry.npmjs.org';
const GITHUB_CODELOAD_HOST = 'codeload.github.com';

async function readStreamBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel();
        throw new FetchError('limit', `the compressed archive is over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // ignore secondary cancel error
    }
    throw err;
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export const defaultTransport: Transport = async (url, options) => {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
  }
  const init: RequestInit = {
    method: 'GET',
    redirect: 'manual',
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const response = await fetch(url, init);

  const headers = {
    get(name: string): string | null {
      return response.headers.get(name);
    },
  };

  const cl = response.headers.get('content-length');
  if (cl !== null) {
    const len = Number(cl);
    if (len > LIMITS.maxCompressed) {
      throw new FetchError('limit', `the compressed archive is over ${LIMITS.maxCompressed} bytes`);
    }
  }

  if (response.body) {
    const body = await readStreamBody(response.body.getReader(), LIMITS.maxCompressed);
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    };
  }

  const ab = await response.arrayBuffer();
  if (ab.byteLength > LIMITS.maxCompressed) {
    throw new FetchError('limit', `the compressed archive is over ${LIMITS.maxCompressed} bytes`);
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: new Uint8Array(ab),
  };
};

interface FetchState {
  readonly startedAt: number;
  readonly transport: Transport;
  readonly onHost?: (host: string) => void;
  readonly reportedHosts: Set<string>;
  readonly customSignal?: AbortSignal;
}

function checkHostSafety(host: string, allowlist: readonly string[]): void {
  if (host === 'localhost' || !isHostName(host)) {
    throw new FetchError(
      'forbidden-host',
      `host "${host}" is refused: must be a valid domain name, not localhost or an IP address`,
    );
  }
  if (!allowlist.includes(host)) {
    let message = `host "${host}" is not in the source allowlist (${allowlist.join(', ')})`;
    if (host === 'codeload.github.com') {
      message += '; for GitHub repositories use the github:<owner>/<repo>[#<ref>][:subdir] format';
    }
    throw new FetchError('forbidden-host', message);
  }
}

interface RequestTimeoutScope {
  readonly controller: AbortController;
  readonly timeoutMessage: string;
  dispose(): void;
}

function setupRequestTimeout(state: FetchState): RequestTimeoutScope {
  const elapsedTotal = Date.now() - state.startedAt;
  const remainingTotal = LIMITS.totalMs - elapsedTotal;
  if (remainingTotal <= 0) {
    throw new FetchError(
      'timeout',
      `fetch timed out: exceeded total limit of ${LIMITS.totalMs / 1000} s`,
    );
  }

  const isTotalCap = remainingTotal <= LIMITS.perRequestMs;
  const timeoutMs = Math.min(LIMITS.perRequestMs, remainingTotal);
  const timeoutMessage = isTotalCap
    ? `fetch timed out: exceeded total limit of ${LIMITS.totalMs / 1000} s`
    : `request timed out after ${timeoutMs / 1000} s`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new FetchError('timeout', timeoutMessage));
  }, timeoutMs);

  const onCustomAbort = () => {
    controller.abort(state.customSignal?.reason);
  };
  if (state.customSignal) {
    state.customSignal.addEventListener('abort', onCustomAbort, { once: true });
  }

  return {
    controller,
    timeoutMessage,
    dispose() {
      clearTimeout(timeoutId);
      if (state.customSignal) {
        state.customSignal.removeEventListener('abort', onCustomAbort);
      }
    },
  };
}

async function requestWithPolicy(
  initialUrl: URL,
  allowlist: readonly string[],
  customHeaders: Record<string, string>,
  state: FetchState,
): Promise<HttpResponse> {
  let currentUrl = initialUrl;
  let redirects = 0;

  for (;;) {
    if (currentUrl.protocol !== 'https:') {
      throw new FetchError('https-only', 'https only: non-https URLs are refused');
    }
    checkHostSafety(currentUrl.hostname, allowlist);

    if (!state.reportedHosts.has(currentUrl.hostname)) {
      state.reportedHosts.add(currentUrl.hostname);
      state.onHost?.(currentUrl.hostname);
    }

    if (state.customSignal?.aborted) {
      throw (
        state.customSignal.reason ?? new DOMException('This operation was aborted', 'AbortError')
      );
    }

    const timeoutScope = setupRequestTimeout(state);
    const headers: Record<string, string> = {
      'accept-encoding': 'identity',
      ...customHeaders,
    };

    let response: HttpResponse;
    try {
      response = await state.transport(currentUrl, {
        headers,
        signal: timeoutScope.controller.signal,
      });
    } catch (err) {
      if (err instanceof FetchError) throw err;
      if (state.customSignal?.aborted) {
        throw (
          state.customSignal.reason ?? new DOMException('This operation was aborted', 'AbortError')
        );
      }
      if (timeoutScope.controller.signal.aborted) {
        throw new FetchError('timeout', timeoutScope.timeoutMessage);
      }
      throw new FetchError(
        'unreadable',
        `request to ${currentUrl.origin} failed: ${(err as Error).message}`,
      );
    } finally {
      timeoutScope.dispose();
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw new FetchError(
          'too-many-redirects',
          `too many redirects: at most ${MAX_REDIRECTS} are followed`,
        );
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new FetchError('bad-redirect', 'redirect response missing Location header');
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new FetchError('bad-redirect', `invalid redirect Location: ${location}`);
      }
      continue;
    }

    if (response.status === 404) {
      throw new FetchError('not-found', `resource not found (HTTP 404): ${currentUrl.pathname}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new FetchError(
        'bad-status',
        `server returned HTTP ${response.status} ${response.statusText ?? ''}`.trim(),
      );
    }

    if (response.body.length > LIMITS.maxCompressed) {
      throw new FetchError('limit', `the compressed archive is over ${LIMITS.maxCompressed} bytes`);
    }

    return response;
  }
}

function filterSubdirTree(tree: Tree, subdir: string): Tree {
  const prefix = subdir.endsWith('/') ? subdir : `${subdir}/`;
  const matching: TreeEntry[] = [];
  for (const entry of tree.entries) {
    if (entry.path.startsWith(prefix)) {
      const strippedPath = entry.path.slice(prefix.length);
      matching.push({
        ...entry,
        path: strippedPath,
      });
    }
  }
  if (matching.length === 0) {
    throw new FetchError('not-found', `the archive does not hold the subdirectory "${subdir}"`);
  }
  return buildTree(matching, { complete: true });
}

async function fetchNpm(source: NpmSource, state: FetchState): Promise<FetchedTree> {
  const encodedName = source.name.startsWith('@')
    ? `@${encodeURIComponent(source.name.slice(1))}`
    : encodeURIComponent(source.name);
  const metadataUrl = new URL(
    `https://${NPM_REGISTRY_HOST}/${encodedName}/${encodeURIComponent(source.version)}`,
  );

  const metadataRes = await requestWithPolicy(
    metadataUrl,
    [NPM_REGISTRY_HOST],
    { accept: 'application/json, application/vnd.npm.install-v1+json;q=0.9' },
    state,
  );

  let doc: Record<string, unknown>;
  try {
    const text = Buffer.from(metadataRes.body).toString('utf8');
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new FetchError(
      'unreadable',
      `invalid registry response for ${source.name}: not valid JSON`,
    );
  }

  const resolvedVersion = typeof doc['version'] === 'string' ? doc['version'] : source.version;
  const dist = (doc['dist'] ?? {}) as Record<string, unknown>;
  const tarballUrlStr = dist['tarball'];
  const integrity = dist['integrity'];

  if (typeof tarballUrlStr !== 'string' || tarballUrlStr.length === 0) {
    throw new FetchError(
      'bad-source',
      `registry metadata for ${source.name}@${resolvedVersion} is missing dist.tarball`,
    );
  }
  let tarballUrl: URL;
  try {
    tarballUrl = new URL(tarballUrlStr);
  } catch {
    throw new FetchError('bad-source', `invalid tarball URL in registry: ${tarballUrlStr}`);
  }

  if (tarballUrl.origin !== `https://${NPM_REGISTRY_HOST}`) {
    throw new FetchError(
      'bad-source',
      `npm tarball origin (${tarballUrl.origin}) does not match registry (https://${NPM_REGISTRY_HOST})`,
    );
  }

  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new FetchError(
      'no-integrity',
      `package ${source.name}@${resolvedVersion} has no sha-512 integrity in the registry`,
    );
  }

  const tarballRes = await requestWithPolicy(tarballUrl, [NPM_REGISTRY_HOST], {}, state);

  const calculatedHash = createHash('sha512').update(tarballRes.body).digest('base64');
  const calculatedIntegrity = `sha512-${calculatedHash}`;
  if (calculatedIntegrity !== integrity) {
    throw new FetchError(
      'bad-integrity',
      `integrity mismatch for ${source.name}@${resolvedVersion}: expected ${integrity}, got ${calculatedIntegrity}`,
    );
  }

  const archiveRead = readTarArchive(tarballRes.body);

  const sourceRef: SourceRef = {
    type: 'npm',
    name: source.name,
    version: resolvedVersion,
    integrity,
  };

  return {
    tree: archiveRead.tree,
    blindSpots: archiveRead.blindSpots,
    sourceRef,
  };
}

async function fetchGitHub(source: GitHubSource, state: FetchState): Promise<FetchedTree> {
  const codeloadUrl = new URL(
    `https://${GITHUB_CODELOAD_HOST}/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/tar.gz/${encodeURIComponent(source.ref)}`,
  );

  const tarballRes = await requestWithPolicy(codeloadUrl, [GITHUB_CODELOAD_HOST], {}, state);

  const archiveRead = readTarArchive(tarballRes.body);

  if (source.commit && archiveRead.commit && source.commit !== archiveRead.commit) {
    throw new FetchError(
      'bad-source',
      `commit mismatch for github:${source.owner}/${source.repo}#${source.ref}: requested ${source.commit} but server claimed ${archiveRead.commit}`,
    );
  }

  const commit = archiveRead.commit ?? source.commit ?? undefined;

  let tree = archiveRead.tree;
  if (source.subdir) {
    tree = filterSubdirTree(tree, source.subdir);
  }

  const sourceRef: SourceRef = {
    type: 'github',
    owner: source.owner,
    repo: source.repo,
    ref: source.ref,
    ...(commit ? { commit } : {}),
    ...(source.subdir ? { subdir: source.subdir } : {}),
  };

  return {
    tree,
    blindSpots: archiveRead.blindSpots,
    sourceRef,
  };
}

async function fetchUrl(source: UrlSource, state: FetchState): Promise<FetchedTree> {
  const tarballRes = await requestWithPolicy(source.url, [source.host], {}, state);

  const archiveRead = readTarArchive(tarballRes.body);

  const sourceRef: SourceRef = {
    type: 'url',
    host: source.host,
  };

  return {
    tree: archiveRead.tree,
    blindSpots: archiveRead.blindSpots,
    sourceRef,
  };
}

/**
 * Fetches an online source and returns its in-memory Tree, blind spots, and resolved SourceRef.
 */
export async function fetchSourceTree(
  source: OnlineSource,
  options: FetchOptions = {},
): Promise<FetchedTree> {
  const state: FetchState = {
    startedAt: Date.now(),
    transport: options.transport ?? defaultTransport,
    reportedHosts: new Set<string>(),
    ...(options.onHost ? { onHost: options.onHost } : {}),
    ...(options.signal ? { customSignal: options.signal } : {}),
  };

  switch (source.type) {
    case 'npm':
      return fetchNpm(source, state);
    case 'github':
      return fetchGitHub(source, state);
    case 'url':
      return fetchUrl(source, state);
  }
}
