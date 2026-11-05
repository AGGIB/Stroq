// `stroq show N`: the evidence behind moment N of the last `stroq card`.
import { noSuchMoment, nothingToShow, renderShow } from '../card/show.js';
import { readLastCard } from '../card/store.js';
import { stroqHome } from '../paths.js';

export function runShow(args: readonly string[]): number {
  const [raw, ...rest] = args;
  if (raw === undefined || rest.length > 0 || !/^\d{1,2}$/.test(raw) || Number(raw) < 1) {
    process.stderr.write('stroq show takes the number of a moment on the card: stroq show 1\n');
    return 2;
  }
  const n = Number(raw);
  const last = readLastCard(stroqHome());
  if (last.kind !== 'card') {
    process.stdout.write(`${nothingToShow(last)}\n`);
    return 1;
  }
  const moment = last.card.moments.find((m) => m.n === n);
  if (moment === undefined) {
    process.stdout.write(`${noSuchMoment(last.card, n)}\n`);
    return 1;
  }
  process.stdout.write(`${renderShow(last.card, moment).join('\n')}\n`);
  return 0;
}
