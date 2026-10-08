// One step of a longer job: a spinner while it runs on a terminal, one line when it is done, and,
// where nothing can animate (a pipe, a log, `TERM=dumb`), just that one line.
import { QUIT_EXIT_CODE, runInterruptCleanups } from './cleanup.js';
import type { Style } from './style.js';
import type { Symbols } from './symbols.js';
import type { Terminal } from './terminal.js';

/** How often the frame turns. */
export const FRAME_MS = 80;

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR_LINE = '\r\u001b[2K';

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface Step {
  /** The step worked: the line it leaves says so, and `detail` is what is said under it. */
  succeed(text?: string, detail?: readonly string[]): void;
  /** The step did not: the line it leaves says so, in the colour of a failure. */
  fail(text?: string, detail?: readonly string[]): void;
  /** The step has nothing to report: its line is a dash. */
  skip(text?: string, detail?: readonly string[]): void;
}

/**
 * The signals that end a process without an `exit` event, and leave a hidden cursor hidden. `SIGQUIT`
 * (Ctrl-\) is not Windows's.
 */
const ENDING_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGHUP']
    : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * Lets the event loop run before the caller goes on: a signal that came while the process was busy in
 * code that does not return to it (a copy of files, a command waited for) is delivered to the handlers
 * the step still has, and not dropped when the step ends in the same turn. Two turns, so that the
 * poll that reads the signal comes between them whichever phase of a turn the caller stood in.
 */
export const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(() => setImmediate(resolve));
  });

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Starts a step. On a terminal the first frame is drawn at once (a screen that is blank for a
 * second looks stuck) and the cursor is hidden until the step ends, and restored if the process
 * is left while it is hidden.
 */
export function startStep(
  term: Terminal,
  style: Style,
  symbols: Symbols,
  label: string,
  timers: Timers = realTimers,
): Step {
  const animated = term.interactive;
  let frame = 0;
  let handle: unknown;
  let done = false;
  const restore = (): void => {
    term.write(SHOW_CURSOR);
  };
  // A signal ends the process without an `exit` event: the cursor is shown, and the signal is raised
  // again for what it was going to do.
  const onSignal = new Map<NodeJS.Signals, () => void>();
  const draw = (): void => {
    term.write(
      `${CLEAR_LINE}  ${style.accent(symbols.frames[frame % symbols.frames.length] ?? '')} ${label}`,
    );
    frame += 1;
  };
  if (animated) {
    term.write(HIDE_CURSOR);
    draw();
    handle = timers.setInterval(draw, FRAME_MS);
    process.once('exit', restore);
    for (const signal of ENDING_SIGNALS) {
      const leave = (): void => {
        restore();
        runInterruptCleanups();
        // A core dump is not what Ctrl-\ is wanted for here (macOS holds such a process, unkillable, while
        // its crash reporter looks at it): it ends as it would have, with the code a shell shows for it.
        if (signal === 'SIGQUIT') process.exit(QUIT_EXIT_CODE);
        else process.kill(process.pid, signal);
      };
      onSignal.set(signal, leave);
      process.once(signal, leave);
    }
  }
  const finish = (mark: string, text: string, detail: readonly string[]): void => {
    if (done) return;
    done = true;
    const under = detail.map((line) => `    ${line}\n`).join('');
    if (animated) {
      timers.clearInterval(handle);
      process.removeListener('exit', restore);
      for (const [signal, leave] of onSignal) process.removeListener(signal, leave);
      term.write(`${CLEAR_LINE}  ${mark} ${text}\n${under}${SHOW_CURSOR}`);
    } else term.write(`  ${mark} ${text}\n${under}`);
  };
  return {
    succeed: (text = label, detail = []) => finish(style.good(symbols.ok), text, detail),
    fail: (text = label, detail = []) => finish(style.bad(symbols.bad), text, detail),
    skip: (text = label, detail = []) => finish(style.dim(symbols.none), text, detail),
  };
}
