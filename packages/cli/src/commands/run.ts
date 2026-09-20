import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileSecretIndex, SEALED_SOURCES_ENV } from '@stroq/core';
import { secretsFile, stroqHome } from '../paths.js';
import { AGENT_STATE_DIRS, OWN_SANDBOX_AGENTS, agentIdFor } from '../run/agent-name.js';
import { launch as realLaunch } from '../run/launch.js';
import { preflight, type PreflightResult } from '../run/preflight.js';
import {
  SRT_BIN,
  SRT_MISSING,
  SRT_NO_RAW_MODE,
  generateSandbox,
  srtArgv,
  type GeneratedSandbox,
} from '../run/sandbox.js';
import { binOnPath } from '../run/which.js';
import { GIT_HARDENING, hardeningEnv } from './inspect.js';

/**
 * `stroq run` — start an agent that is already confined.
 *
 * Every other Stroq command acts from inside a session the user started themselves.
 * This one owns the moment before that, which is the only moment two of Stroq's
 * protections can be applied at all:
 *
 * - The git settings `stroq inspect --env` asks the user to export by hand are
 *   exported here instead. They have to be in the environment before the agent's
 *   first `git status`, which on Claude Code happens before the workspace-trust
 *   prompt — and a `SessionStart` hook is gated on that same prompt, so no hook can
 *   get in front of it.
 * - The pre-approval read of the repository has the same deadline, for the same
 *   reason, and `stroq run` refuses rather than warning (see `run/preflight.ts`).
 *
 * `--sandbox` adds OS-level confinement through Anthropic's `srt`, when it is
 * installed. That half is strictly additive: without `srt` everything above still
 * happens, loudly announced, and nothing silently downgrades.
 */

export const RUN_USAGE =
  'usage: stroq run [--agent <id>] [--sandbox] [--allow-domain <host>]… [--no-inspect] [--force] [--dry-run] -- <agent> [args...]\n';

export interface RunInvocation {
  /** `--agent`, or null to work the agent out from the command. */
  readonly agent: string | null;
  readonly sandbox: boolean;
  readonly allowedDomains: readonly string[];
  readonly inspect: boolean;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly command: string;
  readonly args: readonly string[];
}

export type RunArgvResult =
  | { readonly ok: true; readonly invocation: RunInvocation }
  | { readonly ok: false; readonly error: string };

const VALUE_OPTIONS = new Set(['--agent', '--allow-domain']);
const FLAGS = new Set(['--sandbox', '--no-inspect', '--force', '--dry-run']);

/**
 * Parsed by hand rather than with `node:util.parseArgs`, for the reason
 * `parseMcpArgv` gives: everything after the first `--` is the agent's own command
 * line and must never be interpreted, and a MISSING separator has to be
 * distinguishable from an empty command.
 */
export function parseRunArgv(argv: readonly string[]): RunArgvResult {
  let agent: string | null = null;
  let sandbox = false;
  let inspect = true;
  let force = false;
  let dryRun = false;
  const allowedDomains: string[] = [];
  let rest: readonly string[] | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (token === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (FLAGS.has(token)) {
      if (token === '--sandbox') sandbox = true;
      if (token === '--no-inspect') inspect = false;
      if (token === '--force') force = true;
      if (token === '--dry-run') dryRun = true;
      continue;
    }
    // A bare word before the separator is almost always `stroq run claude` — the
    // one mistake everyone makes once. "unknown option" would be a true but useless
    // answer to it, so it gets the error that names the fix instead.
    if (!VALUE_OPTIONS.has(token))
      return {
        ok: false,
        error: token.startsWith('-')
          ? `unknown option "${token}"`
          : `the agent command must follow "--" — did you mean: stroq run -- ${argv.join(' ')}`,
      };
    const value = argv[i + 1];
    // A value that starts with `--` is the next flag or the separator, never a
    // value: `--agent -- claude` would otherwise swallow the separator and read the
    // agent's name as this flag's argument.
    if (value === undefined || value.startsWith('--'))
      return { ok: false, error: `${token} needs a value` };
    if (token === '--agent') agent = value;
    if (token === '--allow-domain') allowedDomains.push(value);
    i += 1;
  }

  if (rest === null) return { ok: false, error: 'the agent command must follow "--"' };
  const [command, ...args] = rest;
  if (command === undefined || command === '')
    return { ok: false, error: 'the agent command must follow "--"' };
  // Accepting it silently would be a flag that reads as a restriction and applies
  // nothing: without `--sandbox` there is no domain list for it to go into.
  if (allowedDomains.length > 0 && !sandbox)
    return {
      ok: false,
      error: '--allow-domain needs --sandbox; without it there is no network policy to add to',
    };
  return {
    ok: true,
    invocation: { agent, sandbox, allowedDomains, inspect, force, dryRun, command, args },
  };
}

/** Injected so a test never has to install `srt` or start a real agent. */
export interface RunDeps {
  readonly srt?: (env: NodeJS.ProcessEnv) => string | null;
  readonly launch?: typeof realLaunch;
  readonly env?: NodeJS.ProcessEnv;
  readonly userHome?: string;
  readonly plat?: NodeJS.Platform;
  /** Whether a terminal is attached, i.e. whether the agent is likely interactive. */
  readonly isTTY?: boolean;
}

const line = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

function reportRefusals(command: string, result: PreflightResult, forced: boolean): void {
  const out = forced ? process.stderr : process.stdout;
  out.write(
    `\nstroq run: ${forced ? 'starting' : 'refusing to start'} "${command}" — ${result.refusals.length} problem${result.refusals.length === 1 ? '' : 's'}\n\n`,
  );
  for (const refusal of result.refusals) {
    out.write(`  ${refusal.reason}\n`);
    if (refusal.fix !== '') out.write(`    fix: ${refusal.fix}\n`);
  }
  out.write(
    forced
      ? '\n  --force was given, so the agent is starting anyway.\n\n'
      : '\nNothing was started. Fix the above, or re-run with --force to start the agent regardless.\n',
  );
}

/**
 * The write roots and read denials for this run.
 *
 * `sourcePaths` is a stat of the credential files the index already tracks, so a
 * dry run costs nothing and writes nothing. The index itself is only rebuilt on a
 * real launch, where it has to be current BEFORE it is sealed — inside the sandbox
 * the sources are unreadable by design, and an index rebuilt there would rebuild
 * itself empty (see `SEALED_SOURCES_ENV`).
 */
async function buildSandbox(
  invocation: RunInvocation,
  agent: string | null,
  cwd: string,
  userHome: string,
  refresh: boolean,
): Promise<GeneratedSandbox> {
  const index = new FileSecretIndex(secretsFile(), userHome);
  if (refresh) await index.refresh(cwd);
  const state = (agent === null ? [] : (AGENT_STATE_DIRS[agent] ?? [])).map((d) =>
    join(userHome, d),
  );
  return generateSandbox({
    workspace: cwd,
    stroqHome: stroqHome(),
    userHome,
    // `/tmp` as well as `os.tmpdir()`: on macOS the latter is a per-user directory
    // under `/var/folders`, and plenty of tooling writes to `/tmp` regardless.
    tmp: [tmpdir(), '/tmp'],
    agentState: state,
    secretPaths: index.sourcePaths(cwd),
    allowedDomains: invocation.allowedDomains,
  });
}

/** Writes the generated config where `srt` can read it, and hands back the path. */
function writeSandboxConfig(sandbox: GeneratedSandbox): string {
  const dir = join(stroqHome(), 'run');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `srt-${process.pid}.json`);
  // `srt` reads this before the sandbox exists, and compiles the filesystem rules
  // in at wrap time — so an agent that later rewrites the file (the Stroq home is
  // writable, because the hooks have to be) changes nothing about its own run.
  writeFileSync(file, `${JSON.stringify(sandbox.settings, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function reportSandbox(
  sandbox: GeneratedSandbox,
  agent: string | null,
  plat: NodeJS.Platform,
  isTTY: boolean,
): void {
  const fs = sandbox.settings.filesystem;
  line(
    `  sandbox: ${fs.denyRead.length} credential file${fs.denyRead.length === 1 ? '' : 's'} unreadable, writes limited to ${fs.allowWrite.length} paths`,
  );
  for (const path of fs.denyRead) line(`    no read: ${path}`);
  for (const path of fs.allowWrite) line(`    can write: ${path}`);
  for (const path of sandbox.refused)
    process.stderr.write(
      `  sandbox: refused "${path}" as a write root — granting it would not be a sandbox\n`,
    );
  if (sandbox.settings.network.allowedDomains.length === 0) {
    line(
      '  sandbox: all network is denied. The agent cannot reach its own API, and neither can anything it runs, until you name the hosts with --allow-domain.',
    );
  } else {
    line(`  sandbox: network limited to ${sandbox.settings.network.allowedDomains.join(', ')}`);
  }
  if (agent !== null && OWN_SANDBOX_AGENTS.has(agent))
    line(
      `  sandbox: ${agent} ships its own sandbox, so this adds a second, outer boundary rather than the first one.`,
    );
  if (plat === 'darwin' && isTTY) process.stderr.write(`${SRT_NO_RAW_MODE}\n`);
}

export async function runRun(
  argv: readonly string[],
  cwd: string = process.cwd(),
  deps: RunDeps = {},
): Promise<number> {
  const parsed = parseRunArgv(argv);
  if (!parsed.ok) {
    process.stderr.write(`stroq run: ${parsed.error}\n${RUN_USAGE}`);
    return 2;
  }
  const invocation = parsed.invocation;
  const env = deps.env ?? process.env;
  const userHome = deps.userHome ?? homedir();
  const workspace = resolve(cwd);
  const agent = invocation.agent ?? agentIdFor(invocation.command);

  const checks = preflight({
    agent,
    command: invocation.command,
    cwd: workspace,
    inspect: invocation.inspect,
  });
  if (checks.refusals.length > 0) {
    reportRefusals(invocation.command, checks, invocation.force);
    if (!invocation.force) return 1;
  }

  line(`\nstroq run — ${invocation.command}${agent === null ? '' : ` (${agent})`}`);
  const overlay = hardeningEnv(env);
  line(
    `  git hardening: ${GIT_HARDENING.map((h) => `${h.key}=${h.value}`).join(', ')}${
      Object.keys(overlay).length === 0 ? ' (already exported)' : ''
    }`,
  );
  for (const note of checks.notes) line(`  note: ${note}`);

  const findSrt = deps.srt ?? ((e: NodeJS.ProcessEnv) => binOnPath(SRT_BIN, e));
  const srtPath = invocation.sandbox ? findSrt(env) : null;
  if (invocation.sandbox && srtPath === null) process.stderr.write(`${SRT_MISSING}\n`);
  const sandbox =
    srtPath === null
      ? null
      : await buildSandbox(invocation, agent, workspace, userHome, !invocation.dryRun);
  if (sandbox !== null)
    reportSandbox(
      sandbox,
      agent,
      deps.plat ?? process.platform,
      deps.isTTY ?? process.stdin.isTTY === true,
    );

  const childEnvironment: NodeJS.ProcessEnv = {
    ...env,
    ...overlay,
    // Only when the sandbox is really in force: sealing an index whose sources are
    // perfectly readable would stop it noticing a credential file the user just
    // added, which is a downgrade of exactly the guard this is protecting.
    ...(sandbox === null ? {} : { [SEALED_SOURCES_ENV]: '1' }),
  };
  // A dry run writes no config, so it has nothing to name and nothing to clean up.
  const settingsFile = sandbox === null || invocation.dryRun ? null : writeSandboxConfig(sandbox);
  const file = srtPath ?? invocation.command;
  const args =
    srtPath === null
      ? invocation.args
      : srtArgv(settingsFile ?? '<written at launch>', invocation.command, invocation.args);

  if (invocation.dryRun) {
    line(`  would run: ${[file, ...args].join(' ')}`);
    if (sandbox !== null) line(JSON.stringify(sandbox.settings, null, 2));
    line('');
    return 0;
  }
  line('');
  try {
    return await (deps.launch ?? realLaunch)({
      command: file,
      args,
      env: childEnvironment,
    });
  } finally {
    if (settingsFile !== null) rmSync(settingsFile, { force: true });
  }
}
