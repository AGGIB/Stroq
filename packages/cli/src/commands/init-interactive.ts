// The wiring of the first-run screen: what is on this machine, what the plain installer is told, and
// what is checked afterwards. Loaded only when a person is looking (see `init-agent.ts`): the hook
// process, which starts for every tool call an agent makes, never reads any of this.
import { FileSecretIndex } from '@stroq/core';
import { secretsFile, stroqHome } from '../paths.js';
import { stroqVersion } from '../version.js';
import type { Timers } from '../ui/spinner.js';
import type { Terminal } from '../ui/terminal.js';
import { antigravityHooksPath } from './antigravity-hooks.js';
import { codexHooksPath } from './codex-hooks.js';
import { copilotHooksPath } from './copilot-hooks.js';
import { cursorHooksPath } from './cursor-hooks.js';
import { detectedAgents } from './doctor.js';
import { explicitAgent, installerArgs } from './init-args.js';
import { installKey, readInstallRecord } from './install-record.js';
import { HOOK_AGENTS, runInit, runsFromNpxCache, settingsPath, type HookAgent } from './init.js';
import { runInitFlow, type FlowAgent, type FlowDeps } from './init-flow.js';
import { selfCheck } from './init-selfcheck.js';
import { openclawOnPath, openclawPluginDir } from './openclaw-plugin.js';
import { windsurfHooksPath } from './windsurf-hooks.js';

const LABELS: Readonly<Record<HookAgent, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex CLI',
  copilot: 'Copilot CLI',
  openclaw: 'OpenClaw',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
};

/** `~/…` for a path inside the home directory, so that the screen shows what the docs show. */
export function tilde(path: string, home: string): string {
  // A home that is not set (`HOME=` is an empty string to `os.homedir()`) holds nothing.
  if (home === '') return path;
  const rel = path.startsWith(home) ? path.slice(home.length) : null;
  return rel !== null && (rel === '' || rel.startsWith('/') || rel.startsWith('\\'))
    ? `~${rel.replace(/\\/g, '/')}`
    : path;
}

/** The part of `path` below `dir`, or null where it is not below it. Either separator, as on Windows. */
function below(path: string, dir: string): string | null {
  const root = dir.replace(/[\\/]+$/, '');
  if (root === '') return null;
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
    ? path.slice(root.length + 1).replace(/\\/g, '/')
    : null;
}

/** A path as the screen shows it: from the project where it is in it, from `~` where it is in the home. */
export function display(path: string, cwd: string, home: string): string {
  return below(path, cwd) ?? tilde(path, home);
}

/** The file or folder an agent's hooks are written to, as the installer prints it. */
function configFile(id: HookAgent, scope: 'project' | 'user', cwd: string): string {
  const full: Readonly<Record<HookAgent, () => string>> = {
    'claude-code': () => settingsPath(scope, cwd),
    cursor: () => cursorHooksPath(scope),
    codex: () => codexHooksPath(scope),
    copilot: () => copilotHooksPath(scope),
    openclaw: () => openclawPluginDir(),
    windsurf: () => windsurfHooksPath(scope),
    antigravity: () => antigravityHooksPath(scope),
  };
  return full[id]();
}

/** Where an agent's hooks go, as a path a person can read. */
const configOf = (id: HookAgent, scope: 'project' | 'user', cwd: string, home: string): string =>
  // Inside the project, the path from the project: `.claude/settings.json`.
  display(configFile(id, scope, cwd), cwd, home);

/**
 * What installing for an agent does that is not a file in the project, and is not what "in this project"
 * says: OpenClaw's plugin is for the whole user, and it is registered with the Gateway by two commands
 * that `init` runs where it can, and prints where `openclaw` is not on `PATH` (and on Windows).
 */
function extraFor(id: HookAgent): string | undefined {
  if (id !== 'openclaw') return undefined;
  const commands = '`openclaw plugins install --link` and `openclaw plugins enable stroq`';
  return process.platform !== 'win32' && openclawOnPath() !== null
    ? `runs ${commands}, which are for the whole user whatever the scope`
    : `prints ${commands} for you to run where \`openclaw\` is (it is not on PATH here), which are for the whole user whatever the scope`;
}

/** The agents whose install is the plugin of a Gateway: for the whole user, and taken out by the Gateway's own command. */
const PLUGINS: Readonly<Partial<Record<HookAgent, { userWide: true; undo: string }>>> = {
  openclaw: { userWide: true, undo: 'openclaw plugins disable stroq' },
};

/**
 * The installer's output with the paths it printed made safe: a path with a line break in it (a folder
 * named so, in a repository that was cloned) would be two lines of output, and the second a note. The
 * longest are made safe first, so that a path that holds another is not cut by it.
 */
/** What ends a line in a terminal or a text: a line break, a carriage return, a tab, and the two Unicode separators. */
const LINE_BREAKS = /[\n\r\t\u2028\u2029]/;
const BREAK_NAMES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};
const escapedBreaks = (path: string): string =>
  path.replace(/[\n\r\t\u2028\u2029]/g, (ch) => BREAK_NAMES[ch] ?? ch);

export const withSafePaths = (out: string, paths: readonly string[]): string =>
  [...paths]
    .filter((path) => LINE_BREAKS.test(path))
    .sort((a, b) => b.length - a.length)
    .reduce((text, path) => text.split(path).join(escapedBreaks(path)), out);

/** Runs `fn` with what it prints kept, and returns it with the exit code. */
async function captured(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const kept: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const keep = ((chunk: unknown): boolean => {
    kept.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = keep;
  process.stderr.write = keep;
  try {
    const code = await fn();
    return { code, out: kept.join('') };
  } catch (err) {
    return { code: 1, out: `${(err as Error).message}\n` };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** What a test replaces: the part that starts a process, and the clock of the spinner. */
export interface InteractiveOverrides {
  readonly check?: FlowDeps['check'];
  readonly timers?: Timers;
}

export async function runInteractiveInit(
  args: readonly string[],
  term: Terminal,
  where: { readonly cwd: string; readonly home: string },
  overrides: InteractiveOverrides = {},
): Promise<number> {
  const { cwd, home } = where;
  const scope = args.includes('--user') ? 'user' : 'project';
  const yes = args.includes('--yes');
  // A home that is not set is an empty string, and a path joined to it is the project's own.
  const found = new Set(home === '' ? [] : detectedAgents(cwd, home, 'user'));
  const agents: FlowAgent[] = HOOK_AGENTS.map((id) => ({
    id,
    label: LABELS[id],
    found: found.has(id),
    where: found.has(id) ? configOf(id, scope, cwd, home) : '',
    ...(extraFor(id) === undefined ? {} : { extra: extraFor(id) as string }),
    ...(PLUGINS[id] ?? {}),
  }));
  const named = explicitAgent(args);
  // An agent that was named is the one. Otherwise: the agents found here, or Claude Code when none is.
  const chosen =
    named !== null
      ? [named]
      : agents.some((a) => a.found)
        ? agents.filter((a) => a.found).map((a) => a.id)
        : ['claude-code'];
  // An agent that is guarded without having been found shows where its hooks will go.
  const shown = agents.map((a) =>
    chosen.includes(a.id) && !a.found
      ? { ...a, where: configOf(a.id as HookAgent, scope, cwd, home) }
      : a,
  );
  const base = installerArgs(args);
  const reads = new FileSecretIndex(secretsFile(), home)
    .sourcePaths(cwd)
    .map((file) => display(file, cwd, home));
  return runInitFlow({
    term,
    stroq: stroqVersion(),
    scope,
    yes,
    agents: shown,
    chosen,
    reads,
    home: tilde(stroqHome(), home),
    show: (file) => display(file, cwd, home),
    copiesCli: runsFromNpxCache(process.argv[1] ?? ''),
    install: async (id) => {
      const found = await captured(() => runInit([...base, '--agent', id]));
      return {
        ...found,
        out: withSafePaths(found.out, [
          configFile(id as HookAgent, scope, cwd),
          cwd,
          home,
          stroqHome(),
        ]),
      };
    },
    command: (id) => readInstallRecord().entries[installKey(id, scope)]?.command ?? null,
    check: overrides.check ?? ((id, command) => selfCheck(id, command)),
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
  });
}
