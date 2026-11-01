import { commandWord, SHELL_KEYWORDS } from './shell-segments.js';
import { resolveThroughLinks } from './symlink.js';

/**
 * Whether a recursive delete names a path under the system temp directory and nothing else: the
 * routine `rm -rf /tmp/test_output && mkdir -p /tmp/test_output` an agent runs before a test.
 *
 * `isDangerousRmTarget` calls every absolute path outside the working tree dangerous, which makes
 * the cleanup of a scratch folder a question each time. This says which of those paths is a name
 * in scratch space, and is strict about it: the delete stays a question for the folder itself, for
 * a glob at its first level (`/tmp/*`, `/tmp/.*`, `/tmp/foo*`), for `..` or `.` anywhere, for a
 * trailing slash (`rm -rf /tmp/x/` follows a link at `/tmp/x` to its target, and `/tmp/x` → `~`
 * would delete the home), for any word a shell expands, and for a link that leaves the temp
 * directory.
 *
 * A name is one component, `/tmp/x`: `rm` removes a link at that name as a link, whatever it
 * points to, so nothing the line or the disk holds can make it reach further. A path of more
 * names (`/tmp/a/b`, `/tmp/a/*`) goes through `a`, and a link there leads out. A link already on
 * disk is looked for (`resolveThroughLinks`); one that the same line makes first is not on disk
 * yet, so such a path is judged only when every other command of the line is one that makes no
 * link (`inert`): `ln -s ~ /tmp/a && rm -rf /tmp/a/Documents` is a delete of the home.
 *
 * `$TMPDIR/name` is the same path when the hook's own `TMPDIR` is a temp directory and the line
 * neither sets that variable nor does anything that could (`setsTempDir`, and `inert`). The hook
 * and the agent's shell share their environment; a line that changes it is not trusted.
 */

/** The folders that are the system's scratch space, as a path spells them. */
const SYSTEM_ROOTS: readonly string[] = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];
/** Where a per-user `TMPDIR` may be: macOS keeps it under `/var/folders`. */
const TMPDIR_PLACES: readonly string[] = [...SYSTEM_ROOTS, '/var/folders', '/private/var/folders'];
/** A word read as a path longer than this is not judged. */
const MAX_TARGET_CHARS = 4096;
/** What a name may hold: nothing a shell expands, splits, escapes or reads as a pattern. */
const NAME = /^[A-Za-z0-9_.@%+,=:-]+$/;
const ONLY_DOTS = /^\.+$/;
const VARIABLE_PREFIXES = ['$TMPDIR/', '${TMPDIR}/'] as const;
/** A read of the variable, as a delete names its folder: what is left of a line without them is a way to set it. */
const TMPDIR_READ = /\$TMPDIR(?![A-Za-z0-9_])|\$\{TMPDIR\}/g;
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

export interface TempScope {
  /** The folders that are scratch space, spelled as a path names them. */
  readonly roots: readonly string[];
  /** The hook's `TMPDIR` when it is a temp directory, else null. */
  readonly tmpdir: string | null;
}

/** What the rest of a line is, asked only when a path needs to know. */
export interface LineFacts {
  /** Every command of the line is one that makes no link and moves nothing. */
  readonly inert: () => boolean;
  /** The line names `TMPDIR` other than to read it. */
  readonly setsTempDir: () => boolean;
  /** One more path may be looked up on the disk: a line that names more is not looked at past the budget. */
  readonly probe: () => boolean;
  /** The scratch space of this machine, read once for the line. */
  readonly scope: () => TempScope;
}

const isName = (component: string): boolean => NAME.test(component) && !ONLY_DOTS.test(component);

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path.charAt(end - 1) === '/') end -= 1;
  return path.slice(0, end);
}

/** The hook's `TMPDIR`, when it is an absolute path of names inside a temp place. */
function usableTmpdir(value: string | undefined): string | null {
  if (value === undefined || value.length > MAX_TARGET_CHARS) return null;
  const path = withoutTrailingSlashes(value);
  const inPlace =
    SYSTEM_ROOTS.includes(path) || TMPDIR_PLACES.some((place) => path.startsWith(`${place}/`));
  return inPlace && path.slice(1).split('/').every(isName) ? path : null;
}

/** The scratch space this machine has, read from the environment the hook was started with. */
export function systemTempScope(): TempScope {
  return { roots: SYSTEM_ROOTS, tmpdir: usableTmpdir(process.env['TMPDIR']) };
}

interface Place {
  /** The folder the target is below, and what comes after it. */
  readonly root: string;
  readonly rest: string;
  /** The target reaches the folder through `$TMPDIR`. */
  readonly viaVariable: boolean;
}

function placeOf(target: string, scope: TempScope): Place | null {
  for (const root of scope.roots)
    if (target.startsWith(`${root}/`))
      return { root, rest: target.slice(root.length + 1), viaVariable: false };
  if (scope.tmpdir === null) return null;
  for (const prefix of VARIABLE_PREFIXES)
    if (target.startsWith(prefix))
      return { root: scope.tmpdir, rest: target.slice(prefix.length), viaVariable: true };
  return null;
}

const realRootsOf = new WeakMap<TempScope, readonly string[]>();

/** The folders a path may resolve into: the roots as spelled and as the disk has them, looked up once for a scope. */
function realRoots(scope: TempScope): readonly string[] {
  const known = realRootsOf.get(scope);
  if (known !== undefined) return known;
  const spelled = scope.tmpdir === null ? scope.roots : [...scope.roots, scope.tmpdir];
  // Resolved as the path under them is, so that a folder the machine does not have is still the same place.
  const found = spelled.flatMap((root) => {
    const real = resolveThroughLinks(root, '/');
    return real === null ? [root] : [root, real];
  });
  realRootsOf.set(scope, found);
  return found;
}

/** The path stays inside scratch space after every link on disk is followed. */
function staysInside(path: string, cwd: string, scope: TempScope): boolean {
  const real = resolveThroughLinks(path, cwd);
  if (real === null) return true;
  return realRoots(scope).some((root) => real.startsWith(`${root}/`));
}

/** What a target is below its folder: the names, and whether it ends in `*`, or null when it is neither. */
function namesOf(
  rest: string,
): { readonly names: readonly string[]; readonly glob: boolean } | null {
  const parts = rest.split('/');
  // `/tmp/x/*` is everything inside `x`; `*` at the first level is everything in the folder.
  const glob = parts.length >= 2 && parts[parts.length - 1] === '*';
  const names = glob ? parts.slice(0, -1) : parts;
  return names.every(isName) ? { names, glob } : null;
}

/**
 * Whether `target`, a word of a recursive `rm`, names a path in scratch space and nothing else.
 * Quotes are taken off, as `isDangerousRmTarget` takes them.
 */
export function isNamedTempTarget(
  target: string,
  line: LineFacts,
  cwd: string,
  scope: TempScope = line.scope(),
): boolean {
  if (target.length > MAX_TARGET_CHARS) return false;
  const word = target.replace(/["']/g, '');
  const place = placeOf(word, scope);
  if (place === null) return false;
  const found = namesOf(place.rest);
  if (found === null) return false;
  const deep = found.names.length >= 2 || found.glob;
  if ((deep || place.viaVariable) && !line.inert()) return false;
  if (place.viaVariable && line.setsTempDir()) return false;
  if (!line.probe()) return false;
  return staysInside(`${place.root}/${found.names.join('/')}`, cwd, scope);
}

/**
 * The commands that make no link and move nothing: they remove, create, list or print. Every
 * other command of a line (`ln`, `mv`, `cp`, `tar`, `git`, an interpreter, a script) may put a
 * link where a later path goes through it, and `export` or `source` may change `TMPDIR`.
 */
const INERT_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'mkdir',
  'cd',
  'pushd',
  'popd',
  'ls',
  'pwd',
  'echo',
  'true',
  'false',
  ':',
  'test',
  '[',
  '[[',
  'touch',
  'cat',
  'head',
  'tail',
  'wc',
  'sleep',
  'date',
  'stat',
]);

function isInertSegment(segment: string): boolean {
  const text = segment.trim();
  if (text === '' || SHELL_KEYWORDS.has(text)) return true;
  return !SUBSTITUTION.test(text) && INERT_COMMANDS.has(commandWord(text));
}

/** The text with its quotes and escapes off, and each read of `$TMPDIR` taken out. */
const withoutReads = (segment: string): string =>
  segment.replace(/["'\\]/g, '').replace(TMPDIR_READ, '');

/** The most paths of one line that are looked up on the disk: a line that deletes more is asked about. */
const MAX_PROBES = 32;

/** What the commands of a line are, computed once and only if a path asks. */
export function lineFacts(segments: readonly string[]): LineFacts {
  let inert: boolean | undefined;
  let sets: boolean | undefined;
  let scope: TempScope | undefined;
  let probes = 0;
  return {
    inert: () => (inert ??= segments.every(isInertSegment)),
    setsTempDir: () =>
      (sets ??= segments.some((segment) => withoutReads(segment).includes('TMPDIR'))),
    probe: () => (probes += 1) <= MAX_PROBES,
    scope: () => (scope ??= systemTempScope()),
  };
}

/**
 * Whether a shell would cut a word of `segment` where the reading of it by white space does not:
 * a quote or an escape that holds a blank. `rm -rf "/tmp/a b/../.."` is the path `/tmp`, and read
 * by blanks it is `/tmp/a` and `b/../..`, the second of which is a name in the project.
 */
export function cutsAWordApart(segment: string): boolean {
  let quote = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (quote === '') {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '\\') {
        i += 1;
        if (/\s/.test(segment.charAt(i))) return true;
      }
    } else if (ch === quote) quote = '';
    else if (quote === '"' && ch === '\\') i += 1;
    else if (/\s/.test(ch)) return true;
  }
  // A quote that does not close is a word that runs to the end of the line.
  return quote !== '';
}
