import { homedir } from 'node:os';
import { join } from 'node:path';
import { WINDSURF_EVENTS, type WindsurfEvent } from '../adapters/windsurf.js';
import {
  isPlainObject,
  parseConfigJson,
  readConfigText,
  readJsonObject,
  writeJsonObject,
} from './config-file.js';

/**
 * Windsurf merges ONE hooks file per level — system, then user, then workspace — with
 * no per-file loading, so Stroq's entries share a file with the user's own and `init`
 * has to merge into it, exactly as it does for Cursor's `.cursor/hooks.json`. Every
 * foreign entry, every foreign event and every other key of the file is preserved.
 */

export interface WindsurfHookEntry {
  readonly command: string;
  /** Written for Windows, untested there; Windsurf picks this one on PowerShell. */
  readonly powershell?: string;
  /** Puts Stroq's stderr in front of the user in the Cascade UI. */
  readonly show_output?: boolean;
  /**
   * Never written by Stroq: its default is the workspace root, which is the trusted
   * directory the adapter's policy `cwd` relies on. Declared only because a user's
   * own entry in the same file may carry it.
   */
  readonly working_directory?: string;
}

export type WindsurfHooksJson = {
  readonly hooks?: Readonly<Record<string, readonly WindsurfHookEntry[]>>;
} & Record<string, unknown>;

/**
 * Stroq's own entries, identified by the command suffix `init` writes. Anchored at
 * the end of the string, so a Copilot or OpenClaw entry — which carries a trailing
 * `pre`/`post` — is never mistaken for one of these.
 */
export const isStroqWindsurfHook = (entry: WindsurfHookEntry): boolean =>
  typeof entry?.command === 'string' && / hook windsurf$/.test(entry.command);

/**
 * The entry Stroq installs on every one of its six events. No `version` (the format
 * has none), no `working_directory` (see above) and no timeout parameter (Windsurf
 * has no such key — which is exactly why the adapter answers in well under a second
 * and the README says to install `@stroq/cli` globally).
 */
export function windsurfEntry(command: string): WindsurfHookEntry {
  // `&` is PowerShell's call operator: without it a quoted path is echoed, not run.
  return { command, powershell: `& ${command}`, show_output: true };
}

/**
 * An entry that is not even a plain object (`null` left by a hand-edit, a bare string
 * or number) is dropped rather than preserved: it is not user content worth keeping,
 * and letting it through would put a non-object where every reader of this file —
 * Windsurf included — expects `{ command, ... }`.
 */
function existingEntries(
  hooks: Readonly<Record<string, readonly WindsurfHookEntry[]>>,
  event: WindsurfEvent,
): readonly WindsurfHookEntry[] {
  const entries = hooks[event];
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is WindsurfHookEntry => isPlainObject(entry));
}

/**
 * Adds Stroq's entry to each of the six events, dropping any older Stroq entry first,
 * so re-running `init` is idempotent and an upgrade replaces the command rather than
 * stacking a second one. Foreign entries, foreign events and every other key of the
 * file are preserved untouched.
 */
export function mergeWindsurfHooks(
  settings: WindsurfHooksJson,
  command: string,
): WindsurfHooksJson {
  // A hand-mangled `hooks: "…"` or `hooks: [...]` is not a record: spreading it below
  // (`{ ...hooks, ...ours }`) would otherwise fan a string or an array out into
  // `"0"`, `"1"`, … keys in the written file. Neither is user content worth
  // preserving in that shape, so it is dropped like the other malformed cases this
  // function already tolerates.
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const ours = Object.fromEntries(
    WINDSURF_EVENTS.map((event): [WindsurfEvent, WindsurfHookEntry[]] => [
      event,
      [
        ...existingEntries(hooks, event).filter((entry) => !isStroqWindsurfHook(entry)),
        windsurfEntry(command),
      ],
    ]),
  );
  return { ...settings, hooks: { ...hooks, ...ours } };
}

const eventEntries = (json: unknown, event: string): readonly unknown[] => {
  if (!isPlainObject(json)) return [];
  const hooks = json['hooks'];
  if (!isPlainObject(hooks)) return [];
  const entries = hooks[event];
  return Array.isArray(entries) ? entries : [];
};

const isStroqEntry = (value: unknown): boolean =>
  isPlainObject(value) &&
  typeof value['command'] === 'string' &&
  / hook windsurf$/.test(value['command']);

/**
 * True only when ALL SIX events carry a Stroq entry. `init` always writes all six, so
 * a file with fewer is a half-install — a `pre` without its `post` never taints, a
 * `post` without its `pre` never blocks — and reporting it as installed would leave
 * a user believing in protection they do not have.
 */
export const isStroqWindsurfHooks = (json: unknown): boolean =>
  WINDSURF_EVENTS.every((event) => eventEntries(json, event).some(isStroqEntry));

/**
 * Whether EVERY one of the six events holds exactly the entry `init` writes for `command`:
 * the command as recorded, the PowerShell form beside it, `show_output`, and no other key. A
 * hooks file is a repository's to write, and the weaker questions each have a forgery: six
 * commands that end ` hook windsurf` (any program can), the recorded command somewhere in the
 * text (a note holds it), the real entry on one event and no-ops on the rest, or the real
 * command with a `working_directory` that moves the hook out of the workspace root.
 */
export function carriesRecordedEntries(json: unknown, command: string): boolean {
  return WINDSURF_EVENTS.every((event) =>
    eventEntries(json, event).some((entry) => isRecordedEntry(entry, command)),
  );
}

/** Whether `entry` is exactly the entry `init` writes for `command`, key for key. */
export function isRecordedEntry(entry: unknown, command: string): boolean {
  const wanted = Object.entries(windsurfEntry(command));
  return (
    isPlainObject(entry) &&
    Object.keys(entry).length === wanted.length &&
    wanted.every(([key, value]) => entry[key] === value)
  );
}

/**
 * The workspace file by default. `--user` writes the Windsurf IDE's own user file,
 * `~/.codeium/windsurf/hooks.json`; the JetBrains plugin's `~/.codeium/hooks.json`
 * and the three system files are deliberately not written by `init`, though all of
 * them are protected from tampering.
 */
export function windsurfHooksPath(scope: 'project' | 'user', cwd: string = process.cwd()): string {
  return scope === 'user'
    ? join(homedir(), '.codeium', 'windsurf', 'hooks.json')
    : join(cwd, '.windsurf', 'hooks.json');
}

export const readWindsurfHooks = (file: string): WindsurfHooksJson =>
  readJsonObject<WindsurfHooksJson>(file);

/**
 * The workspace file Devin Desktop, the renamed Windsurf, reads first. Its documentation
 * says `.windsurf/hooks.json` is used "only when `.devin/hooks.json` is absent or defines
 * no hooks", so a repository (or an agent) that puts hooks in this file switches off a
 * project install in the other one, which is the one `init` writes. The user file has no
 * such twin, and the levels are merged, so it cannot be replaced from the repository.
 */
export const devinHooksPath = (cwd: string = process.cwd()): string =>
  join(cwd, '.devin', 'hooks.json');

/**
 * Whether a hooks file defines at least one hook, which is what stops Devin Desktop from
 * falling back to `.windsurf/hooks.json`. An event with a non-empty list counts, whatever
 * is in it: the documentation does not say what a malformed entry does, and counting it
 * errs on the side of telling the user.
 */
export function definesWindsurfHooks(json: unknown): boolean {
  if (!isPlainObject(json)) return false;
  const hooks = json['hooks'];
  return (
    isPlainObject(hooks) &&
    Object.values(hooks).some((entries) => Array.isArray(entries) && entries.length > 0)
  );
}

/** What the project's `.devin/hooks.json` is, as far as Stroq's install is concerned. */
export type DevinWorkspaceHooks =
  | { readonly state: 'absent' }
  /** There, but it defines no hook: Devin Desktop still reads `.windsurf/hooks.json`. */
  | { readonly state: 'empty' }
  /** `text` and `json` are the file as read, for a caller that has to check what its entries run. */
  | {
      readonly state: 'defined';
      /** Entries that END like Stroq's: not who wrote them; see `carriesRecordedEntries`. */
      readonly carriesStroq: boolean;
      readonly text: string;
      readonly json: unknown;
    }
  /** Present but not readable as hooks; what Devin Desktop does with it is not documented. */
  | { readonly state: 'unreadable'; readonly message: string };

/**
 * What is wrong with the shape of a hooks file, or null. The documentation says what a file
 * with hooks and a file with none do, not what a file that is neither does, so a wrong shape
 * is not counted as an empty file: it is unknown. The reason names no key or value from the
 * file, which is a repository's.
 */
function malformedHooks(json: unknown): string | null {
  if (!isPlainObject(json)) return 'is not a JSON object';
  const hooks = json['hooks'];
  if (hooks === undefined || hooks === null) return null;
  if (!isPlainObject(hooks)) return 'has a "hooks" that is not an object';
  return Object.values(hooks).some((entries) => entries !== undefined && !Array.isArray(entries))
    ? 'has an event whose hooks are not a list'
    : null;
}

export function readDevinWorkspaceHooks(cwd: string = process.cwd()): DevinWorkspaceHooks {
  const file = devinHooksPath(cwd);
  try {
    const text = readConfigText(file, { strict: true });
    if (text === null) return { state: 'absent' };
    if (text.trim().length === 0) return { state: 'empty' };
    const json = parseConfigJson<unknown>(file, text);
    const malformed = malformedHooks(json);
    if (malformed !== null) return { state: 'unreadable', message: `${file} ${malformed}` };
    return definesWindsurfHooks(json)
      ? { state: 'defined', carriesStroq: isStroqWindsurfHooks(json), text, json }
      : { state: 'empty' };
  } catch (err) {
    return { state: 'unreadable', message: err instanceof Error ? err.message : String(err) };
  }
}

export function installWindsurfHooks(file: string, command: string): WindsurfHooksJson {
  const merged = mergeWindsurfHooks(readWindsurfHooks(file), command);
  writeJsonObject(file, merged);
  return merged;
}
