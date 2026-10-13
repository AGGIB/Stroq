import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { binOnPath } from '../../run/which.js';
import { plainText } from '../plain-text.js';
import { REASONS, type HostDriver, type HostRun, type Probe, type ProbeContext } from '../types.js';
import { scrubbedEnv } from '../verify-input.js';
import { DEFAULT_DETECT_TIMEOUT_MS, DEFAULT_KILL_GRACE_MS, hostRunOf } from './host-process.js';
import { CODEX_AUTH_ARGS, codexArgv } from './codex-argv.js';
import { codexHookCommand } from './codex-hook.js';
import { CodexStreamParser } from './codex-stream.js';
import { codexIsolationProblem } from './codex-isolation.js';
import { codexSpawn } from './codex-process.js';
import { type StreamLimits } from './claude-stream.js';
import { definedEnv, superviseHost, type HostSpawn } from './host-process.js';

export const CODEX_LOGIN_STATUS = 'Logged in using ChatGPT';

export interface CodexDriverOptions {
  readonly hookLine: string;
  readonly bin?: string;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: HostSpawn;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly detectTimeoutMs?: number;
  readonly killGraceMs?: number;
  readonly limits?: StreamLimits;
  readonly signal?: AbortSignal;
  /** Filesystem preflight; a test can supply an isolated inspector. */
  readonly isolationCheck?: typeof codexIsolationProblem;
}

const noRun = (
  why: string,
  reason: string = REASONS.hostError,
  apiKeySource?: string,
): HostRun => ({
  stream: [],
  exitCode: null,
  timedOut: false,
  stderrTail: plainText(why, 200),
  notStartedReason: reason,
  ...(apiKeySource === undefined ? {} : { apiKeySource }),
});
const safeEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(scrubbedEnv(definedEnv(env)))
      .filter(([key]) => !/^CODEX_/i.test(key) || key.toUpperCase() === 'CODEX_HOME')
      // Windows retains environment key spelling; the isolation reader needs one canonical key.
      .map(([key, value]) => [key.toUpperCase() === 'CODEX_HOME' ? 'CODEX_HOME' : key, value]),
  );

/** One preflight and one fresh, ephemeral process per request. Authentication is never copied. */
export function createCodexDriver(options: CodexDriverOptions): HostDriver {
  const bin = options.bin ?? 'codex';
  let resolvedBin: string | null | undefined;
  const program = (): string | null => {
    if (resolvedBin !== undefined) return resolvedBin;
    try {
      const candidate =
        options.bin === undefined
          ? binOnPath(bin, options.env ?? process.env)
          : isAbsolute(bin)
            ? bin
            : null;
      resolvedBin = candidate === null ? null : realpathSync.native(candidate);
    } catch {
      resolvedBin = null;
    }
    return resolvedBin;
  };
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
      file: program()!,
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
    if ((options.platform ?? process.platform) !== 'win32')
      return {
        available: false,
        version: null,
        note: 'Codex live protection is measured on Windows only; this platform is unmeasured',
      };
    if (program() === null)
      return {
        available: false,
        version: null,
        note: 'Codex executable was not found; STROQ_CODEX_BIN must name an absolute native executable (codex.exe on Windows)',
      };
    const { ended, output } = await printed(
      ['--version'],
      safeEnv(options.env ?? process.env),
      tmpdir(),
    );
    const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)/.exec(output)?.[1];
    if (ended.exitCode === 0 && version !== undefined)
      return version === '0.162.1'
        ? { available: true, version }
        : {
            available: false,
            version,
            note: 'Codex live protection is measured only with CLI 0.162.1; this version is unmeasured',
          };
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
      if ((options.platform ?? process.platform) !== 'win32')
        return noRun(
          'Codex live protection is measured on Windows only; this platform is unmeasured',
          REASONS.hostUnmeasured,
        );
      if (interrupted()) return noRun('stopped: the check was interrupted before this request');
      if (program() === null)
        return noRun(
          'Codex executable was not found; set STROQ_CODEX_BIN to an absolute native executable',
          REASONS.hostNotFound,
        );
      const env = safeEnv(ctx.env);
      const isolation = (options.isolationCheck ?? codexIsolationProblem)(env, ctx.project);
      if (isolation !== null) return noRun(isolation, REASONS.hostNotIsolated);
      const login = await printed(['login', 'status', ...CODEX_AUTH_ARGS], env, ctx.project);
      if (login.ended.exitCode !== 0 || login.output !== CODEX_LOGIN_STATUS)
        return noRun(
          'Codex ChatGPT login could not be confirmed; no inference request was made',
          /api[ _-]?key/i.test(login.output) ? REASONS.apiBilling : REASONS.loginUnconfirmed,
          /api[ _-]?key/i.test(login.output) ? 'api-key' : undefined,
        );
      if (interrupted()) return noRun('stopped: the check was interrupted before this request');
      const parser = new CodexStreamParser(options.limits);
      const ended = await superviseHost({
        file: program()!,
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
      const parsed = parser.finish();
      const modelError = parsed.stream.find(
        (event) =>
          event.type === 'result' &&
          event.isError === true &&
          /\bmodel\b.*(?:not (?:supported|found|available)|does not exist|unavailable|access)|(?:unsupported|unknown|unavailable) model/i.test(
            event.text ?? '',
          ),
      );
      const run = hostRunOf(
        { apiKeySource: 'oauth', apiProvider: 'firstParty', cwd: ctx.project, ...parsed },
        ended,
      );
      return modelError === undefined
        ? run
        : {
            ...run,
            failureReason: REASONS.modelUnavailable,
            stderrTail: plainText(modelError.text ?? '', 200),
          };
    } catch (error) {
      return noRun(
        `could not run Codex: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { mode: 'live', detect, run };
}
