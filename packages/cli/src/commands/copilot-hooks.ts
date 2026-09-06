import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPlainObject, readJsonObject, writeJsonObject } from './config-file.js';

/**
 * Copilot loads EVERY `*.json` in its hooks directory independently, so Stroq owns
 * one file — `stroq.json` — outright and writes it whole. There is nothing to merge:
 * a user's own hooks live in a sibling file that this installer never opens, and an
 * older Stroq file is replaced rather than appended to, which is what makes
 * re-running `init` idempotent by construction.
 */

/** The two events Stroq installs on. Copilot spells its events camelCase. */
export const COPILOT_HOOK_EVENTS = ['preToolUse', 'postToolUse'] as const;

/**
 * Seconds, and deliberately NOT the `HOOK_TIMEOUT_SECONDS` the other three agents
 * get. On Copilot a hook that runs past its timeout is treated as an ALLOW and its
 * late deny is discarded (github/copilot-cli#2893), and hooks are dispatched
 * serially, so a shorter budget is strictly less safe here — it only makes the one
 * failure mode Stroq cannot answer from inside the hook more likely. 30 is Copilot's
 * own default; Stroq answers in well under a second either way, so the extra budget
 * costs nothing and buys the margin a cold Node start needs.
 */
export const COPILOT_HOOK_TIMEOUT_SECONDS = 30;

export interface CopilotHookEntry {
  readonly type: 'command';
  readonly bash: string;
  /** Written for Windows, untested there; Copilot picks the one for the host shell. */
  readonly powershell: string;
  /** Seconds; `COPILOT_HOOK_TIMEOUT_SECONDS`, which is not the other agents' value. */
  readonly timeoutSec: number;
  readonly comment: string;
}

export interface CopilotHooksFile {
  /** Required by Copilot; a file without it is dropped. */
  readonly version: 1;
  readonly hooks: {
    readonly preToolUse: readonly CopilotHookEntry[];
    readonly postToolUse: readonly CopilotHookEntry[];
  };
}

/** What might actually be on disk: any JSON object, including one Stroq did not write. */
export type CopilotHooksJson = Record<string, unknown>;

/** Stroq's own entries, identified by the command suffix `init` writes. */
const STROQ_COPILOT_COMMAND = / hook copilot (pre|post)$/;

const entry = (command: string): CopilotHookEntry => ({
  type: 'command',
  bash: command,
  // `&` is PowerShell's call operator: without it a quoted path is echoed, not run.
  powershell: `& ${command}`,
  timeoutSec: COPILOT_HOOK_TIMEOUT_SECONDS,
  comment: 'Stroq',
});

/**
 * The whole file, with no `matcher`. A matcher is a regex over the native `toolName`,
 * and Copilot's hooks never reveal an MCP server name — so any list Stroq could write
 * would be a list of the tools it already knows about, and the MCP call it has never
 * heard of would be the one that skipped the hook. Every tool goes through Stroq
 * instead; one it does not care about returns nothing in a few milliseconds.
 */
export function buildCopilotHooks(commandPre: string, commandPost: string): CopilotHooksFile {
  return {
    version: 1,
    hooks: { preToolUse: [entry(commandPre)], postToolUse: [entry(commandPost)] },
  };
}

const isStroqEntry = (value: unknown): boolean =>
  isPlainObject(value) &&
  typeof value['bash'] === 'string' &&
  STROQ_COPILOT_COMMAND.test(value['bash']);

const eventEntries = (json: unknown, event: string): readonly unknown[] => {
  if (!isPlainObject(json)) return [];
  const hooks = json['hooks'];
  if (!isPlainObject(hooks)) return [];
  const entries = hooks[event];
  return Array.isArray(entries) ? entries : [];
};

/**
 * True only when the file declares `version: 1` AND both events carry a Stroq
 * entry. Copilot drops a hooks file outright when `version` is missing or is
 * anything but `1`, so a file lacking it protects no one no matter how correct its
 * `hooks` block looks, and calling it installed would be reporting protection the
 * file cannot actually provide. `init` always writes both events, so a file with
 * only one of them is a half-install too — a `pre` without a `post` never taints,
 * a `post` without a `pre` never blocks — and reporting it as installed would leave
 * a user believing in protection they do not have.
 */
export const isStroqCopilotHooks = (json: unknown): boolean =>
  isPlainObject(json) &&
  json['version'] === 1 &&
  COPILOT_HOOK_EVENTS.every((event) => eventEntries(json, event).some(isStroqEntry));

/**
 * Repository hooks live in `.github/hooks/` — the only location the cloud coding
 * agent reads. The user copy is `$COPILOT_HOME/hooks/` when that variable is set to
 * a non-empty string — it is not checked for actually naming a directory, and
 * `writeJsonObject` creates the tree if it does not already exist — else
 * `~/.copilot/hooks/`.
 */
export function copilotHooksPath(
  scope: 'project' | 'user',
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (scope === 'project') return join(cwd, '.github', 'hooks', 'stroq.json');
  const home = env['COPILOT_HOME'];
  return join(
    home !== undefined && home !== '' ? home : join(homedir(), '.copilot'),
    'hooks',
    'stroq.json',
  );
}

export const readCopilotHooks = (file: string): CopilotHooksJson =>
  readJsonObject<CopilotHooksJson>(file);

/**
 * The one line `init` prints on STDERR when it is about to overwrite a `stroq.json`
 * that Stroq did not write — stderr so that `init --agent copilot --dry-run | jq`
 * still sees nothing but the file on stdout. The overwrite itself stays
 * unconditional — the NAME is Stroq's by
 * contract, and a user's own hooks belong in a sibling file, which is the whole
 * reason there is nothing to merge — but replacing a file whose contents nobody
 * recognises should never be silent. Empty for a file that is absent or is already a
 * Stroq install (the idempotent re-run, which is the common case). A file that
 * cannot be parsed counts as foreign: it is being replaced either way, and throwing
 * here would take down an install that is about to fix exactly that.
 */
export function copilotReplacementNotice(file: string, dryRun = false): string {
  if (!existsSync(file)) return '';
  let existing: unknown = null;
  try {
    existing = readCopilotHooks(file);
  } catch {
    // unparseable — foreign by the only definition that matters here
  }
  if (isStroqCopilotHooks(existing)) return '';
  return `${dryRun ? 'would replace' : 'replacing'} ${file}, which Stroq did not write\n`;
}

export function installCopilotHooks(
  file: string,
  commandPre: string,
  commandPost: string,
): CopilotHooksFile {
  const built = buildCopilotHooks(commandPre, commandPost);
  writeJsonObject(file, built);
  return built;
}
