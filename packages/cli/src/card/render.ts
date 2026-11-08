// The card as lines of text: a pure function of the data, so that it is the same in a terminal, in a
// test and beside the owl (which takes a column on the left and asks for lines of at most `WIDTH`).
//
// Plain words only. The card names no rule, shows no score and uses none of the guard's internal terms;
// every word from a transcript was made safe when the moments were built (`text.ts`).
import { notTracedNote } from '../sent/key-quality.js';
import type { CardData } from './data.js';
import { SHOWN } from './data.js';
import { clean, num, plural, shortPath, wrap } from './text.js';

/**
 * The widest a line of the card is. Beside the owl (2 blanks, 20 columns, 3 blanks) that makes
 * 2 + 20 + 3 + 55 = 80 columns, the width of a default macOS Terminal window.
 */
export const WIDTH = 55;

export const INIT_COMMAND = 'npx @stroq/cli init';
export const ATTACK_COMMAND = 'npx @stroq/cli attack';
export const SHARE_TAIL = 'npx @stroq/cli';

const days = (n: number): string => plural(n, 'day', 'days');

function listed(items: readonly string[]): string {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

const agentNames = (data: CardData): string => {
  const { claudeCode, codex, cursor = 0 } = data.coverage.agents;
  return listed([
    ...(claudeCode > 0 ? ['Claude Code'] : []),
    ...(codex > 0 ? ['Codex'] : []),
    ...(cursor > 0 ? ['Cursor'] : []),
  ]);
};

/** The sentences for a machine with no agent session in the window. */
function nothingToReadView(data: CardData, home: string): CardView {
  const [claude, codex, cursor] = data.coverage.looked.map((path) => shortPath(path, home, 50));
  const places = [
    `Claude Code in ${claude ?? '~/.claude/projects'}`,
    `Codex in ${codex ?? '~/.codex/sessions'}`,
  ];
  if (cursor !== undefined) places.push(`Cursor in ${cursor}`);
  const note = data.coverage.cursorNote;
  return {
    kind: 'nothing-to-read',
    title: `Hoo found no agent sessions in the last ${days(data.days)}.`,
    looked: `Looked for ${listed(places)}.${note === undefined ? '' : ` ${note}`}`,
    next: { label: 'See what Stroq stops:', command: ATTACK_COMMAND },
  };
}

/** The count rows: which count each is, the number, and the words beside it. */
export interface CountRow {
  readonly id: 'commands' | 'told' | 'keys' | 'autorun';
  readonly count: number;
  readonly text: string;
}

function rowsOf(data: CardData): CountRow[] {
  const c = data.counts;
  const stopped =
    c.keysStopped > 0
      ? ` (${num(c.keysStopped)} more ${c.keysStopped === 1 ? 'was' : 'were'} stopped before ${c.keysStopped === 1 ? 'it' : 'they'} left)`
      : '';
  return [
    {
      id: 'commands',
      count: c.commands,
      text: c.commands === 1 ? 'command your agent ran' : 'commands your agent ran',
    },
    {
      id: 'told',
      count: c.toldByText,
      text: 'came from text it read: a README, page, issue or tool result',
    },
    {
      id: 'keys',
      count: c.keysSent,
      text: `${c.keysSent === 1 ? 'key' : 'keys'} that left this machine${stopped}`,
    },
    {
      id: 'autorun',
      count: c.autorunRepos,
      text:
        c.autorunRepos === 1
          ? 'repo runs code as soon as an agent opens it'
          : 'repos run code as soon as an agent opens them',
    },
  ];
}

/** The counts: numbers on the right edge of a column, the words beside them, hung under themselves. */
function countRows(rows: readonly CountRow[]): string[] {
  const width = Math.max(...rows.map((r) => num(r.count).length));
  return rows.flatMap((row) => wrap(row.text, WIDTH, `  ${num(row.count).padStart(width)}  `));
}

/** What the run could not look at, said once each. */
function notes(data: CardData): string[] {
  const k = data.coverage;
  const out: string[] = [];
  if (k.cursorNote !== undefined) out.push(k.cursorNote);
  if (k.notChecked > 0)
    out.push(
      `Checked ${num(k.checked)} of ${num(k.found)} sessions, newest first; run again to check the rest.`,
    );
  if (k.tooSlow > 0)
    out.push(`${plural(k.tooSlow, 'session', 'sessions')} could not be checked in time.`);
  if (k.placeholders > 0)
    out.push(`${notTracedNote(k.placeholders, k.placeholderNames, (name) => clean(name, 40))}.`);
  if (k.tooLarge > 0)
    out.push(`${plural(k.tooLarge, 'session was', 'sessions were')} too large to check.`);
  if (k.unreadable > 0)
    out.push(`${plural(k.unreadable, 'session', 'sessions')} could not be read.`);
  if (k.keys === 'not-finished')
    out.push(
      `Keys checked in ${num(k.keysChecked)} of ${num(k.found)} sessions; run again to check the rest.`,
    );
  if (k.keysIncomplete > 0)
    out.push(
      `${plural(k.keysIncomplete, 'session', 'sessions')} could not be checked for keys in full.`,
    );
  if (k.folders.checked < k.folders.found)
    out.push(
      `Looked at ${num(k.folders.checked)} of ${num(k.folders.found)} folders for code that runs on open.`,
    );
  return out;
}

/** What the card says, as sentences and numbers, before any of it is laid out in columns. */
export type CardView =
  | {
      readonly kind: 'nothing-to-read';
      readonly title: string;
      readonly looked: string;
      readonly next: NextStep;
    }
  | {
      readonly kind: 'card';
      readonly title: string;
      readonly subtitle: string;
      readonly rows: readonly CountRow[];
      readonly notes: readonly string[];
      /** The sentence when no moment is worth a look; null when there are moments. */
      readonly nothing: string | null;
      /** The moments the card shows (`SHOWN` of them), numbered as `stroq show` numbers them. */
      readonly moments: readonly { readonly n: number; readonly line: string }[];
      readonly next: NextStep;
    };

export interface NextStep {
  readonly label: string;
  readonly command: string;
}

/**
 * The card as sentences and numbers: the one source of the words, read by the terminal's lines
 * (`renderCard`) and by the console, so that the two say the same things.
 */
export function cardView(data: CardData, home: string): CardView {
  if (data.coverage.found === 0) return nothingToReadView(data, home);
  const found = data.moments.length > 0;
  return {
    kind: 'card',
    title: `Hoo checked ${days(data.days)} of your agent sessions`,
    subtitle: `${plural(data.coverage.found, 'session', 'sessions')} · ${agentNames(data)} · this machine`,
    rows: rowsOf(data),
    notes: notes(data),
    nothing: found
      ? null
      : data.coverage.notChecked > 0
        ? 'Nothing worth a look in the sessions checked so far.'
        : 'Nothing worth a look in these sessions.',
    moments: data.moments.slice(0, SHOWN).map((m) => ({ n: m.n, line: m.line })),
    next: found
      ? { label: 'Stop this next time:', command: INIT_COMMAND }
      : { label: 'See what Stroq stops:', command: ATTACK_COMMAND },
  };
}

const nextLine = (next: NextStep): string => `${next.label}  ${next.command}`;

/** The card as lines, none longer than `WIDTH` columns. */
export function renderCard(data: CardData, home: string): string[] {
  const view = cardView(data, home);
  if (view.kind === 'nothing-to-read')
    return [view.title, ...wrap(view.looked, WIDTH), '', nextLine(view.next)];
  const extra = view.notes.flatMap((note) => wrap(note, WIDTH));
  return [
    view.title,
    ...wrap(view.subtitle, WIDTH),
    '',
    ...countRows(view.rows),
    ...(extra.length > 0 ? ['', ...extra] : []),
    '',
    ...(view.nothing === null
      ? [
          'Worth a look',
          ...view.moments.flatMap((m) => [
            ...wrap(m.line, WIDTH, `${m.n}  `),
            `   stroq show ${m.n}`,
          ]),
          '',
          nextLine(view.next),
        ]
      : [...wrap(view.nothing, WIDTH), nextLine(view.next)]),
  ];
}

/** One line to post: counts only, no path, name or host. */
export function shareLine(data: CardData): string {
  const c = data.counts;
  return (
    `Hoo checked ${days(data.days)} of my agent sessions: ` +
    `${plural(c.commands, 'command', 'commands')}, ${num(c.toldByText)} came from text the agent read, ` +
    `${plural(c.keysSent, 'key', 'keys')} left this machine, ` +
    `${plural(c.autorunRepos, 'repo runs', 'repos run')} code as soon as an agent opens ${c.autorunRepos === 1 ? 'it' : 'them'}. ` +
    SHARE_TAIL
  );
}
