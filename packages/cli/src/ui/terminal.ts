// What the terminal in front of the person can do, asked once.
//
// The commands that print for a person (`stroq init` the first time it runs, mostly) draw: a colour,
// a spinner, a tick. Whether they may is not theirs to decide: a pipe, a CI log and `TERM=dumb` say no
// to all of it, and the answer is a plain line; a `NO_COLOR` or `FORCE_COLOR=0` in the environment says
// no to the colour, and a Windows console that cannot draw a tick to the glyphs, and what is drawn is
// drawn without them. Asked here, in one place, from the environment and the streams, so that the
// rest of the code is told what it may do and tests can say what a terminal is without owning one.
import { createInterface } from 'node:readline';
import { writeUnfiltered } from '../terminal-safe.js';

export interface TerminalFacts {
  /** A person is there: standard input and output are terminals, it is not `TERM=dumb`, and this is not CI. */
  readonly interactive: boolean;
  /** Colour may be used: a terminal, no `NO_COLOR`, not `TERM=dumb`, or `FORCE_COLOR`. */
  readonly color: boolean;
  /** 256 colours are there to use (`TERM` says so, or `COLORTERM`). */
  readonly color256: boolean;
  /** The glyphs `✔ ✘ ·` and braille will show: not an old Windows console, not a locale that is not UTF-8. */
  readonly unicode: boolean;
  /** How wide a line may be, between 40 and 100. */
  readonly columns: number;
}

export interface Terminal extends TerminalFacts {
  /** Writes what the module drew. Its own escape sequences are the only ones in it (see `writeUnfiltered`). */
  write(text: string): void;
  /** One line the person types, or null at the end of the input. */
  readLine(prompt: string): Promise<string | null>;
}

/** What `terminalFacts` is told, so that a test can say what the world is. */
export interface World {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly columns: number | undefined;
  readonly platform: NodeJS.Platform;
}

/** A bare Enter sooner than this after a prompt was typed ahead of it, not in answer to it. */
export const TYPEAHEAD_MS = 250;

const MIN_COLUMNS = 40;
const MAX_COLUMNS = 100;
const DEFAULT_COLUMNS = 80;

/** The facts of a world. Pure. */
export function terminalFacts(world: World): TerminalFacts {
  const { env } = world;
  const dumb = env['TERM'] === 'dumb';
  const forced =
    env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0' && env['FORCE_COLOR'] !== '';
  const noColor = env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '';
  const ci =
    env['CI'] !== undefined && env['CI'] !== '' && env['CI'] !== '0' && env['CI'] !== 'false';
  // `FORCE_COLOR=0` (and `false`) is a way to say no, whatever the stream is.
  const forcedOff = env['FORCE_COLOR'] === '0' || env['FORCE_COLOR'] === 'false';
  const color = !noColor && !dumb && !forcedOff && (forced || world.stdoutIsTTY);
  // The locale a program sees is the first of these that is set (POSIX), not any of them.
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  // Windows consoles draw the glyphs in Windows Terminal and VS Code, and not in the old host.
  const windowsDraws = env['WT_SESSION'] !== undefined || env['TERM_PROGRAM'] === 'vscode';
  const unicode =
    !dumb && (world.platform === 'win32' ? windowsDraws : locale === '' || /utf-?8/i.test(locale));
  const width = world.columns !== undefined && world.columns > 0 ? world.columns : DEFAULT_COLUMNS;
  return {
    interactive: world.stdinIsTTY && world.stdoutIsTTY && !dumb && !ci,
    color,
    color256: color && (/256color/i.test(env['TERM'] ?? '') || (env['COLORTERM'] ?? '') !== ''),
    unicode,
    columns: Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, width)),
  };
}

/** The terminal this process has. */
export function currentTerminal(): Terminal {
  const facts = terminalFacts({
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    columns: process.stdout.columns,
    platform: process.platform,
  });
  return {
    ...facts,
    write: writeUnfiltered,
    readLine: (prompt) =>
      new Promise((resolve) => {
        // The terminal edits the line (it is in its ordinary mode, which is why nothing is drawn
        // here), so readline is given no output: what it would write through `process.stdout`, which
        // `withSafeOutput` has wrapped, would be shown as text, cursor movement and all.
        writeUnfiltered(prompt);
        const shownAt = performance.now();
        const rl = createInterface({ input: process.stdin, terminal: false });
        let answered = false;
        rl.on('line', (line) => {
          // A key held down while `npx` fetched the package is waiting in the terminal when the
          // question is asked, and a bare Enter there is not an answer to it: the default is a yes.
          if (line.trim() === '' && performance.now() - shownAt < TYPEAHEAD_MS) return;
          answered = true;
          rl.close();
          resolve(line);
        });
        rl.once('close', () => {
          if (!answered) resolve(null);
        });
      }),
  };
}
