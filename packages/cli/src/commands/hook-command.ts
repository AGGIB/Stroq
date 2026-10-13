import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The line an agent runs for every hook event, and how it is spelled where a host cannot take the usual one.
 *
 * Everywhere but Windows the line is `"<node>" "<entry>" hook <agent>`: a shell reads the quotes and the paths
 * may hold blanks. On Windows a host can hand that line to `cmd.exe` through a library that escapes each quote
 * with a backslash (`\"`), which `cmd.exe` does not understand: the first word of the line becomes
 * `\"C:\Program Files\nodejs\node.exe\"`, the line does not start, and Antigravity (which was reported doing
 * exactly that, as `'\"C:\Program Files\nodejs\node.exe\"' is not recognized as an internal or external
 * command`) refuses every tool call until the hook is taken out. So for the hosts that run a line that way
 * (Antigravity, seen; Cursor and Codex, not seen) the line has no quote in it: the paths are written bare, with
 * their 8.3 names where they hold a blank (`C:\PROGRA~1\nodejs\node.exe`), and `init` runs the line the way the
 * host does before it leaves it in a config.
 *
 * The program is always a path. A bare `node` would be looked up by `cmd.exe` in the current directory before
 * the search path, and the current directory of a hook is the project's, which a cloned repository can fill
 * with a `node.cmd` of its own; it would also depend on a search path that the agent's host may not have.
 */

/** The tsx loader is needed only for a TypeScript entry, i.e. in development and tests. */
export const needsTsxLoader = (entry: string): boolean => entry.endsWith('.ts');

/**
 * The command an agent runs for every hook event. The trailing agent name is
 * also how `init` recognises its own entries when re-installing, so it must stay
 * at the end of the string (see `isStroqHandler` / `isStroqCursorHook`).
 */
export function hookCommand(node: string, entry: string, agent: string = 'claude-code'): string {
  const loader = needsTsxLoader(entry) ? ' --import tsx' : '';
  return `"${node}"${loader} "${entry}" hook ${agent}`;
}

/**
 * The agents whose single command line is handed to `cmd.exe` on Windows, or to a shell nobody has looked at
 * there. Antigravity does it with every quote escaped (seen); Cursor and Codex have not been run on Windows
 * and are given the line that survives that too. Claude Code runs its hooks through Git Bash, which reads the
 * quoted line, and Copilot and Windsurf have a `powershell` entry of their own; none of the three is changed.
 */
export const CMD_AGENTS: ReadonlySet<string> = new Set(['antigravity', 'cursor', 'codex']);

/**
 * The agents for which a line that could not be shown to start is not written at all, and what is said instead:
 * Antigravity blocks every tool call while its hook cannot start, so the agent could no longer be told how to
 * repair it. The words are plain lines that end in a full stop, each its own paragraph, so that the first-run
 * screen shows the first as the reason and does not take a line of them for a command to copy.
 */
const REFUSED: Readonly<Record<string, { readonly summary: string; readonly fix: string }>> = {
  antigravity: {
    summary:
      'No hook was written for Antigravity: it hands the hook line to cmd.exe with every quote escaped, so a line with a quote in it cannot start, and it then blocks every tool call until the hook is taken out.',
    fix: [
      'To get a line without a quote, install Node.js and Stroq where no folder of the path has a blank ("dir /x" shows the short names Windows has for them). For Stroq: npm config set prefix C:\\npm, add C:\\npm to PATH, npm install -g @stroq/cli, then run "stroq init --agent antigravity" again.',
      'If Antigravity already refuses every tool call because of an earlier install, take the hook out from a terminal outside it: "stroq uninstall --agent antigravity" for this project, "stroq uninstall --agent antigravity --user" for the user config.',
    ].join('\n'),
  },
};

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * What a path may be made of to stand in a command line without quotes, for `cmd.exe`, PowerShell and a POSIX
 * shell alike: letters and digits of any alphabet, and `_ . : \ / ~ + @ -`. Not a blank, a quote, `&|<>()^%!$`
 * or `,;=`, which `cmd.exe` and the shells read as more than a name.
 */
const BARE = /^[\p{L}\p{N}_.:\\/~+@-]+$/u;
export const isBare = (path: string): boolean => BARE.test(path);

/** What `init` asks the machine for to spell a path without a blank. A test says what it answers. */
export interface WindowsTools {
  /** The 8.3 name of a path that exists, or null where there is none. */
  readonly shortPath: (path: string) => string | null;
  /** Whether two paths are one file. */
  readonly sameFile: (a: string, b: string) => boolean;
}

const canonical = (path: string): string => realpathSync.native(path).toLowerCase();

/**
 * What a path may be made of to be asked about: letters and digits of any alphabet, blanks, and `_ . : \ / ( ) ~ + @ ' -`.
 * Not a quote, which would end the string the name is read from, nor `% ^ & | < > ! , ; =` and the like, which `cmd.exe`
 * expands or reads as more than a name. A path with one of them is not asked about, and has no short name here.
 */
const QUERYABLE = /^[\p{L}\p{N} _.:\\/()~+@'-]+$/u;

/**
 * Where `cmd.exe` is. The program is started from there and named without a path, so that the folder searched first
 * is the system's, and not the project's, in which a cloned repository could put a `cmd.exe` of its own.
 */
const systemDirectory = (): string => join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');

/** The 8.3 name `cmd.exe` gives a path (`%~s`), or null where it gives none or cannot be asked. */
function shortPathOf(path: string): string | null {
  if (!QUERYABLE.test(path)) return null;
  const asked = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
    cwd: systemDirectory(),
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    windowsHide: true,
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (asked.error !== undefined || asked.status !== 0) return null;
  const line = asked.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  return line === '' ? null : line;
}

export const windowsTools = (): WindowsTools => ({
  shortPath: shortPathOf,
  sameFile: (a, b) => {
    try {
      return canonical(a) === canonical(b);
    } catch {
      return false;
    }
  },
});

/** A spelling of the path that needs no quote, or null where it has none: itself, or its 8.3 name when that is the same file. */
function bareForm(path: string, tools: WindowsTools): string | null {
  if (isBare(path)) return path;
  const short = tools.shortPath(path);
  return short !== null && isBare(short) && tools.sameFile(short, path) ? short : null;
}

const spelled = (path: string, slash: '\\' | '/'): string =>
  slash === '/' ? path.replace(/\\/g, '/') : path.replace(/\//g, '\\');

/**
 * The lines to try for `agent` on Windows, best first, the quoted line last:
 *
 * - the paths bare, with the backslashes `cmd.exe` is written in for Antigravity (the one host seen to run the
 *   line there), and with forward slashes, which a POSIX shell and PowerShell read too, for the two that have not
 *   been seen (and the other way round, in case `cmd.exe` is the one that cannot read them);
 * - the line every other platform gets.
 *
 * Without a spelling of the node and of the entry that needs no quote there is only the last.
 */
export function windowsHookCommands(
  node: string,
  entry: string,
  agent: string,
  tools: WindowsTools = windowsTools(),
): string[] {
  const loader = needsTsxLoader(entry) ? ' --import tsx' : '';
  const quoted = hookCommand(node, entry, agent);
  const bareEntry = bareForm(entry, tools);
  const bareNode = bareForm(node, tools);
  if (bareEntry === null || bareNode === null) return [quoted];
  const slashes: readonly ('\\' | '/')[] = agent === 'antigravity' ? ['\\', '/'] : ['/', '\\'];
  const lines = slashes.map(
    (slash) => `${spelled(bareNode, slash)}${loader} ${spelled(bareEntry, slash)} hook ${agent}`,
  );
  return [...new Set([...lines, quoted])];
}

/** The paths of the line that Windows has no spelling of without a blank or another character a bare word cannot hold. */
export function unspelledPaths(
  node: string,
  entry: string,
  tools: WindowsTools = windowsTools(),
): string[] {
  return [node, entry].filter((path) => bareForm(path, tools) === null);
}

/** What starting a line came to: whether it answered, and what was wrong when it did not. */
export interface Started {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ChosenCommand {
  /** The line to write. */
  readonly command: string;
  /** Said beside the install when the line could not be shown to start. */
  readonly warning: string | null;
  /** Set when nothing is to be written: why, and what to do. */
  readonly refused: string | null;
}

export interface ChooseOptions {
  readonly platform?: NodeJS.Platform;
  readonly tools?: WindowsTools;
  readonly dryRun?: boolean;
  /** Runs a line the way the host does, with a harmless event and a hostile one. */
  readonly probe: (command: string) => Promise<Started>;
}

/**
 * The line to write for `agent`. Anywhere but Windows, and for an agent whose host reads the quoted line, that
 * is the quoted line, untouched. On Windows, for the others, it is the first line of `windowsHookCommands` that
 * a probe shows to start the way the host starts it. A dry run takes the first without asking.
 *
 * When none starts, Antigravity is refused (a broken hook there blocks every tool, and the agent could not be
 * told how to repair it), and the other two keep the quoted line with a warning: they have not been run on
 * Windows, and the probe may be asking more of them than they do.
 */
export async function chooseHookCommand(
  node: string,
  entry: string,
  agent: string,
  options: ChooseOptions,
): Promise<ChosenCommand> {
  const platform = options.platform ?? process.platform;
  const quoted = hookCommand(node, entry, agent);
  if (platform !== 'win32' || !CMD_AGENTS.has(agent))
    return { command: quoted, warning: null, refused: null };
  const lines = windowsHookCommands(node, entry, agent, options.tools);
  const first = lines[0] ?? quoted;
  if (options.dryRun === true) return { command: first, warning: null, refused: null };
  const failed: string[] = [];
  for (const line of lines) {
    const started = await options.probe(line);
    if (started.ok) return { command: line, warning: null, refused: null };
    failed.push(
      sentence(`Tried ${line}: ${started.detail === '' ? 'it did not answer' : started.detail}`),
    );
  }
  const unspelled = unspelledPaths(node, entry, options.tools);
  const noSpelling =
    unspelled.length === 0
      ? ''
      : `${sentence(`Windows has no spelling without a blank of ${unspelled.join(' and ')}`)}\n`;
  const tried = `${noSpelling}${failed.join('\n')}\n`;
  const refusal = Object.hasOwn(REFUSED, agent) ? REFUSED[agent] : undefined;
  if (refusal !== undefined)
    return {
      command: quoted,
      warning: null,
      refused: `${refusal.summary}\n${tried}${refusal.fix}\n`,
    };
  return {
    command: quoted,
    warning: `Warning: no line for ${agent} without a quote could be shown to start through cmd.exe, so the usual quoted line was written. If ${agent} starts a hook line the way Antigravity does, with each quote escaped, it cannot start that one and its hook will not run; "stroq doctor" shows when the hook was last called.\n${tried}`,
    refused: null,
  };
}
