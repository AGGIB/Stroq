import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject, writeJsonObject } from './config-file.js';

/**
 * OpenClaw loads plugins from a directory, not from a config file, so `init` has a
 * different job here than it does for the other four agents: it materialises the
 * plugin `@stroq/cli` ships, records how to start Stroq beside it, and then hands the
 * Gateway two `openclaw plugins …` commands. Nothing is merged and nothing of anyone
 * else's is touched — the directory is Stroq's own, and re-running `init` overwrites
 * it wholesale, which is what makes the install idempotent by construction.
 */

export const OPENCLAW_PLUGIN_ID = 'stroq';
const OPENCLAW_BIN = 'openclaw';
const PLUGIN_DIRNAME = 'openclaw-plugin';
const PLUGIN_ENTRY = 'index.js';
const PLUGIN_MANIFEST = 'openclaw.plugin.json';
/** Named separately so `doctor.ts` can point a half-install line at the manifest — the file
 * that carries the plugin id `isStroqOpenClawPlugin` checks once every shipped file exists. */
export const OPENCLAW_PLUGIN_MANIFEST = PLUGIN_MANIFEST;

/** The five files the plugin is made of, all shipped inside `@stroq/cli`. */
export const OPENCLAW_PLUGIN_FILES: readonly string[] = [
  PLUGIN_MANIFEST,
  'package.json',
  PLUGIN_ENTRY,
  'run-stroq.js',
  'README.md',
];

/** The sixth file, written by `init` rather than shipped: how to start Stroq. */
export const OPENCLAW_COMMAND_FILE = 'stroq.json';

/** `src/commands/` in development and `dist/` in a published install are two levels apart. */
const MAX_PACKAGE_DEPTH = 4;

/**
 * The `openclaw-plugin/` directory inside the installed package, found by walking up
 * from this module rather than by a fixed relative path: `import.meta.url` is
 * `<pkg>/dist/index.js` in a published install (tsup bundles everything into one
 * file) and `<pkg>/src/commands/openclaw-plugin.ts` under tsx, which are different
 * depths, and guessing wrong means an `init` that copies nothing.
 */
export function packagedPluginDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let depth = 0; depth < MAX_PACKAGE_DEPTH; depth += 1) {
    const candidate = join(dir, PLUGIN_DIRNAME);
    if (existsSync(join(candidate, PLUGIN_ENTRY))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    `Stroq: cannot find the ${PLUGIN_DIRNAME} directory shipped with @stroq/cli ` +
      `(looked upwards from ${from}). Reinstall the package.`,
  );
}

/**
 * Where the plugin is materialised. Mirrors `stroqHome()` in `paths.ts` but takes the
 * environment explicitly, the way `copilotHooksPath` does, so a test can pin it
 * without mutating `process.env`. There is no project/user split: OpenClaw plugins are
 * per Gateway host, not per repository.
 */
export function openclawPluginDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = env['STROQ_HOME'];
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.stroq'), PLUGIN_DIRNAME);
}

/** Copies the five shipped files into `dir` and records `command` beside them. */
export function installOpenClawPlugin(dir: string, command: readonly string[]): readonly string[] {
  const source = packagedPluginDir();
  mkdirSync(dir, { recursive: true });
  for (const name of OPENCLAW_PLUGIN_FILES) copyFileSync(join(source, name), join(dir, name));
  const commandFile = join(dir, OPENCLAW_COMMAND_FILE);
  writeJsonObject(commandFile, { command: [...command] });
  return [...OPENCLAW_PLUGIN_FILES.map((name) => join(dir, name)), commandFile];
}

/**
 * The first shipped file `dir` does not have, or `null` when it has them all. Named
 * separately from the predicate below so `doctor` can point its "missing" line at the
 * file that is actually absent instead of always at the manifest.
 */
export function missingOpenClawPluginFile(dir: string): string | null {
  return OPENCLAW_PLUGIN_FILES.find((name) => !existsSync(join(dir, name))) ?? null;
}

/**
 * True only for a directory carrying EVERY shipped file and a manifest claiming
 * Stroq's id. It used to check the entry and the manifest alone, which reported a
 * directory whose `run-stroq.js` had been pruned as installed even though `index.js`
 * imports that module and the Gateway cannot load it at all; a manifest belonging to
 * somebody else is not Stroq's plugin either. Reporting any of those as installed
 * would promise protection that is not running.
 */
export function isStroqOpenClawPlugin(dir: string): boolean {
  if (missingOpenClawPluginFile(dir) !== null) return false;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST), 'utf8'));
    return isPlainObject(manifest) && manifest['id'] === OPENCLAW_PLUGIN_ID;
  } catch {
    return false;
  }
}

/**
 * npm's throwaway install directory, in both separator styles. `npx @stroq/cli init
 * --agent openclaw` runs from inside it, so the entry `init` records in `stroq.json`
 * lives there and vanishes the next time the cache is pruned.
 */
const NPX_CACHE = /[/\\]_npx[/\\]/;

/**
 * The warning `init` prints when the command it just recorded points into the npx
 * cache, or `null` when it does not. The plugin survives the pruning (it falls back
 * to `stroq` on PATH — see `resolveStroqArgv` in `run-stroq.js`), so this is advice
 * rather than a failure; but the fallback only finds a Stroq that is actually
 * installed, and this is the one moment the user can fix that.
 */
export function npxCacheWarning(command: readonly string[]): string | null {
  if (!command.some((arg) => NPX_CACHE.test(arg))) return null;
  return (
    'Warning: the recorded stroq entry lives in the npx cache; install @stroq/cli ' +
    'globally so the plugin survives cache pruning.'
  );
}

/**
 * argv of the two commands that register the plugin with a Gateway. `--link` rather
 * than a copying install, so `stroq init --agent openclaw` after an upgrade updates
 * the plugin the Gateway loads instead of leaving a stale copy behind.
 */
export const openclawInstallArgv = (dir: string): readonly (readonly string[])[] => [
  ['plugins', 'install', '--link', dir],
  ['plugins', 'enable', OPENCLAW_PLUGIN_ID],
];

/** Characters a POSIX shell reads as text; anything else makes the word need quoting. */
const SAFE_WORD = /^[\w@%+=:,./-]+$/;
const shellQuote = (arg: string): string =>
  SAFE_WORD.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

/** The same two commands as lines a user can paste, derived from the argv above. */
export const openclawInstallCommands = (dir: string): readonly string[] =>
  openclawInstallArgv(dir).map((argv) => [OPENCLAW_BIN, ...argv].map(shellQuote).join(' '));

/**
 * The `openclaw` binary on `PATH`, or `null`. A filesystem probe rather than a
 * `--version` call: deciding whether to run a program should not require running it,
 * and `stroq init` must never invoke a real Gateway CLI from a test.
 */
export function openclawOnPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  for (const entry of (env['PATH'] ?? '').split(delimiter)) {
    if (entry === '') continue;
    const candidate = join(entry, OPENCLAW_BIN);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, or not executable
    }
  }
  return null;
}

export interface CommandRun {
  readonly status: number | null;
  readonly output: string;
}
/** How `init` runs an external command; injectable so tests never spawn a real one. */
export type RunCommand = (file: string, args: readonly string[]) => CommandRun;

export const spawnCommand: RunCommand = (file, args) => {
  const result = spawnSync(file, [...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

export interface CommandOutcome {
  readonly line: string;
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Runs both commands and reports both, even when the first fails: `install --link` on
 * a plugin the Gateway already has linked is expected to fail, and `enable` still has
 * to run for the install to take effect.
 */
export function runOpenClawInstall(
  bin: string,
  dir: string,
  run: RunCommand = spawnCommand,
): readonly CommandOutcome[] {
  const lines = openclawInstallCommands(dir);
  return openclawInstallArgv(dir).map((argv, index) => {
    const { status, output } = run(bin, argv);
    return { line: lines[index] ?? '', ok: status === 0, output };
  });
}
