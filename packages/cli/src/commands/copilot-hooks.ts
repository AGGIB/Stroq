import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_TIMEOUT_SECONDS,
  isPlainObject,
  readJsonObject,
  writeJsonObject,
} from './config-file.js';

/**
 * Copilot loads EVERY `*.json` in its hooks directory independently, so Stroq owns
 * one file — `stroq.json` — outright and writes it whole. There is nothing to merge:
 * a user's own hooks live in a sibling file that this installer never opens, and an
 * older Stroq file is replaced rather than appended to, which is what makes
 * re-running `init` idempotent by construction.
 */

/** The two events Stroq installs on. Copilot spells its events camelCase. */
export const COPILOT_HOOK_EVENTS = ['preToolUse', 'postToolUse'] as const;

export interface CopilotHookEntry {
  readonly type: 'command';
  readonly bash: string;
  /** Written for Windows, untested there; Copilot picks the one for the host shell. */
  readonly powershell: string;
  /**
   * Seconds. Copilot's default is 30, and a hook that runs past its timeout is
   * treated as an ALLOW whose late deny is discarded (github/copilot-cli#2893), so a
   * shorter budget does not make Stroq safer — it is kept at the 15 s the other three
   * agents get purely so one number describes every install.
   */
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
  timeoutSec: HOOK_TIMEOUT_SECONDS,
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

export function installCopilotHooks(
  file: string,
  commandPre: string,
  commandPost: string,
): CopilotHooksFile {
  const built = buildCopilotHooks(commandPre, commandPost);
  writeJsonObject(file, built);
  return built;
}
