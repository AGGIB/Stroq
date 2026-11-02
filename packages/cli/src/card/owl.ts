// The card with Hoo beside it: the owl on the left, the card's lines on the right.
//
// Whether the owl is drawn at all, still or as a short greeting is `mascotPlan`'s decision; this file
// only carries it out. The card's lines are the same with or without the owl, so a pipe, a screen
// reader or `--plain` gets exactly the text. The greeting plays once per machine: after it finishes,
// "greeted" is written down under the Stroq home and later runs draw one still frame.
import { writeUnfiltered } from '../terminal-safe.js';
import { hasGreeted, markGreeted } from '../ui/mascot/greeted.js';
import { mascotPlan, playGreeting, type MascotFlags } from '../ui/mascot/play.js';
import { renderCard as drawCard, visibleWidth, type ColorDepth } from '../ui/mascot/render.js';
import type { FrameName } from '../ui/mascot/sprites.js';
import { currentTerminal } from '../ui/terminal.js';
import type { CardData } from './data.js';

/** What the owl says about the result: found something, found nothing, or had nothing to read. */
export function owlFrame(data: CardData): FrameName {
  if (data.coverage.found === 0) return 'idle';
  return data.moments.length > 0 ? 'alert' : 'happy';
}

/** What printing the card needs from the world, so that a test can stand in for it. */
export interface OwlWorld {
  readonly stdoutIsTTY: boolean;
  /** The terminal's real width in columns, or undefined when it is not known. */
  readonly columns: number | undefined;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly greetedBefore: () => boolean;
  readonly markGreeted: () => void;
  /** Plain text, through the safe-output filter. */
  readonly writeText: (text: string) => void;
  /** Drawn output: the owl's colour sequences must reach the terminal as they are. */
  readonly writeDrawn: (text: string) => void;
  readonly play: typeof playGreeting;
}

export function currentOwlWorld(): OwlWorld {
  const term = currentTerminal();
  return {
    stdoutIsTTY: process.stdout.isTTY === true,
    columns: process.stdout.isTTY === true ? process.stdout.columns : undefined,
    color: term.color,
    unicode: term.unicode,
    env: process.env,
    greetedBefore: () => hasGreeted(),
    markGreeted: () => {
      markGreeted();
    },
    writeText: (text) => process.stdout.write(text),
    writeDrawn: writeUnfiltered,
    play: playGreeting,
  };
}

/** Prints the card's lines with the owl beside them, above them on a narrow terminal, or not at all. */
export async function printCardWithOwl(
  lines: readonly string[],
  frame: FrameName,
  flags: MascotFlags,
  world: OwlWorld = currentOwlWorld(),
): Promise<void> {
  const plan = mascotPlan(
    { stdoutIsTTY: world.stdoutIsTTY, color: world.color, unicode: world.unicode },
    world.env,
    flags,
    world.greetedBefore(),
  );
  if (plan.kind === 'none' || plan.colorMode === 'none') {
    world.writeText(`${lines.join('\n')}\n`);
    return;
  }
  const colorMode: ColorDepth = plan.colorMode;
  const beside = drawCard(frame, { colorMode, textLines: lines });
  const fits =
    world.columns === undefined || Math.max(...beside.map(visibleWidth)) <= world.columns;
  if (!fits) {
    // Too narrow to stand side by side: the owl above, the text below, never wrapped into each other.
    const owl = drawCard(frame, { colorMode, textLines: [] });
    world.writeDrawn(`${owl.join('\n')}\n\n`);
    world.writeText(`${lines.join('\n')}\n`);
    return;
  }
  if (plan.kind === 'still') {
    world.writeDrawn(`${beside.join('\n')}\n`);
    return;
  }
  await world.play({
    colorMode,
    textLines: lines,
    finalFrame: frame,
    ...(world.columns === undefined ? {} : { columns: world.columns }),
    onFinished: world.markGreeted,
  });
}
