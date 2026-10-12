// The driver of Claude Code (`claude -p`) for the live check.
//
// One request is one process: `claude` is started with the argv of `claude-argv.ts` in the throwaway
// project, with the environment `verifyHost` handed over, and its stream is read as it arrives
// (`claude-stream.ts`). Three things are done here that nothing else can do:
//
// - the host is KILLED the moment its first message shows it is paid for by an API key, or its plan
//   shows it has moved on to extra usage or run out: a request that is made is already paid for;
// - the host, and every process it started, is gone when the request is over, whichever way it ended;
// - nothing is thrown: a program that is not there, a directory that is gone, a stream that is garbage,
//   all are a run that says so.
//
// The real run and the control are started alike but for the command of the hook (`claude-argv.ts`).
import { tmpdir } from 'node:os';
import { plainText } from '../plain-text.js';
import type { HostDriver, HostRun, Probe, ProbeContext } from '../types.js';
import { claudeArgv } from './claude-argv.js';
import {
  ClaudeStreamParser,
  DEFAULT_STREAM_LIMITS,
  type ParsedStream,
  type StreamLimits,
} from './claude-stream.js';
import { realSpawn, superviseHost, type HostSpawn, type Supervised } from './host-process.js';

/** The program, when nothing says otherwise: `claude`, found on the PATH. */
export const DEFAULT_CLAUDE_BIN = 'claude';

/** `claude --version` prints a line and ends; a host that takes longer than this is not answering. */
export const DEFAULT_DETECT_TIMEOUT_MS = 5_000;
/** How long a process that was asked to stop is given before it is killed. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

const WINDOWS_NOTE = 'the live check does not run on Windows yet';

export interface ClaudeDriverOptions {
  /** The command `stroq init` writes for Claude Code: what the host runs as its hook. */
  readonly hookLine: string;
  /** The program. By default `claude`, found on the PATH. */
  readonly bin?: string;
  /** Starts a process. A test says what it answers; the default is `child_process.spawn`. */
  readonly spawn?: HostSpawn;
  readonly platform?: NodeJS.Platform;
  /** The environment `claude --version` is asked in. By default the caller's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly detectTimeoutMs?: number;
  readonly killGraceMs?: number;
  readonly limits?: StreamLimits;
  /** Aborted when the check is interrupted: the host is killed, and no further request starts one. */
  readonly signal?: AbortSignal;
}

/** The first thing `claude --version` prints, which is the number of the version: `2.1.271 (Claude Code)`. */
const VERSION_LINE = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.+-]{1,40})?)(?:\s|$)/;
const MAX_VERSION_OUTPUT_CHARS = 4096;

/** The version a `--version` answer names, or null when it names none. */
export function versionOf(output: string): string | null {
  const first = output.trimStart().split('\n', 1)[0] ?? '';
  return VERSION_LINE.exec(first.trim())?.[1] ?? null;
}

/** A run that never got to the end, and says why. */
const didNotRun = (why: string): HostRun => ({
  stream: [],
  exitCode: null,
  timedOut: false,
  stderrTail: plainText(why, 200),
  unparsedLines: 0,
});

/** What was said on the way, together with how the process ended: the run a verdict is made of. */
export function hostRunOf(parsed: ParsedStream, ended: Supervised): HostRun {
  const interrupted = 'stopped: the check was interrupted';
  return {
    stream: parsed.stream,
    exitCode: ended.exitCode,
    timedOut: ended.timedOut,
    stderrTail: ended.interrupted ? `${interrupted}\n${ended.stderrTail}`.trim() : ended.stderrTail,
    ...(parsed.limitHit === undefined ? {} : { limitHit: parsed.limitHit }),
    ...(parsed.apiProvider === undefined ? {} : { apiProvider: parsed.apiProvider }),
    ...(parsed.apiKeySource === undefined ? {} : { apiKeySource: parsed.apiKeySource }),
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    unparsedLines: parsed.unparsedLines,
  };
}

export function createClaudeDriver(options: ClaudeDriverOptions): HostDriver {
  const bin = options.bin ?? DEFAULT_CLAUDE_BIN;
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? realSpawn;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  async function detect(): Promise<{ available: boolean; version: string | null; note?: string }> {
    if (platform === 'win32') return { available: false, version: null, note: WINDOWS_NOTE };
    let printed = '';
    const ended = await superviseHost({
      file: bin,
      args: ['--version'],
      cwd: tmpdir(),
      env: stringsOf(options.env ?? process.env),
      deadlineMs: options.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS,
      killGraceMs,
      spawn,
      onStdout: (chunk) => {
        printed = (printed + chunk).slice(0, MAX_VERSION_OUTPUT_CHARS);
        return false;
      },
    });
    return detected(printed, ended, bin);
  }

  async function run(probe: Probe, ctx: ProbeContext): Promise<HostRun> {
    try {
      if (platform === 'win32') return didNotRun(WINDOWS_NOTE);
      if (options.signal?.aborted === true)
        return didNotRun('stopped: the check was interrupted before this request');
      const parser = new ClaudeStreamParser(options.limits ?? DEFAULT_STREAM_LIMITS);
      const ended = await superviseHost({
        file: bin,
        args: claudeArgv(probe, ctx, options.hookLine),
        cwd: ctx.project,
        env: ctx.env,
        deadlineMs: ctx.deadlineMs,
        killGraceMs,
        spawn,
        onStdout: (chunk) => parser.push(chunk) !== null,
        signal: options.signal,
      });
      return hostRunOf(parser.finish(), ended);
    } catch (err) {
      return didNotRun(
        `could not run the host: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { detect, run, mode: 'live' };
}

/** The variables of an environment that have a value, as the plain record a child process takes. */
function stringsOf(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** What `claude --version` came to, as an answer to "is the host there, and which". */
function detected(
  printed: string,
  ended: Supervised,
  bin: string,
): { available: boolean; version: string | null; note?: string } {
  const no = (note: string): { available: false; version: null; note: string } => ({
    available: false,
    version: null,
    note: plainText(note, 200),
  });
  if (ended.stderrTail.startsWith('could not start'))
    return no(`${plainText(bin, 80)} was not found or could not be started`);
  if (ended.timedOut) return no('claude --version did not answer in time');
  if (ended.exitCode !== 0) return no(`claude --version exited with code ${ended.exitCode ?? '?'}`);
  const version = versionOf(printed);
  return version === null
    ? no('claude --version did not print a version number')
    : { available: true, version };
}
