// `stroq uninstall` — `stroq init` in reverse.
//
// Only Stroq's own entries are taken out; every other hook, event and key of the file
// stays as it was, the same promise `init` makes when it merges in. An agent cannot
// run this (it is `config.self`, see `changesStroqState` in core): taking the hooks
// out is the user's call, made outside the agent.
import { existsSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ANTIGRAVITY_HOOK_NAME, antigravityHooksPath } from './antigravity-hooks.js';
import { codexHooksPath } from './codex-hooks.js';
import { isPlainObject, readJsonObject, writeJsonObject } from './config-file.js';
import { copilotHooksPath } from './copilot-hooks.js';
import { cursorHooksPath } from './cursor-hooks.js';
import { type HookAgent, isInitAgent, runInit, settingsPath } from './init.js';
import { windsurfHooksPath } from './windsurf-hooks.js';

type Scope = 'project' | 'user';
type Json = Record<string, unknown>;

export interface UninstallResult {
  /** Whether Stroq's entries were found (and, outside `--dry-run`, removed). */
  readonly removed: boolean;
  readonly message: string;
}

/** A handler whose command is Stroq's hook for `agent`, as each installer writes it. */
const ownedBy =
  (agent: HookAgent) =>
  (handler: unknown): boolean =>
    isPlainObject(handler) &&
    typeof handler['command'] === 'string' &&
    new RegExp(` hook ${agent}(?: \\S+)?$`).test(handler['command']);

/**
 * One event's array without Stroq's handlers, in either shape the agents use: flat
 * handlers (Cursor, Windsurf) or matcher groups holding a `hooks` array (Claude
 * Code, Codex). A group Stroq emptied goes with it; anything else is kept as it was.
 */
function stripEvent(entries: readonly unknown[], ours: (h: unknown) => boolean): unknown[] {
  return entries.flatMap((entry) => {
    if (ours(entry)) return [];
    if (!isPlainObject(entry) || !Array.isArray(entry['hooks'])) return [entry];
    const hooks = entry['hooks'] as unknown[];
    const kept = hooks.filter((handler) => !ours(handler));
    if (kept.length === hooks.length) return [entry];
    return kept.length > 0 ? [{ ...entry, hooks: kept }] : [];
  });
}

/** A single matcher group written in place of an event's array, as Codex allows. */
const isGroup = (value: unknown): value is Json =>
  isPlainObject(value) && Array.isArray(value['hooks']);

/**
 * Every event of `events` stripped; a key Stroq emptied is dropped. An event written
 * as one group object rather than an array — Codex reads that shape at the file's
 * root, and `init` lifts it — is stripped as a one-group array and written back as
 * the object it was.
 */
function stripEvents(events: Json, ours: (h: unknown) => boolean): Json {
  const out: Json = {};
  for (const [event, value] of Object.entries(events)) {
    if (isGroup(value)) {
      const [kept] = stripEvent([value], ours);
      if (kept !== undefined) out[event] = kept;
      continue;
    }
    if (!Array.isArray(value)) {
      out[event] = value;
      continue;
    }
    const kept = stripEvent(value, ours);
    if (kept.length > 0 || value.length === 0) out[event] = kept;
  }
  return out;
}

/** The `hooks` object stripped, and dropped when Stroq was all it held. */
function stripHooksKey(settings: Json, ours: (h: unknown) => boolean): Json {
  const { hooks, ...rest } = settings;
  // An empty `hooks` is the user's, not something Stroq emptied: it stays.
  if (!isPlainObject(hooks) || Object.keys(hooks).length === 0) return settings;
  const kept = stripEvents(hooks, ours);
  return Object.keys(kept).length > 0 ? { ...rest, hooks: kept } : rest;
}

interface JsonTarget {
  readonly path: (scope: Scope, cwd: string) => string;
  readonly strip: (settings: Json) => Json;
}

const JSON_TARGETS: Readonly<
  Record<'claude-code' | 'cursor' | 'codex' | 'windsurf' | 'antigravity', JsonTarget>
> = {
  'claude-code': {
    path: settingsPath,
    strip: (s) => stripHooksKey(s, ownedBy('claude-code')),
  },
  cursor: { path: cursorHooksPath, strip: (s) => stripHooksKey(s, ownedBy('cursor')) },
  windsurf: { path: windsurfHooksPath, strip: (s) => stripHooksKey(s, ownedBy('windsurf')) },
  // Codex also reads events kept at the file's root, so both levels are stripped.
  codex: {
    path: codexHooksPath,
    strip: (s) => stripEvents(stripHooksKey(s, ownedBy('codex')), ownedBy('codex')),
  },
  antigravity: {
    path: antigravityHooksPath,
    strip: ({ [ANTIGRAVITY_HOOK_NAME]: _ours, ...rest }) => rest,
  },
};

const nothing = (file: string): UninstallResult => ({
  removed: false,
  message: `No Stroq hooks in ${file}; nothing to remove.\n`,
});

function uninstallJson(target: JsonTarget, file: string, dryRun: boolean): UninstallResult {
  if (!existsSync(file)) return nothing(file);
  const before = readJsonObject<Json>(file);
  const after = target.strip(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return nothing(file);
  if (dryRun) return { removed: true, message: `${JSON.stringify(after, null, 2)}\n` };
  writeJsonObject(file, after);
  return {
    removed: true,
    message: `Removed Stroq's hooks from ${file}. Anything else in it is unchanged.\nRun "stroq doctor" to check.\n`,
  };
}

/** Copilot's `stroq.json` is a file Stroq writes whole: it goes, if Stroq wrote it. */
function uninstallCopilot(file: string, dryRun: boolean): UninstallResult {
  if (!existsSync(file)) return nothing(file);
  const text = JSON.stringify(readJsonObject<Json>(file));
  if (!/ hook copilot (?:pre|post)\b/.test(text)) return nothing(file);
  if (dryRun) return { removed: true, message: `would delete ${file}\n` };
  rmSync(file);
  return {
    removed: true,
    message: `Deleted ${file}, which held only Stroq's hooks.\nRun "stroq doctor" to check.\n`,
  };
}

export function uninstallAgent(
  agent: HookAgent,
  scope: Scope,
  cwd: string,
  dryRun: boolean,
): UninstallResult {
  if (agent === 'openclaw')
    // Registered with the Gateway through OpenClaw's own CLI, which `init` runs and
    // this does not: switching a Gateway plugin off is a command to run knowingly.
    return {
      removed: false,
      message:
        'The OpenClaw plugin is registered with your Gateway. Switch it off with:\n  openclaw plugins disable stroq\n',
    };
  if (agent === 'copilot') return uninstallCopilot(copilotHooksPath(scope, cwd), dryRun);
  const target = JSON_TARGETS[agent];
  return uninstallJson(target, target.path(scope, cwd), dryRun);
}

export async function runUninstall(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      agent: { type: 'string' },
      user: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      client: { type: 'string' },
      config: { type: 'string' },
    },
  });
  const agent = values.agent ?? 'claude-code';
  if (!isInitAgent(agent)) {
    process.stderr.write(`stroq uninstall: unknown agent "${agent}"\n`);
    return 2;
  }
  // The MCP proxy is taken out the way it is put in: `init --agent mcp --unwrap`
  // restores each wrapped server entry.
  if (agent === 'mcp')
    return runInit([
      '--agent',
      'mcp',
      '--unwrap',
      ...(values.user === true ? ['--user'] : []),
      ...(values['dry-run'] === true ? ['--dry-run'] : []),
      ...(values.client === undefined ? [] : ['--client', values.client]),
      ...(values.config === undefined ? [] : ['--config', values.config]),
    ]);
  const result = uninstallAgent(
    agent,
    values.user === true ? 'user' : 'project',
    process.cwd(),
    values['dry-run'] === true,
  );
  process.stdout.write(result.message);
  return 0;
}
