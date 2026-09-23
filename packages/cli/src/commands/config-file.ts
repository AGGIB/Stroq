import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Seconds Stroq writes on every hook entry it installs for Claude Code, Cursor and
 * Codex. Copilot is the exception and has its own `COPILOT_HOOK_TIMEOUT_SECONDS`:
 * there a timeout is an ALLOW, so a shorter budget is less safe rather than more.
 */
export const HOOK_TIMEOUT_SECONDS = 15;

/**
 * How much of the host agent's timeout Stroq allows itself before answering with a
 * fail-closed verdict of its own.
 *
 * Every agent that times a hook out treats the timeout as an allow — Claude Code
 * cancels the hook and lets the tool call continue through the normal permission
 * flow, Codex reports a hook failure and proceeds, Copilot discards the late deny —
 * so a hook that runs long does not merely lose its explanation, it loses its
 * verdict. Stroq answers first: 60% leaves room for process teardown and for a
 * machine slower than the one that measured this.
 *
 * The margin over real work: the only wall-clock budget in the decision path is the
 * scanner's `DEFAULT_BUDGET_MS`, and a cold Node start is around 100 ms. That budget
 * is 4,000 ms, so the worst case answers at about 4.1 s against this deadline's
 * 9,000 ms. It was 500 ms when this paragraph was first written, and the number is
 * repeated here rather than imported because the two are a RELATIONSHIP — if the
 * scanner's budget ever approaches this deadline, a slow scan stops being answered
 * by Stroq and starts being answered by the agent's timeout, which every agent
 * treats as an allow.
 */
export const HOOK_DEADLINE_FRACTION = 0.6;

export const hookDeadlineMs = (agentTimeoutSeconds: number): number =>
  Math.round(agentTimeoutSeconds * 1000 * HOOK_DEADLINE_FRACTION);

/**
 * Where a JSON parse failed, without the text around it.
 *
 * V8's message quotes the input near the error — `Unexpected token 'o', "//registry"...`.
 * A config path can be a symlink someone else chose, pointed at `~/.npmrc`, and then
 * that quote is the start of a credential file, printed to the terminal and, when an
 * agent ran the command, sent to its model.
 */
function parseFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  const where = /\(line \d+ column \d+\)|at position \d+/.exec(message)?.[0];
  return where === undefined ? 'not valid JSON' : `not valid JSON ${where}`;
}

/**
 * The most an agent config may be. Real ones are a few kilobytes; the bound exists so
 * a file that is not one cannot take the process down reading it.
 */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/**
 * Reads an agent's JSON config. A missing or empty file is an empty object.
 *
 * Only a regular file within `MAX_CONFIG_BYTES` is read. A repository can commit
 * `.claude/settings.json` as a symlink to `/dev/zero`, and `doctor`, `init` and
 * `exposure` then read an endless stream until the process ran out of memory; the
 * same check already guards `inspect` and the secret index.
 */
export function readJsonObject<T extends object>(file: string): T {
  if (!existsSync(file)) return {} as T;
  const info = statSync(file);
  if (!info.isFile()) throw new Error(`cannot read ${file}: not a regular file`);
  if (info.size > MAX_CONFIG_BYTES)
    throw new Error(`cannot read ${file}: ${info.size} bytes is too large for an agent config`);
  const text = readFileSync(file, 'utf8');
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${parseFailure(err)}`, { cause: err });
  }
}

const within = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The real path `file` resolves to, through its nearest existing ancestor. */
function realTarget(file: string): string {
  const pending: string[] = [];
  let at = resolve(file);
  for (;;) {
    try {
      return resolve(realpathSync(at), ...pending);
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(file);
      pending.unshift(basename(at));
      at = parent;
    }
  }
}

/**
 * Refuses a write that a symlink would carry outside the tree the path belongs to.
 *
 * A project's `.claude/settings.json` is chosen by whoever wrote the repository. Made
 * a link to a JSON file elsewhere, `stroq init` merged its hooks into that file — a
 * write outside the project, into a file the repository's author picked. The tree a
 * path belongs to is the deepest of the working directory and the home directory
 * that contains it, so a user-scope file linked into `~/dotfiles` (as stow does) is
 * still written, and a path in neither, named explicitly with `--config`, is not
 * second-guessed.
 */
function assertStaysInside(file: string): void {
  const requested = resolve(file);
  const roots = [process.cwd(), homedir()]
    .map((root) => resolve(root))
    .filter((root) => within(requested, root))
    .sort((a, b) => b.length - a.length);
  const root = roots[0];
  if (root === undefined) return;
  const realRoot = realTarget(root);
  const target = realTarget(requested);
  if (!within(target, realRoot)) {
    throw new Error(
      `refusing to write ${file}: it resolves to ${target}, outside ${root}. A symlink in the path leads out of it; replace it with a regular file first.`,
    );
  }
}

/** Writes an agent's JSON config with a trailing newline, creating its directory. */
export function writeJsonObject(file: string, value: unknown): void {
  assertStaysInside(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A plain JSON object — not an array, not `null`. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One event's hook groups with Stroq's own handlers removed, so re-installing
 * replaces the entry instead of stacking a second one. Shared by the Claude Code
 * and Codex installers, which differ only in how they recognise their own handler.
 *
 * A "group" that is not an object at all (a `null` left by a hand-edit, a bare
 * string) is dropped: reading `.hooks` off it is how this used to throw and take
 * the whole install down with it, and it is not user content worth preserving. A
 * group whose `hooks` is not an array is kept untouched — malformed, but the
 * user's, and rewriting it would lose a hook Stroq does not own.
 */
export function withoutStroqGroups<T>(
  groups: readonly unknown[],
  isOurs: (handler: unknown) => boolean,
): T[] {
  return groups
    .filter(isPlainObject)
    .map((group) =>
      Array.isArray(group['hooks'])
        ? { ...group, hooks: group['hooks'].filter((handler: unknown) => !isOurs(handler)) }
        : group,
    )
    .filter((group) => !Array.isArray(group['hooks']) || group['hooks'].length > 0) as T[];
}
