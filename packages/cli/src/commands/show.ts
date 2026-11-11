// `stroq show N`: the evidence behind moment N of the last `stroq card`.
//
// `--false-alarm <id>` marks the moment whose id `stroq show N` printed, so that the card stops listing
// it; `--false-alarms` lists the marks and `--false-alarms --clear` takes them back. A mark goes by the
// id and not the number: the card can be made again between reading a moment and marking it, and then
// the same number is another moment. The two that write need a terminal of the person's own and are
// refused through an agent's shell as well (`stroq-commands.ts` in core): a mark hides a moment, and
// hiding is the person's call.
import {
  ID_LENGTH,
  MAX_MARKS,
  clearFalseAlarms,
  markFalseAlarm,
  readFalseAlarms,
  type FalseAlarm,
  type MarkResult,
} from '../card/false-alarms.js';
import type { Moment } from '../card/schema.js';
import { noSuchMoment, nothingToShow, renderShow } from '../card/show.js';
import { readLastCard } from '../card/store.js';
import { clean, wrap } from '../card/text.js';
import { stroqHome } from '../paths.js';

const USAGE = [
  'stroq show takes the number of a moment on the card: stroq show 1',
  '  stroq show --false-alarm <id>       mark it as a false alarm (stroq show <n> prints its id)',
  '  stroq show --false-alarms           list the marks',
  '  stroq show --false-alarms --clear   take every mark back',
].join('\n');

/** Where a person tells us about a false alarm, so that the rule can be fixed for everyone. */
export const FALSE_ALARM_ISSUE = 'https://github.com/AGGIB/Stroq/issues/290';
const CLEAR = 'stroq show --false-alarms --clear';
const WIDTH = 78;
const ID = new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`);

type Parsed =
  | { readonly kind: 'show'; readonly n: number }
  | { readonly kind: 'mark'; readonly id: string }
  | { readonly kind: 'list' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'usage' };

function parse(args: readonly string[]): Parsed {
  const [first, second, ...rest] = args;
  if (rest.length > 0) return { kind: 'usage' };
  if (first === '--false-alarms' && second === undefined) return { kind: 'list' };
  if (first === '--false-alarms' && second === '--clear') return { kind: 'clear' };
  if (first === '--false-alarm' && second !== undefined && ID.test(second))
    return { kind: 'mark', id: second };
  if (first !== undefined && second === undefined && /^\d{1,2}$/.test(first) && Number(first) >= 1)
    return { kind: 'show', n: Number(first) };
  return { kind: 'usage' };
}

/** Whether a person is at this terminal: an agent's shell, a script and a pipe have no terminal. */
const atTerminal = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;

const NOT_AT_TERMINAL =
  'Marks are made in a terminal of your own, not through an agent, a script or a pipe. Run it there.';

export function runShow(
  args: readonly string[],
  now: Date = new Date(),
  terminal: boolean = atTerminal(),
): number {
  const parsed = parse(args);
  if (parsed.kind === 'usage') {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const home = stroqHome();
  if (parsed.kind === 'list') return listMarks(home);
  if ((parsed.kind === 'mark' || parsed.kind === 'clear') && !terminal) {
    process.stderr.write(`${NOT_AT_TERMINAL}\n`);
    return 1;
  }
  if (parsed.kind === 'clear') return clearMarks(home);
  const last = readLastCard(home);
  if (last.kind !== 'card') {
    process.stdout.write(`${nothingToShow(last)}\n`);
    return 1;
  }
  if (parsed.kind === 'mark') return markById(home, last.card.moments, parsed.id, now);
  const moment = last.card.moments.find((m) => m.n === parsed.n);
  if (moment === undefined) {
    process.stdout.write(`${noSuchMoment(last.card, parsed.n)}\n`);
    return 1;
  }
  process.stdout.write(`${renderShow(last.card, moment).join('\n')}\n`);
  return 0;
}

/** A sentence wrapped to the width; a line indented by two spaces is a command or a link, kept whole. */
const fit = (line: string): string[] => (line.startsWith('  ') ? [line] : wrap(line, WIDTH));
const say = (lines: readonly string[]): void => {
  process.stdout.write(`${lines.flatMap(fit).join('\n')}\n`);
};

function markLines(result: MarkResult, moment: Moment): readonly string[] {
  const what = wrap(clean(moment.line, 600), WIDTH, '  ');
  switch (result.kind) {
    case 'marked':
      return [
        'Marked as a false alarm:',
        ...what,
        '',
        'The card stops listing it for as long as what it shows stays the same; its counts do not change.',
        `Take it back: ${CLEAR}`,
        '',
        'Tell us, so that the rule can be fixed for everyone: what the moment said and what really happened, with made-up names and no key.',
        `  ${FALSE_ALARM_ISSUE}`,
      ];
    case 'already':
      return ['Already marked as a false alarm:', ...what];
    case 'full':
      return [
        `You have marked ${MAX_MARKS} moments, the most Stroq keeps. Take them back first: ${CLEAR}`,
      ];
    case 'no-key':
      return [
        'The last card was made by an older version of Stroq, so its moments cannot be marked.',
        'Run  npx @stroq/cli  again, then  stroq show <n>  for the moment.',
      ];
    case 'unreadable':
      return [
        `Your false alarm marks could not be read (${clean(result.why, 80)}), so nothing was marked.`,
        result.newer ? 'Mark it with that version.' : `Start them again: ${CLEAR}`,
      ];
  }
}

function markById(home: string, moments: readonly Moment[], id: string, now: Date): number {
  const found = moments.filter((m) => m.key?.startsWith(id) === true);
  const [moment] = found;
  if (moment === undefined || found.length > 1) {
    say([
      `No moment of the last card has the id ${id}. The card may have been made again since you read it: run  stroq show <n>  again and use the id it prints.`,
    ]);
    return 1;
  }
  let result: MarkResult;
  try {
    result = markFalseAlarm(home, moment, now);
  } catch (err) {
    process.stderr.write(`The mark could not be saved: ${clean((err as Error).message, 200)}\n`);
    return 1;
  }
  say(markLines(result, moment));
  return result.kind === 'marked' || result.kind === 'already' ? 0 : 1;
}

const markLine = (mark: FalseAlarm): string[] =>
  wrap(clean(mark.line, 600), WIDTH, `  ${clean(mark.marked, 40).slice(0, 10)}  `);

function listMarks(home: string): number {
  const read = readFalseAlarms(home);
  if (read.kind === 'unreadable') {
    say([
      `Your false alarm marks could not be read (${clean(read.why, 80)}), so the card lists every moment.`,
      ...(read.newer ? [] : [`Start them again: ${CLEAR}`]),
    ]);
    return 1;
  }
  if (read.marks.length === 0) {
    say([
      'No moment is marked as a false alarm. To mark one, run  stroq show <n>  and use the line at its end.',
    ]);
    return 0;
  }
  const count = read.marks.length;
  const head =
    count === 1
      ? '1 moment is marked as a false alarm. The card does not list it; its counts still hold it.'
      : `${count} moments are marked as false alarms. The card does not list them; its counts still hold them.`;
  process.stdout.write(
    [
      ...wrap(head, WIDTH),
      '',
      ...read.marks.flatMap(markLine),
      '',
      `Take ${count === 1 ? 'it' : 'them all'} back: ${CLEAR}`,
    ].join('\n') + '\n',
  );
  return 0;
}

function clearMarks(home: string): number {
  let result;
  try {
    result = clearFalseAlarms(home);
  } catch (err) {
    process.stderr.write(`The marks could not be cleared: ${clean((err as Error).message, 200)}\n`);
    return 1;
  }
  if (result.kind === 'newer') {
    say([
      'Your false alarm marks were saved by a newer version of Stroq, so this one leaves them as they are. Clear them with that version.',
    ]);
    return 1;
  }
  const count = result.count;
  say([
    count === 0
      ? 'There was no mark to take back.'
      : `Took back ${count === 1 ? '1 mark' : `${count} marks`}. The next card lists ${count === 1 ? 'that moment' : 'those moments'} again.`,
  ]);
  return 0;
}
