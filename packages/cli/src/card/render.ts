// The card as lines of text: a pure function of the data, so that it is the same in a terminal, in a
// test and beside the owl (which takes a column on the left and asks for lines of at most `WIDTH`).
//
// Plain words only. The card names no rule, shows no score and uses none of the guard's internal terms;
// every word from a transcript was made safe when the moments were built (`text.ts`).
import type { CardData } from './data.js';
import { SHOWN } from './data.js';
import { num, plural, shortPath, wrap } from './text.js';

/**
 * The widest a line of the card is. Beside the owl (2 blanks, 20 columns, 3 blanks) that makes
 * 2 + 20 + 3 + 55 = 80 columns, the width of a default macOS Terminal window.
 */
export const WIDTH = 55;

export const INIT_COMMAND = 'npx @stroq/cli init';
export const ATTACK_COMMAND = 'npx @stroq/cli attack';
export const SHARE_TAIL = 'npx @stroq/cli';

const days = (n: number): string => plural(n, 'day', 'days');

const agentNames = (data: CardData): string => {
  const { claudeCode, codex } = data.coverage.agents;
  if (claudeCode > 0 && codex > 0) return 'Claude Code and Codex';
  return codex > 0 ? 'Codex' : 'Claude Code';
};

/** The lines for a machine with no agent session in the window. */
function nothingToRead(data: CardData, home: string): string[] {
  const [claude, codex] = data.coverage.looked.map((path) => shortPath(path, home, 50));
  return [
    `Hoo found no agent sessions in the last ${days(data.days)}.`,
    ...wrap(
      `Looked for Claude Code in ${claude ?? '~/.claude/projects'} and Codex in ${codex ?? '~/.codex/sessions'}.`,
      WIDTH,
    ),
    '',
    `See what Stroq stops:  ${ATTACK_COMMAND}`,
  ];
}

interface Row {
  readonly count: number;
  readonly text: string;
}

/** The counts: numbers on the right edge of a column, the words beside them, hung under themselves. */
function countRows(rows: readonly Row[]): string[] {
  const width = Math.max(...rows.map((r) => num(r.count).length));
  return rows.flatMap((row) => wrap(row.text, WIDTH, `  ${num(row.count).padStart(width)}  `));
}

function rowsOf(data: CardData): Row[] {
  const c = data.counts;
  const stopped =
    c.keysStopped > 0
      ? ` (${num(c.keysStopped)} more ${c.keysStopped === 1 ? 'was' : 'were'} stopped before ${c.keysStopped === 1 ? 'it' : 'they'} left)`
      : '';
  return [
    {
      count: c.commands,
      text: c.commands === 1 ? 'command your agent ran' : 'commands your agent ran',
    },
    { count: c.toldByText, text: 'came from text it read: a README, page, issue or tool result' },
    {
      count: c.keysSent,
      text: `${c.keysSent === 1 ? 'key' : 'keys'} that left this machine${stopped}`,
    },
    {
      count: c.autorunRepos,
      text:
        c.autorunRepos === 1
          ? 'repo runs code as soon as an agent opens it'
          : 'repos run code as soon as an agent opens them',
    },
  ];
}

/** What the run could not look at, said once each. */
function notes(data: CardData): string[] {
  const k = data.coverage;
  const out: string[] = [];
  if (k.notChecked > 0)
    out.push(
      `Checked ${num(k.checked)} of ${num(k.found)} sessions, newest first; run again to check the rest.`,
    );
  if (k.tooSlow > 0)
    out.push(`${plural(k.tooSlow, 'session', 'sessions')} could not be checked in time.`);
  if (k.placeholders > 0)
    out.push(
      k.placeholders === 1
        ? '1 value in your key files looks like an example or a placeholder, so it is not traced.'
        : `${num(k.placeholders)} values in your key files look like examples or placeholders, so they are not traced.`,
    );
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
  return out.flatMap((note) => wrap(note, WIDTH));
}

function worthALook(data: CardData): string[] {
  const shown = data.moments.slice(0, SHOWN);
  return [
    'Worth a look',
    ...shown.flatMap((m) => [...wrap(m.line, WIDTH, `${m.n}  `), `   stroq show ${m.n}`]),
  ];
}

/** The card as lines, none longer than `WIDTH` columns. */
export function renderCard(data: CardData, home: string): string[] {
  if (data.coverage.found === 0) return nothingToRead(data, home);
  const header = [
    `Hoo checked ${days(data.days)} of your agent sessions`,
    `${plural(data.coverage.found, 'session', 'sessions')} · ${agentNames(data)} · this machine`,
    '',
    ...countRows(rowsOf(data)),
  ];
  const extra = notes(data);
  const found = data.moments.length > 0;
  return [
    ...header,
    ...(extra.length > 0 ? ['', ...extra] : []),
    '',
    ...(found
      ? [...worthALook(data), '', `Stop this next time:  ${INIT_COMMAND}`]
      : [
          ...wrap(
            data.coverage.notChecked > 0
              ? 'Nothing worth a look in the sessions checked so far.'
              : 'Nothing worth a look in these sessions.',
            WIDTH,
          ),
          `See what Stroq stops:  ${ATTACK_COMMAND}`,
        ]),
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
