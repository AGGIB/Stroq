import type { PathRules } from './types.js';

/**
 * Whether a path is inside the part of the disk a task may read or write.
 *
 * This is not `normalizePathForMatch` of the classifier, and the difference is the point. That
 * function lower-cases everything because it asks "might this be a protected file", where
 * over-matching only costs a question. Here a match is a PERMISSION, so case is folded only
 * where the file system really folds it, and the caller says so (`foldCase`), which also lets
 * a test run Windows behaviour on any machine.
 *
 * The glob language is small on purpose: `*` (any run inside one segment, dot files
 * included), `?` (one character), `**` as a whole segment (any number of segments, none
 * included) and literals. No brackets, braces or negation: a feature that is not there cannot
 * be misread by whoever wrote the scope. Globs are anchored and absolute.
 */

export type PathVerdict = 'allow' | 'deny' | 'outside';

export interface PathOptions {
  readonly flavor: 'posix' | 'win32';
  /** Fold allow globs only when the file system is known to treat `A` and `a` as one name. */
  readonly foldCase: boolean;
  /** Separate conservative deny matching; defaults to foldCase for explicit options. */
  readonly denyFoldCase?: boolean;
}

export interface PathResource {
  /** The path as the call wrote it. */
  readonly path: string;
  /** The path once symlinks are resolved. When present, it must pass the same rules. */
  readonly real?: string | undefined;
}

export function defaultPathOptions(): PathOptions {
  const platform = process.platform;
  return {
    flavor: platform === 'win32' ? 'win32' : 'posix',
    // macOS supports both sensitive and insensitive volumes. The launcher should inject
    // verified semantics; until then exact allows avoid granting a distinct path, while
    // folded denies also protect aliases on insensitive volumes.
    foldCase: platform === 'win32',
    denyFoldCase: platform === 'win32' || platform === 'darwin',
  };
}

/** No file system takes a longer path; a longer one is not a path, it is an attack on the matcher. */
const MAX_PATH_CHARS = 4096;

const STAR = 42;
const QUESTION = 63;

interface Normalized {
  readonly root: string;
  readonly segments: readonly string[];
}

/** Windows drops trailing dots and spaces from a name, and writing `f:stream` writes `f`. */
function cleanWindowsSegment(segment: string): string {
  const colon = segment.indexOf(':');
  let end = colon >= 0 ? colon : segment.length;
  while (end > 0 && segment[end - 1] === ' ') end -= 1;
  const spaced = segment.slice(0, end);
  if (spaced === '.' || spaced === '..') return spaced;
  while (end > 0 && (segment[end - 1] === '.' || segment[end - 1] === ' ')) end -= 1;
  return segment.slice(0, end);
}

function splitRoot(text: string, flavor: PathOptions['flavor']): [string, string] | null {
  if (flavor === 'posix') return text.startsWith('/') ? ['/', text.slice(1)] : null;
  let path = text.replace(/\\/g, '/');
  if (/^\/\/[?.]\//.test(path)) {
    path = path.slice(4);
    if (/^unc\//i.test(path)) path = `//${path.slice(4)}`;
  }
  if (/^[A-Za-z]:\//.test(path)) return [`${path[0]?.toLowerCase()}:`, path.slice(3)];
  const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path);
  if (unc) return [`//${unc[1]}/${unc[2]}`, path.slice(unc[0].length)];
  return null;
}

/**
 * The root and the segments of an absolute path, lexically resolved, or null when the text is
 * not an absolute path of this flavour (or, for a glob, has a `.` or `..` segment, which a
 * glob is never allowed to resolve).
 */
function normalize(raw: string, opts: PathOptions, isGlob: boolean): Normalized | null {
  if (raw.length === 0 || raw.length > MAX_PATH_CHARS || raw.includes('\0')) return null;
  const text = opts.foldCase ? raw.normalize('NFC').toLowerCase() : raw;
  const split = splitRoot(text, opts.flavor);
  if (split === null) return null;
  const segments: string[] = [];
  for (const part of split[1].split('/')) {
    const segment = opts.flavor === 'win32' ? cleanWindowsSegment(part) : part;
    if (segment === '') continue;
    if (segment === '.' || segment === '..') {
      if (isGlob) return null;
      if (segment === '..') segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { root: split[0], segments };
}

type GlobSegment =
  | { readonly kind: 'globstar' }
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'wild'; readonly pattern: readonly number[] };

interface CompiledGlob {
  readonly root: string;
  readonly segments: readonly GlobSegment[];
}

function compileSegment(segment: string): GlobSegment {
  if (segment === '**') return { kind: 'globstar' };
  if (!segment.includes('*') && !segment.includes('?')) return { kind: 'literal', text: segment };
  // `**` inside a name is no more than `*`: one run of characters, never a slash.
  const pattern = Array.from(segment.replace(/\*{2,}/g, '*'), (c) => c.codePointAt(0) as number);
  return { kind: 'wild', pattern };
}

function compileGlob(glob: string, opts: PathOptions): CompiledGlob | null {
  const normalized = normalize(glob, opts, true);
  if (normalized === null) return null;
  return { root: normalized.root, segments: normalized.segments.map(compileSegment) };
}

/** `*` and `?` over code points, with the usual single backtrack point: no exponential case. */
function wildMatches(pattern: readonly number[], text: readonly number[]): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const c = pattern[p];
    if (p < pattern.length && c === STAR) {
      starP = p;
      starT = t;
      p += 1;
    } else if (p < pattern.length && (c === QUESTION || c === text[t])) {
      p += 1;
      t += 1;
    } else if (starP >= 0) {
      starT += 1;
      p = starP + 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (pattern[p] === STAR) p += 1;
  return p === pattern.length;
}

/** Whether the segments of `glob` match the segments of a path, `**` taking any number of them. */
function segmentsMatch(glob: readonly GlobSegment[], path: readonly string[]): boolean {
  const codePoints: Array<number[] | undefined> = [];
  const cps = (j: number): number[] =>
    (codePoints[j] ??= Array.from(path[j] as string, (c) => c.codePointAt(0) as number));
  let reach = new Uint8Array(path.length + 1);
  reach[0] = 1;
  for (const segment of glob) {
    const next = new Uint8Array(path.length + 1);
    let any = false;
    for (let j = 0; j <= path.length; j += 1) {
      if (segment.kind === 'globstar') {
        next[j] = reach[j] === 1 || (j > 0 && next[j - 1] === 1) ? 1 : 0;
      } else if (j > 0 && reach[j - 1] === 1) {
        const text = path[j - 1] as string;
        next[j] =
          segment.kind === 'literal'
            ? Number(segment.text === text)
            : Number(wildMatches(segment.pattern, cps(j - 1)));
      }
      if (next[j] === 1) any = true;
    }
    if (!any) return false;
    reach = next;
  }
  return reach[path.length] === 1;
}

const globMatches = (glob: CompiledGlob, path: Normalized): boolean =>
  glob.root === path.root && segmentsMatch(glob.segments, path.segments);

/**
 * `deny` if any deny glob matches the path or its real path (a deny glob that cannot be read
 * denies everything: a deny that matches less than it says is the failure to avoid). Otherwise
 * `allow` only if the path AND its real path, when there is one, are each inside an allow glob;
 * else `outside`. A path that is not absolute is `outside`.
 */
export function evaluatePath(
  rules: PathRules,
  resource: PathResource,
  opts: PathOptions,
): PathVerdict {
  const subjects = [resource.path, ...(resource.real === undefined ? [] : [resource.real])];
  const paths = subjects.map((subject) => normalize(subject, opts, false));
  const known = paths.filter((path): path is Normalized => path !== null);

  const denyOpts = { ...opts, foldCase: opts.denyFoldCase ?? opts.foldCase };
  const denyPaths = subjects
    .map((subject) => normalize(subject, denyOpts, false))
    .filter((path): path is Normalized => path !== null);
  const denies = rules.deny.map((glob) => compileGlob(glob, denyOpts));
  if (denies.some((glob) => glob === null)) return 'deny';
  if (denyPaths.some((path) => denies.some((glob) => globMatches(glob as CompiledGlob, path)))) {
    return 'deny';
  }
  if (known.length < paths.length) return 'outside';

  const allows = rules.allow
    .map((glob) => compileGlob(glob, opts))
    .filter((glob): glob is CompiledGlob => glob !== null);
  return known.every((path) => allows.some((glob) => globMatches(glob, path)))
    ? 'allow'
    : 'outside';
}
