// When the owl is shown, and how it is played.
//
// `mascotPlan` is the decision, pure: from what the terminal is, the environment, the flags and
// whether the person has been greeted before, it says "animate", "still" or "none", and in how many
// colours. `playGreeting` is the one effectful piece: it plays the greeting once, in place, with the
// cursor hidden, and puts the cursor back however it ends.

import { setTimeout as delay } from 'node:timers/promises';
import { writeErrUnfiltered, writeUnfiltered } from '../../terminal-safe.js';
import { QUIT_EXIT_CODE, runInterruptCleanups } from '../cleanup.js';
import type { TerminalFacts } from '../terminal.js';
import { renderCard, visibleWidth, type ColorDepth, type ColorMode } from './render.js';
import { GREETING, type FrameName, type Palette } from './sprites.js';

/**
 * What `terminalFacts` (`../terminal.ts`) already knows, plus the one thing it does not keep: whether
 * standard output is a terminal. `interactive` cannot stand in for it, because it also asks for a
 * terminal on standard input and for no CI, and a CI run on a terminal still gets a still frame.
 */
export interface MascotFacts extends Pick<TerminalFacts, 'color' | 'unicode'> {
  readonly stdoutIsTTY: boolean;
}

export interface MascotFlags {
  /** Plain output was asked for (`--plain`, `--json`, a screen reader): no owl at all. */
  readonly plain?: boolean;
  /** `--no-animation`: one frame. */
  readonly noAnimation?: boolean;
}

export type MascotKind = 'animate' | 'still' | 'none';

export interface MascotPlan {
  readonly kind: MascotKind;
  /** How to draw it: `none` exactly when `kind` is. */
  readonly colorMode: ColorMode;
}

type Env = Readonly<Record<string, string | undefined>>;

/** A switch in the environment is on unless it is missing, empty, `0` or `false`. */
function isOn(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/** `NO_COLOR` means what no-color.org says: any value that is not empty. */
const isNoColor = (value: string | undefined): boolean => value !== undefined && value !== '';

const isTruecolor = (colorterm: string | undefined): boolean =>
  colorterm !== undefined && ['truecolor', '24bit'].includes(colorterm.toLowerCase());

/**
 * 24-bit colour when `COLORTERM` says `truecolor` or `24bit`; otherwise the xterm 256 colours when
 * `TERM` contains `256color` (macOS Terminal.app is this: it sets `TERM=xterm-256color` and no
 * `COLORTERM`); otherwise the 16 basic colours.
 */
function colorDepth(env: Env): ColorDepth {
  if (isTruecolor(env['COLORTERM'])) return 'truecolor';
  return /256color/iu.test(env['TERM'] ?? '') ? 'ansi256' : 'ansi16';
}

/**
 * What to do with the owl. In this order:
 *
 *  - `none` (screen readers, pipes, plain output): standard output is not a terminal, the terminal
 *    facts say no colour or no UTF-8, `NO_COLOR` is set, `TERM=dumb`, `STROQ_NO_MASCOT` is on, or
 *    the caller asked for plain output.
 *  - `still` (one frame, no animation): `CI` is on, `STROQ_NO_ANIMATION` is on, `--no-animation`,
 *    or the person has been greeted before.
 *  - otherwise `animate`.
 *
 * The colour depth is 24-bit when `COLORTERM` says `truecolor` or `24bit`, else 256 colours when
 * `TERM` contains `256color`, else the 16 basic colours. Pure: it reads nothing but its arguments.
 */
export function mascotPlan(
  facts: MascotFacts,
  env: Env,
  flags: MascotFlags,
  greetedBefore: boolean,
): MascotPlan {
  const none =
    !facts.stdoutIsTTY ||
    !facts.color ||
    !facts.unicode ||
    flags.plain === true ||
    isNoColor(env['NO_COLOR']) ||
    env['TERM'] === 'dumb' ||
    isOn(env['STROQ_NO_MASCOT']);
  if (none) return { kind: 'none', colorMode: 'none' };
  const colorMode = colorDepth(env);
  const still =
    isOn(env['CI']) ||
    isOn(env['STROQ_NO_ANIMATION']) ||
    flags.noAnimation === true ||
    greetedBefore;
  return { kind: still ? 'still' : 'animate', colorMode };
}

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const cursorUp = (lines: number): string => `\u001b[${lines}A`;

/**
 * The signals that end a process without an `exit` event, and leave a hidden cursor hidden (the same
 * list as the spinner's). `SIGQUIT` (Ctrl-\) is not Windows's.
 */
const ENDING_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGHUP']
    : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/** Waits `ms`, or throws an `AbortError` as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

export interface PlayOptions {
  /** `none` is not played: there is nothing to draw. */
  readonly colorMode: ColorDepth;
  /** What stands beside the owl, one string a line (styled by the caller; its colour sequences count for nothing). */
  readonly textLines: readonly string[];
  readonly palette?: Palette;
  readonly gap?: number;
  readonly indent?: number;
  /**
   * How wide the terminal is. A card with a line wider than this would wrap, and the redraw, which
   * moves the cursor up by the card's height, would land in the wrong place: it is drawn once, still.
   */
  readonly columns?: number;
  /** Where to write: standard output, unless told standard error. Both skip the safe-output filter. */
  readonly stream?: 'stdout' | 'stderr';
  /** Stops the greeting; the cursor is put back. */
  readonly signal?: AbortSignal;
  /**
   * Called once, after the last frame, with the cursor back, and never when the greeting was
   * stopped or failed: this is where "greeted" is written down. It must not throw.
   */
  readonly onFinished?: () => void;
  /** For tests: where the text goes, and how time passes. */
  readonly write?: (text: string) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * `finished`: every frame was drawn. `interrupted`: stopped early, by a signal or by `signal`.
 * `still`: the card was too wide to redraw in place and one frame was drawn.
 */
export type GreetingOutcome = 'finished' | 'interrupted' | 'still';

/**
 * Plays the greeting once (`GREETING`: about 1.35 s) on the lines it writes, redrawing the card in
 * place. The cursor is hidden while it draws and is shown again when the greeting ends, when
 * drawing fails (the error is passed on), when `signal` stops it, and when the process is ended by
 * `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT` or `process.exit` in the middle of it. A signal also
 * runs what `cleanup.ts` has registered and is raised again, as the spinner does.
 */
export async function playGreeting(options: PlayOptions): Promise<GreetingOutcome> {
  if (options.signal?.aborted === true) return 'interrupted';
  const write =
    options.write ?? (options.stream === 'stderr' ? writeErrUnfiltered : writeUnfiltered);
  const sleep = options.sleep ?? abortableSleep;
  const card = (frame: FrameName): string[] =>
    renderCard(frame, {
      colorMode: options.colorMode,
      textLines: options.textLines,
      ...(options.palette === undefined ? {} : { palette: options.palette }),
      ...(options.gap === undefined ? {} : { gap: options.gap }),
      ...(options.indent === undefined ? {} : { indent: options.indent }),
    });

  const resting = card('idle');
  if (options.columns !== undefined && Math.max(...resting.map(visibleWidth)) > options.columns) {
    write(`${resting.join('\n')}\n`);
    return 'still';
  }

  const control = new AbortController();
  const stop = (): void => control.abort();
  options.signal?.addEventListener('abort', stop, { once: true });

  let cursorHidden = false;
  const showCursor = (): void => {
    if (!cursorHidden) return;
    cursorHidden = false;
    try {
      write(SHOW_CURSOR);
    } catch {
      // The stream is gone (a closed pipe): there is no cursor to put back, and the error that
      // matters, if there is one, is the one that is already on its way.
    }
  };
  const onSignal = new Map<NodeJS.Signals, () => void>();
  for (const signal of ENDING_SIGNALS) {
    const leave = (): void => {
      showCursor();
      stop();
      runInterruptCleanups();
      // Ctrl-\ is a core dump by default, which macOS holds an unkillable process for: it ends
      // with the code a shell shows for it. The others are raised again for what they were going to do.
      if (signal === 'SIGQUIT') process.exit(QUIT_EXIT_CODE);
      else process.kill(process.pid, signal);
    };
    onSignal.set(signal, leave);
    process.once(signal, leave);
  }
  process.once('exit', showCursor);

  const drawAll = async (): Promise<GreetingOutcome> => {
    cursorHidden = true;
    write(HIDE_CURSOR);
    for (const [index, beat] of GREETING.entries()) {
      if (control.signal.aborted) return 'interrupted';
      const lines = card(beat.frame);
      write(`${index === 0 ? '' : cursorUp(lines.length)}${lines.join('\n')}\n`);
      try {
        await sleep(beat.ms, control.signal);
      } catch (error) {
        if (control.signal.aborted) return 'interrupted';
        throw error;
      }
    }
    return control.signal.aborted ? 'interrupted' : 'finished';
  };

  let outcome: GreetingOutcome;
  try {
    outcome = await drawAll();
  } finally {
    showCursor();
    process.removeListener('exit', showCursor);
    for (const [signal, leave] of onSignal) process.removeListener(signal, leave);
    options.signal?.removeEventListener('abort', stop);
  }
  if (outcome === 'finished') options.onFinished?.();
  return outcome;
}
