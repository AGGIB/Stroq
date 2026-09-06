import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CURSOR_EVENTS } from '../adapters/cursor.js';
import {
  HOOK_TIMEOUT_SECONDS,
  readJsonObject,
  withoutStroqGroups,
  writeJsonObject,
} from './config-file.js';
import {
  cursorHooksPath,
  installCursorHooks,
  mergeCursorHooks,
  readCursorHooks,
} from './cursor-hooks.js';
import {
  CODEX_POST_MATCHER,
  CODEX_PRE_MATCHER,
  codexHooksPath,
  installCodexHooks,
  mergeCodexHooks,
  readCodexHooks,
} from './codex-hooks.js';
import {
  buildCopilotHooks,
  copilotHooksPath,
  copilotReplacementNotice,
  installCopilotHooks,
} from './copilot-hooks.js';

export const PRE_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|mcp__.*';
export const POST_MATCHER = 'Read|WebFetch|WebSearch|Bash|Grep|mcp__.*';

/** Agents `stroq init --agent <name>` can install hooks for. */
export type HookAgent = 'claude-code' | 'cursor' | 'codex' | 'copilot';
export const HOOK_AGENTS: readonly HookAgent[] = ['claude-code', 'cursor', 'codex', 'copilot'];

export interface HookHandler {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
}
export interface HookGroup {
  readonly matcher: string;
  readonly hooks: readonly HookHandler[];
}
export type SettingsJson = {
  readonly hooks?: Readonly<Record<string, readonly HookGroup[]>>;
} & Record<string, unknown>;

/**
 * The command an agent runs for every hook event. The trailing agent name is
 * also how `init` recognises its own entries when re-installing, so it must stay
 * at the end of the string (see `isStroqHandler` / `isStroqCursorHook`).
 */
export function hookCommand(node: string, entry: string, agent: HookAgent = 'claude-code'): string {
  const loader = entry.endsWith('.ts') ? ' --import tsx' : '';
  return `"${node}"${loader} "${entry}" hook ${agent}`;
}

export const stroqHandler = (command: string): HookHandler => ({
  type: 'command',
  command,
  timeout: HOOK_TIMEOUT_SECONDS,
});
export const isStroqHandler = (handler: HookHandler): boolean =>
  / hook claude-code$/.test(handler.command);

const withoutStroq = (groups: readonly HookGroup[]): HookGroup[] =>
  withoutStroqGroups<HookGroup>(groups, (handler) => isStroqHandler(handler as HookHandler));

export function mergeHooks(settings: SettingsJson, command: string): SettingsJson {
  const hooks = settings.hooks ?? {};
  return {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: [
        ...withoutStroq(hooks['PreToolUse'] ?? []),
        { matcher: PRE_MATCHER, hooks: [stroqHandler(command)] },
      ],
      PostToolUse: [
        ...withoutStroq(hooks['PostToolUse'] ?? []),
        { matcher: POST_MATCHER, hooks: [stroqHandler(command)] },
      ],
    },
  };
}

export function settingsPath(scope: 'project' | 'user', cwd: string = process.cwd()): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');
}

export const readSettings = (file: string): SettingsJson => readJsonObject<SettingsJson>(file);

export function installHooks(file: string, command: string): SettingsJson {
  const merged = mergeHooks(readSettings(file), command);
  writeJsonObject(file, merged);
  return merged;
}

function initClaudeCode(scope: 'project' | 'user', command: string, dryRun: boolean): number {
  const file = settingsPath(scope);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(mergeHooks(readSettings(file), command), null, 2)}\n`);
    return 0;
  }
  installHooks(file, command);
  process.stdout.write(
    `Stroq hooks installed in ${file}\n  PreToolUse  → ${PRE_MATCHER}\n  PostToolUse → ${POST_MATCHER}\nRun "stroq doctor" to verify.\n`,
  );
  return 0;
}

function initCursor(scope: 'project' | 'user', command: string, dryRun: boolean): number {
  const file = cursorHooksPath(scope);
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(mergeCursorHooks(readCursorHooks(file), command), null, 2)}\n`,
    );
    return 0;
  }
  installCursorHooks(file, command);
  process.stdout.write(
    `Stroq hooks installed in ${file}\n  ${CURSOR_EVENTS.join('\n  ')}\nRestart Cursor, then run "stroq doctor" to verify.\n`,
  );
  return 0;
}

/**
 * Three things a Codex user has to know that no other agent needs: on older releases
 * hooks are opt-in behind a feature flag, a project-local `.codex/` layer only loads
 * once it is trusted — so an install that looks perfect can still be inert — and an
 * existing file that kept its events at the root has just been restructured, which
 * is a change to their file and so has to be said out loud.
 */
const CODEX_NOTE =
  'On older Codex releases hooks are opt-in: set [features] hooks = true in ~/.codex/config.toml.\n' +
  "Project hooks load only once you trust this project's .codex/ layer (Codex asks the first time);\n" +
  '"stroq init --agent codex --user" writes ~/.codex/hooks.json instead and skips that prompt.\n' +
  'Events an existing file kept at its root are migrated under the official "hooks" wrapper; nothing is dropped.\n';

function initCodex(scope: 'project' | 'user', command: string, dryRun: boolean): number {
  const file = codexHooksPath(scope);
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(mergeCodexHooks(readCodexHooks(file), command), null, 2)}\n`,
    );
    return 0;
  }
  installCodexHooks(file, command);
  process.stdout.write(
    `Stroq hooks installed in ${file}\n  PreToolUse  → ${CODEX_PRE_MATCHER}\n  PostToolUse → ${CODEX_POST_MATCHER}\n${CODEX_NOTE}Run "stroq doctor" to verify.\n`,
  );
  return 0;
}

/**
 * Three things a Copilot user has to know that no other agent needs: hooks are read
 * once when the CLI starts, so an install into a running session does nothing; Stroq
 * owns this one file and rewrites it whole, so a hook of your own belongs in a
 * sibling file; and `.github/hooks/` is the only location the cloud coding agent
 * reads, where the command can only run if Node and @stroq/cli exist in its sandbox.
 */
const COPILOT_NOTE =
  'Copilot reads its hooks when the CLI starts: restart "copilot" before this takes effect.\n' +
  'Stroq owns this file and rewrites it whole; put hooks of your own in another *.json in the same directory.\n' +
  '"stroq init --agent copilot --user" writes $COPILOT_HOME/hooks/stroq.json (or ~/.copilot/hooks/stroq.json) instead.\n' +
  'The cloud coding agent reads only .github/hooks/, and can run this hook only where Node and @stroq/cli are installed.\n';

function initCopilot(scope: 'project' | 'user', command: string, dryRun: boolean): number {
  const file = copilotHooksPath(scope);
  const [pre, post] = [`${command} pre`, `${command} post`];
  // On stderr, and before the file (or the preview), so it is the first thing read
  // without putting anything but JSON on stdout: `init --dry-run | jq` still works.
  // The overwrite is by contract, but it is never silent. Empty for the common
  // cases — a fresh install and an idempotent re-run.
  const notice = copilotReplacementNotice(file, dryRun);
  if (notice) process.stderr.write(notice);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(buildCopilotHooks(pre, post), null, 2)}\n`);
    return 0;
  }
  installCopilotHooks(file, pre, post);
  process.stdout.write(
    `Stroq hooks installed in ${file}\n  preToolUse  -> every tool\n  postToolUse -> every tool\n${COPILOT_NOTE}Run "stroq doctor" to verify.\n`,
  );
  return 0;
}

export async function runInit(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      user: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      agent: { type: 'string', default: 'claude-code' },
    },
  });
  const agent = values.agent ?? 'claude-code';
  if (!HOOK_AGENTS.includes(agent as HookAgent)) {
    process.stdout.write(`unknown agent "${agent}" (supported: ${HOOK_AGENTS.join(', ')})\n`);
    return 1;
  }
  const scope = values.user ? 'user' : 'project';
  const dryRun = values['dry-run'] === true;
  const command = hookCommand(process.execPath, resolve(process.argv[1] ?? ''), agent as HookAgent);
  const install: Readonly<Record<HookAgent, (s: typeof scope, c: string, d: boolean) => number>> = {
    'claude-code': initClaudeCode,
    cursor: initCursor,
    codex: initCodex,
    copilot: initCopilot,
  };
  return install[agent as HookAgent](scope, command, dryRun);
}
