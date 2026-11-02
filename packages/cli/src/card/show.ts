// `stroq show N`: the evidence behind one moment of the last card, as lines of text.
//
// Read from the card's own file under the Stroq home, which `card/store.ts` reads strictly. Everything
// in it is passed through `clean` once more here: the file is data that could have been put there by
// someone else, and what is printed must never drive the terminal.
import type { LastCard, Moment } from './schema.js';
import { clean, wrap } from './text.js';

const WIDTH = 78;
const MAX_LABEL = 18;

/** Why there is no moment to show, as a sentence for the person. */
export function nothingToShow(
  read: { readonly kind: 'none' } | { readonly kind: 'unreadable'; readonly why: string },
): string {
  return read.kind === 'none'
    ? 'There is no card yet. Run  npx @stroq/cli  first, then  stroq show 1.'
    : `The saved card could not be read (${clean(read.why, 80)}). Run  npx @stroq/cli  again.`;
}

export function noSuchMoment(card: LastCard, n: number): string {
  return card.moments.length === 0
    ? 'The last card found nothing to show.'
    : `The last card has ${card.moments.length} ${card.moments.length === 1 ? 'moment' : 'moments'}, so there is no ${n}. Try  stroq show 1.`;
}

function rows(group: Moment['groups'][number]): string[] {
  const labels = group.rows.map(([label]) => clean(label, MAX_LABEL));
  const width = Math.min(MAX_LABEL, Math.max(0, ...labels.map((l) => l.length)));
  return group.rows.flatMap(([label, value], i) => {
    const head = `  ${(labels[i] ?? '').padEnd(width)}${width > 0 ? '  ' : ''}`;
    return wrap(clean(value, 700), WIDTH, head);
  });
}

/** The lines of `stroq show N`. */
export function renderShow(card: LastCard, moment: Moment): string[] {
  const when = card.generated.slice(0, 16).replace('T', ' ');
  return [
    `Moment ${moment.n} of the last card (${clean(when, 20)} UTC, ${card.days} ${card.days === 1 ? 'day' : 'days'})`,
    '',
    ...wrap(clean(moment.line, 600), WIDTH),
    ...moment.groups.flatMap((group) => ['', clean(group.title, 60), ...rows(group)]),
    ...(moment.next.length === 0
      ? []
      : ['', 'Dig deeper', ...moment.next.map((command) => `  ${clean(command, 600)}`)]),
  ];
}
