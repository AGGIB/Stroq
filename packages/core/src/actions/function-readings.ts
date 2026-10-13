import {
  inheritedFunctions,
  withInlinedFunctions,
  type FunctionDefinition,
} from './inlined-functions.js';
import { checkDeadline } from './deadline.js';
import { newFormBudget, type FormBudget } from './parameter-forms.js';
import { readingCost } from './reading-cost.js';
import type { Lexed } from './shell-lex.js';

/**
 * What the reading of functions may spend on one command, however many programs it hands to shells and
 * texts it nests: each text that is added is read by every detector as the command is, so a command of a
 * hundred characters must not come to hundreds of texts (a fuzzer built one of 151 characters that came
 * to 434 and took 31 seconds), and a command of eighty kilobytes must not come to a megabyte and a half
 * (a reviewer built one that took twelve seconds, where the host gives up at fifteen and allows). Shared
 * by everything that is read for the functions of one command: the command, the programs it hands to
 * shells, the text with the line breaks of its strings folded, and what it sends over `ssh`.
 */
export interface FunctionRoom {
  /** What the texts that are added may still come to, in characters. */
  chars: number;
  /** What reading them may still cost, as `readingCost` estimates it: a text of dense separators costs ten times a text of words. */
  cost: number;
  /** How many texts may still be read for the functions they call, and how many added. */
  read: number;
  added: number;
  /** What the forms of the parameters (`${1%.*}`) may still spend, in all the calls of the command. */
  forms: FormBudget;
}

const MAX_FUNCTION_TEXTS = 32;
const MAX_FOUND_TEXTS = 48;
/** The characters that the texts that are added may come to in all: this much, and so much for each character of the command. */
const ROOM_FLOOR = 262_144;
const ROOM_PER_CHARACTER = 48;
/** ...and never more than this, whatever the command: a command of that size is the one that is slow to read. */
const ROOM_CEILING = 1 << 20;
/**
 * What the reading of the functions of a command may cost in all, estimated as the hook estimates the
 * command (`readingCost`): the command itself is let cost five seconds, and what is added to it a third
 * of that. A real function costs a few milliseconds of it.
 */
const ROOM_COST_US = 1_500_000;

export const newFunctionRoom = (commandLength: number): FunctionRoom => ({
  chars: Math.min(ROOM_CEILING, ROOM_FLOOR + ROOM_PER_CHARACTER * commandLength),
  cost: ROOM_COST_US,
  read: MAX_FUNCTION_TEXTS,
  added: MAX_FOUND_TEXTS,
  forms: newFormBudget(),
});

export interface FunctionReadingTools {
  readonly lexed: (text: string) => Lexed;
  /** What a text holds that runs as a command of its own: substitutions, `eval` arguments, `-c` strings. */
  readonly nested: (text: string) => string[];
  /** The text with the variables it sets put where they are used. */
  readonly withVariables: (text: string) => string[];
}

/**
 * The calls of the functions that a command defines, in every text that was read from it. A function is
 * in force in the substitutions, `eval` arguments, `trap` bodies and `-c` strings of the command that
 * defines it (and in a shell it was exported to), so each text is read with the definitions of all of
 * them: `f() { rm "$@"; }; echo $(f -rf ~)` is a destructive command, and the text `f -rf ~` that the
 * substitution holds is not, until it is given `f`. What is found is new texts, to be read as the rest.
 *
 * `given` are the functions of the command that this text was read from, where it is a program that a
 * shell was handed (`export -f f; bash <<EOF`), and `room` is what is left to spend on the command in all. `unread` says that a call is left that is not read (see
 * `withInlinedFunctions`), or that there are more texts and functions than are read, so that the
 * command is asked about and not allowed.
 */
export function readFunctionCalls(
  texts: readonly string[],
  limit: number,
  tools: FunctionReadingTools,
  given: readonly FunctionDefinition[],
  room: FunctionRoom,
  /** The texts among `texts` that are another with some variables put in (see `inheritedFunctions`). */
  copies: ReadonlySet<string> = new Set(),
): {
  readonly found: string[];
  readonly unread: boolean;
  /** The functions in force: those the texts define and `given`. */
  readonly definitions: readonly FunctionDefinition[];
} {
  const functions = inheritedFunctions(texts, given, copies);
  if (functions.definitions.length === 0)
    return { found: [], unread: functions.crowded, definitions: [] };
  const known = new Set(texts);
  const found: string[] = [];
  const queue = [...texts];
  let unread = functions.crowded;
  for (let i = 0; i < queue.length; i += 1) {
    checkDeadline();
    const text = queue[i] as string;
    // Every text is read for calls, whatever it holds of a name: a name may be spelled with quotes or
    // escapes, which a search for it does not find. A text that has no call costs a pass over it. Where
    // the room is spent, a call is not put in place, and the text that has one is asked about.
    const allowed =
      room.read > 0 && room.chars > 0 && room.cost > 0 ? Math.min(limit, room.chars) : 0;
    const out = withInlinedFunctions(
      text,
      tools.lexed(text),
      tools.lexed,
      allowed,
      functions.definitions,
      room.cost,
      room.forms,
    );
    if (out.readings.length > 0) room.read -= 1;
    unread ||= out.unread;
    for (const reading of out.readings) {
      // The reading has had its own calls put in place; what it holds in substitutions and in the
      // variables it sets is read in turn.
      const more = [...tools.withVariables(reading), ...tools.nested(reading)];
      for (const next of [reading, ...more]) {
        if (known.has(next)) continue;
        known.add(next);
        // What does not fit is not added, and is a question: it may hold a call.
        const cost = room.added > 0 && next.length <= room.chars ? readingCost(next) : Infinity;
        if (cost > room.cost) {
          unread = true;
          continue;
        }
        room.chars -= next.length;
        room.cost -= cost;
        room.added -= 1;
        found.push(next);
        if (next !== reading) queue.push(next);
      }
    }
  }
  return { found, unread, definitions: functions.definitions };
}
