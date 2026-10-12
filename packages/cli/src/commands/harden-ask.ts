import { confirm } from '../ui/prompt.js';
import { styleFor } from '../ui/style.js';
import type { HardenContext } from './harden-deps.js';
import type { HardenFlags } from './harden-flags.js';

/**
 * The question `apply` and `undo` put to a person, and the only way round it.
 *
 * Both change a file that belongs to someone else, so both are a person's to run. On a terminal the
 * person is asked, once what will happen has been shown, and the default is no (the end of the input,
 * an Enter, three answers that are not yes or no are all no). Where there is no terminal, a pipe, a
 * script or CI, `--yes` stands for the answer, and nothing is done without it. `--yes` is the only
 * such option: there is no flag that goes on without it, and an agent that runs the command through a
 * shell is stopped by the state gate in core before it gets here.
 */

export type Answer = 'yes' | 'no' | 'nobody';

const PLAIN = styleFor({ color: false, color256: false });

export async function askPerson(
  ctx: HardenContext,
  flags: HardenFlags,
  question: string,
): Promise<Answer> {
  if (flags.yes) return 'yes';
  const terminal = await ctx.askable();
  if (terminal === null) return 'nobody';
  return (await confirm(terminal, PLAIN, question, false)) ? 'yes' : 'no';
}

type Verb = 'apply' | 'undo';

const DECLINED: Readonly<Record<Verb, string>> = {
  apply: 'not applied; nothing was written',
  undo: 'not undone; nothing was changed',
};

const NOBODY: Readonly<Record<Verb, string>> = {
  apply:
    'nothing was written: apply needs a person to answer on a terminal, or --yes where there is none',
  undo: 'nothing was changed: undo needs a person to answer on a terminal, or --yes where there is none',
};

/** What to say when `answer` was not a yes. */
export const notAsked = (answer: Exclude<Answer, 'yes'>, verb: Verb): string =>
  answer === 'no' ? DECLINED[verb] : NOBODY[verb];
