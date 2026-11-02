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
 * None of this holds where the directory the hook gives is itself in scratch space (`cwdInScope`): the
 * delete of a name under it can be the project, a folder above it or the one beside it.
 *
 * Only a literal path counts: `/tmp`, `/var/tmp`, `/private/tmp`, `/private/var/tmp`, and the per-user
 * temp folder of a Mac spelled out (`/var/folders/<xx>/<id>/T`, with or without `/private`). A variable
 * for the temp directory (`$TMPDIR`, `${TMPDIR:-/tmp}`, `$env:TEMP`) is the shell's to say, and the hook
 * cannot see the shell of the agent: one that keeps its shell across calls can be told `export TMPDIR=$HOME`
 * in one and `rm -rf "$TMPDIR/Documents"` in the next. A variable form keeps the question.
 */

/** The folders that are the system's scratch space, as a path spells them. */
const SYSTEM_ROOTS: readonly string[] = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];
/**
 * The per-user temp folder of a Mac, spelled out: `/var/folders/<two characters>/<id>/T`, which is `/private/var/…`
 * on the disk. The cache folder beside it (`C`) and the others are not scratch space.
 */
const USER_TEMP = /^(?:\/private)?\/var\/folders\/[A-Za-z0-9_]{2}\/[A-Za-z0-9_]+\/T(?=\/|$)/;
/** A word read as a path longer than this is not judged. */
const MAX_TARGET_CHARS = 4096;
/** What a name may hold: nothing a shell expands, splits, escapes or reads as a pattern. */
const NAME = /^[A-Za-z0-9_.@%+,=:-]+$/;
const ONLY_DOTS = /^\.+$/;
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

export interface TempScope {
  /** The folders that are scratch space, spelled as a path names them (the per-user folder of a Mac is known besides). */
  readonly roots: readonly string[];
}

/** What the rest of a line is, asked only when a path needs to know. */
export interface LineFacts {
  /** Every command of the line is one that makes no link and moves nothing. */
  readonly inert: () => boolean;
  /** One more path may be looked up on the disk: a line that names more is not looked at past the budget. */
  readonly probe: () => boolean;
  /** The scratch space of this machine. */
  readonly scope: () => TempScope;
}

const isName = (component: string): boolean => NAME.test(component) && !ONLY_DOTS.test(component);

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path.charAt(end - 1) === '/') end -= 1;
  return path.slice(0, end);
}

const SYSTEM_SCOPE: TempScope = { roots: SYSTEM_ROOTS };

/** The scratch space this machine has: the same on every machine, since a variable is not read. */
export function systemTempScope(): TempScope {
  return SYSTEM_SCOPE;
}

interface Place {
  /** The folder the target is below, and what comes after it. */
  readonly root: string;
  readonly rest: string;
}

function placeOf(target: string, scope: TempScope): Place | null {
  for (const root of scope.roots)
    if (target.startsWith(`${root}/`)) return { root, rest: target.slice(root.length + 1) };
  const user = USER_TEMP.exec(target)?.[0];
  if (user !== undefined && target.startsWith(`${user}/`))
    return { root: user, rest: target.slice(user.length + 1) };
  return null;
}

/** The path is the per-user temp folder of a Mac, or inside it. */
const inUserTemp = (path: string): boolean => USER_TEMP.test(path);

const realRootsOf = new WeakMap<TempScope, readonly string[]>();

/** The folders a path may resolve into: the roots as spelled and as the disk has them, looked up once for a scope. */
function realRoots(scope: TempScope): readonly string[] {
  const known = realRootsOf.get(scope);
  if (known !== undefined) return known;
  // Resolved as the path under them is, so that a folder the machine does not have is still the same place.
  const found = scope.roots.flatMap((root) => {
    const real = resolveThroughLinks(root, '/');
    return real === null ? [root] : [root, real];
  });
  realRootsOf.set(scope, found);
  return found;
}

const inScopeCache = new WeakMap<TempScope, Map<string, boolean>>();

/**
 * Whether the directory the hook gives is itself in scratch space (CI, a `mktemp` sandbox, `/private/tmp`):
 * then `rm -rf /tmp/work/proj` can be the project, `/tmp/work` the folder above it and `/tmp/work/other`
 * the one beside it, and no name under a temp root is routine. A directory that is not an absolute path
 * is not known to be elsewhere. Looked up once for a scope.
 */
function cwdInScope(cwd: string, scope: TempScope): boolean {
  const known = inScopeCache.get(scope)?.get(cwd);
  if (known !== undefined) return known;
  let found = !cwd.startsWith('/');
  if (!found) {
    const real = resolveThroughLinks(cwd, '/');
    const roots = realRoots(scope);
    const within = (path: string): boolean =>
      inUserTemp(path) || roots.some((root) => path === root || path.startsWith(`${root}/`));
    found = within(withoutTrailingSlashes(cwd)) || (real !== null && within(real));
  }
  const cache = inScopeCache.get(scope) ?? new Map<string, boolean>();
  cache.set(cwd, found);
  inScopeCache.set(scope, cache);
  return found;
}

/** The path stays inside scratch space after every link on disk is followed. */
function staysInside(path: string, cwd: string, scope: TempScope): boolean {
  const real = resolveThroughLinks(path, cwd);
  if (real === null) return true;
  return (
    (inUserTemp(real) && real !== (USER_TEMP.exec(real)?.[0] ?? '')) ||
    realRoots(scope).some((root) => real.startsWith(`${root}/`))
  );
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
  if (cwdInScope(cwd, scope)) return false;
  const word = target.replace(/["']/g, '');
  const place = placeOf(word, scope);
  if (place === null) return false;
  const found = namesOf(place.rest);
  if (found === null) return false;
  const deep = found.names.length >= 2 || found.glob;
  if (deep && !line.inert()) return false;
  if (!line.probe()) return false;
  return staysInside(`${place.root}/${found.names.join('/')}`, cwd, scope);
}

/**
 * The commands that make no link and move nothing: they remove, create, list or print. Every
 * other command of a line (`ln`, `mv`, `cp`, `tar`, `git`, an interpreter, a script) may put a
 * link where a later path goes through it.
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

/** The most paths of one line that are looked up on the disk: a line that deletes more is asked about. */
const MAX_PROBES = 32;

/** What the commands of a line are, computed once and only if a path asks. */
export function lineFacts(segments: readonly string[]): LineFacts {
  let inert: boolean | undefined;
  let probes = 0;
  return {
    inert: () => (inert ??= segments.every(isInertSegment)),
    probe: () => (probes += 1) <= MAX_PROBES,
    scope: systemTempScope,
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
