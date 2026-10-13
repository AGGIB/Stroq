import { tmpdir } from 'node:os';
import { plainText } from '../plain-text.js';
import type { HostDriver, HostRun, Probe, ProbeContext } from '../types.js';
import { scrubbedEnv } from '../verify-input.js';
import { DEFAULT_DETECT_TIMEOUT_MS, DEFAULT_KILL_GRACE_MS, hostRunOf } from './claude.js';
import { CODEX_AUTH_ARGS, codexArgv } from './codex-argv.js';
import { codexHookCommand } from './codex-hook.js';
import { CodexStreamParser } from './codex-stream.js';
import { codexIsolationProblem } from './codex-isolation.js';
import { codexSpawn } from './codex-process.js';
import { type StreamLimits } from './claude-stream.js';
import { definedEnv, superviseHost, type HostSpawn } from './host-process.js';

export interface CodexDriverOptions {
  readonly hookLine: string;
  readonly bin?: string;
  readonly spawn?: HostSpawn;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly detectTimeoutMs?: number;
  readonly killGraceMs?: number;
  readonly limits?: StreamLimits;
  readonly signal?: AbortSignal;
  /** Filesystem preflight; a test can supply an isolated inspector. */
  readonly isolationCheck?: typeof codexIsolationProblem;
}

const noRun = (why: string, apiKeySource?: string): HostRun => ({
  stream: [],
  exitCode: null,
  timedOut: false,
  stderrTail: plainText(why, 200),
  ...(apiKeySource === undefined ? {} : { apiKeySource }),
});
const safeEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(scrubbedEnv(definedEnv(env))).filter(
      ([key]) => !/^CODEX_(?:ACCESS_TOKEN|FEDERATION_|AUTH_)/i.test(key),
    ),
  );

/** One preflight and one fresh, ephemeral process per request. Authentication is never copied. */
export function createCodexDriver(options: CodexDriverOptions): HostDriver {
  const bin = options.bin ?? 'codex';
  const spawn = options.spawn ?? codexSpawn;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const timeout = options.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
  const interrupted = (): boolean => options.signal?.aborted === true;

  async function printed(args: readonly string[], env: Record<string, string>, cwd: string) {
    let output = '';
    const keep = (chunk: string): boolean => {
      output = (output + chunk).slice(0, 4096);
      return false;
    };
    const ended = await superviseHost({
      file: bin,
      args,
      cwd,
      env,
      deadlineMs: timeout,
      killGraceMs,
      spawn,
      onStdout: keep,
      onStderr: keep,
      signal: options.signal,
    });
    return { ended, output: output.trim() };
  }

  async function detect() {
    const { ended, output } = await printed(
      ['--version'],
      safeEnv(options.env ?? process.env),
      tmpdir(),
    );
    const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output)?.[1];
    if (ended.exitCode === 0 && version !== undefined) return { available: true, version };
    return {
      available: false,
      version: null,
      note: ended.timedOut
        ? 'codex --version did not answer in time'
        : 'codex was not found or did not print a version number; STROQ_CODEX_BIN can name a native executable (codex.exe on Windows)',
    };
  }

  async function run(probe: Probe, ctx: ProbeContext): Promise<HostRun> {
    try {
      if (interrupted()) return noRun('stopped: the check was interrupted before this request');
      const env = safeEnv(ctx.env);
      const isolation = (options.isolationCheck ?? codexIsolationProblem)(env, ctx.project);
      if (isolation !== null) return noRun(isolation);
      const login = await printed(['login', 'status', ...CODEX_AUTH_ARGS], env, ctx.project);
      if (login.ended.exitCode !== 0 || login.output !== 'Logged in using ChatGPT')
        return noRun(
          'Codex ChatGPT login could not be confirmed; no inference request was made',
          /api[ _-]?key/i.test(login.output) ? 'api-key' : undefined,
        );
      if (interrupted()) return noRun('stopped: the check was interrupted before this request');
      const parser = new CodexStreamParser(options.limits);
      const ended = await superviseHost({
        file: bin,
        args: codexArgv(probe, codexHookCommand(ctx, options.hookLine)),
        cwd: ctx.project,
        env,
        deadlineMs: ctx.deadlineMs,
        killGraceMs,
        spawn,
        onStdout: (chunk) => parser.push(chunk) !== null,
        onStderr: (chunk) => parser.pushStderr(chunk) !== null,
        signal: options.signal,
      });
      // exec --json does not repeat login status. These claims come from the preceding host preflight
      // and the forced provider/login flags, not from the model. An API signal in the stream wins.
      return hostRunOf(
        { apiKeySource: 'oauth', apiProvider: 'firstParty', cwd: ctx.project, ...parser.finish() },
        ended,
      );
    } catch (error) {
      return noRun(
        `could not run Codex: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { mode: 'live', detect, run };
}
