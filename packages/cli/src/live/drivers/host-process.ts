// Running a host as a child process for one request, and making sure it ends.
//
// What is asked of it is what a live check cannot do without: the host (and anything it started) is gone
// when the request is over, whichever way it ended. At the deadline it is asked to stop and then killed, a
// host that has been shown to be paid for by something that was not set aside is killed at once, and so is
// one that the check is interrupted under. Output is read as it comes, so that the reader can say "stop".
// Nothing here throws: a program that cannot be started is a run that did not get to the end, with the
// reason, as every driver must hand it over.
//
// The child is started in a process group of its own (`detached` on POSIX), so that the host and its tools
// can be ended together: the shell tool of the host starts commands, and a hook starts a Stroq. That also
// means a Ctrl-C in the terminal does not reach it, which is why the command that runs a check ends the
// host itself when it is interrupted (`signal` here).
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { killTree } from '../../commands/process-tree.js';
import { plainText } from '../plain-text.js';
import type { HostRun } from '../types.js';
import type { ParsedStream } from './claude-stream.js';

export const DEFAULT_DETECT_TIMEOUT_MS = 5_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** The longest end of the error stream that is kept. */
export const STDERR_TAIL_CHARS = 4096;
const MAX_REASON_CHARS = 200;

/** What the code here uses of a child process; a real one, or a stand-in for a test. */
export interface HostChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface HostSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
  readonly detached: boolean;
  readonly windowsHide: true;
}

/** `spawn`, as far as this module uses it. No shell: the program is given its arguments one by one. */
export type HostSpawn = (
  file: string,
  args: readonly string[],
  options: HostSpawnOptions,
) => HostChild;

export const realSpawn: HostSpawn = (file, args, options) =>
  spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [...options.stdio],
    detached: options.detached,
    windowsHide: options.windowsHide,
  });

export interface HostSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** The most the process may run for. */
  readonly deadlineMs: number;
  /** How long a process that was asked to stop is given before it is killed. */
  readonly killGraceMs: number;
  readonly spawn: HostSpawn;
  /** Gets what the process prints, as text; returns true to have the process killed on the spot. */
  readonly onStdout: (chunk: string) => boolean;
  /** Some hosts report a rejected tool call only on stderr. */
  readonly onStderr?: (chunk: string) => boolean;
  /** Aborted when the check is interrupted: the process is killed at once. */
  readonly signal?: AbortSignal | undefined;
}

export interface Supervised {
  /** Null when the process was killed, or never started. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The end of what it printed on its error stream, or why it could not be started. */
  readonly stderrTail: string;
  /** The reader asked for it to be killed. */
  readonly stoppedByReader: boolean;
  /** The check was interrupted. */
  readonly interrupted: boolean;
}

/** Combine parsed host facts with the outcome of the supervised process. */
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

/** The variables of an environment that have a value, as the plain record a child process takes. */
export const definedEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

const describe = (err: unknown): string =>
  plainText(err instanceof Error ? err.message : String(err), MAX_REASON_CHARS);

const notStarted = (err: unknown): Supervised => ({
  exitCode: null,
  timedOut: false,
  stderrTail: `could not start the host: ${describe(err)}`,
  stoppedByReader: false,
  interrupted: false,
});

class Supervision {
  private timedOut = false;
  private interrupted = false;
  private stoppedByReader = false;
  private stderr = '';
  private done = false;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly child: HostChild,
    private readonly spec: HostSpec,
    private readonly resolve: (outcome: Supervised) => void,
  ) {}

  begin(): void {
    const { child, spec } = this;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      // A broken pipe is the process ending; it is not an error of the check.
      stream?.on('error', () => undefined);
    }
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk));
    child.on('error', (err) => this.onError(err));
    child.on('close', (code) => this.finish(code));
    this.later(spec.deadlineMs, () => this.onDeadline());
    spec.signal?.addEventListener('abort', this.interrupt, { once: true });
  }

  private later(ms: number, act: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      act();
    }, ms);
    this.timers.add(timer);
  }

  private kill(signal: NodeJS.Signals): void {
    killTree(this.child, signal);
  }

  /** The process is told to die for good, and not waited for for ever if it cannot be reaped. */
  private killForGood(): void {
    this.kill('SIGKILL');
    this.later(this.spec.killGraceMs, () => this.finish(null));
  }

  private onStdout(chunk: string): void {
    if (this.done || this.stoppedByReader || this.interrupted) return;
    if (!this.spec.onStdout(chunk)) return;
    this.stoppedByReader = true;
    this.killForGood();
  }

  private onStderr(chunk: string): void {
    this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    if (!this.done && !this.stoppedByReader && !this.interrupted && this.spec.onStderr?.(chunk)) {
      this.stoppedByReader = true;
      this.killForGood();
    }
  }

  private onError(err: Error): void {
    // An error before the process has an id is a program that was not started (not found, not allowed, no
    // such directory). Later ones (a signal that could not be sent) are the end of a process that is ending.
    if (this.child.pid !== undefined) return;
    this.stderr = notStarted(err).stderrTail;
    this.finish(null);
  }

  private onDeadline(): void {
    this.timedOut = true;
    this.kill('SIGTERM');
    this.later(this.spec.killGraceMs, () => this.killForGood());
  }

  private readonly interrupt = (): void => {
    if (this.done) return;
    this.interrupted = true;
    this.killForGood();
  };

  private finish(code: number | null): void {
    if (this.done) return;
    this.done = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.spec.signal?.removeEventListener('abort', this.interrupt);
    // What it started may outlive it. Where the process was ended on purpose, what is left of its group is
    // ended with it; where it ended by itself, its group is not touched.
    if (this.timedOut || this.stoppedByReader || this.interrupted) this.kill('SIGKILL');
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.resolve({
      exitCode: code,
      timedOut: this.timedOut,
      stderrTail: this.stderr,
      stoppedByReader: this.stoppedByReader,
      interrupted: this.interrupted,
    });
  }
}

/** Starts the process and resolves when it has ended (or has been given up on). Never rejects. */
export function superviseHost(spec: HostSpec): Promise<Supervised> {
  return new Promise((resolve) => {
    let child: HostChild;
    try {
      child = spec.spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      resolve(notStarted(err));
      return;
    }
    new Supervision(child, spec, resolve).begin();
  });
}
