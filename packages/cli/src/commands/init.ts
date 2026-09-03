import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const PRE_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|WebFetch|mcp__.*';
export const POST_MATCHER = 'Read|WebFetch|WebSearch|Bash|Grep|mcp__.*';
const HOOK_TIMEOUT_SECONDS = 15;

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

export function hookCommand(node: string, entry: string): string {
  const loader = entry.endsWith('.ts') ? ' --import tsx' : '';
  return `"${node}"${loader} "${entry}" hook claude-code`;
}

export const stroqHandler = (command: string): HookHandler => ({
  type: 'command',
  command,
  timeout: HOOK_TIMEOUT_SECONDS,
});
export const isStroqHandler = (handler: HookHandler): boolean =>
  / hook claude-code$/.test(handler.command);

function withoutStroq(groups: readonly HookGroup[]): HookGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isStroqHandler(h)) }))
    .filter((g) => g.hooks.length > 0);
}

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

export function readSettings(file: string): SettingsJson {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  return text.trim().length === 0 ? {} : (JSON.parse(text) as SettingsJson);
}

export function installHooks(file: string, command: string): SettingsJson {
  const merged = mergeHooks(readSettings(file), command);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

export async function runInit(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      user: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const file = settingsPath(values.user ? 'user' : 'project');
  const command = hookCommand(process.execPath, resolve(process.argv[1] ?? ''));
  if (values['dry-run']) {
    process.stdout.write(`${JSON.stringify(mergeHooks(readSettings(file), command), null, 2)}\n`);
    return 0;
  }
  installHooks(file, command);
  process.stdout.write(
    `Stroq hooks installed in ${file}\n  PreToolUse  → ${PRE_MATCHER}\n  PostToolUse → ${POST_MATCHER}\nRun "stroq doctor" to verify.\n`,
  );
  return 0;
}
