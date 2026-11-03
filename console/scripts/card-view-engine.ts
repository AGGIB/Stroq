import { cardDataSchema } from '../../packages/cli/src/card/data-schema.js';
import { SHOWN } from '../../packages/cli/src/card/data.js';
import { owlFrame } from '../../packages/cli/src/card/owl-frame.js';
import { cardView, type CardView } from '../../packages/cli/src/card/render.js';
import type { Moment } from '../../packages/cli/src/card/schema.js';
import { clean } from '../../packages/cli/src/card/text.js';
import type { FrameName } from '../../packages/cli/src/ui/mascot/sprites.js';

/**
 * What the Check screen shows of one run of the card: the card's own sentences and numbers
 * (`cardView`, the code the terminal prints from), the moments with the evidence `stroq show N`
 * prints, and which owl says the result. Built from `stroq card --json` by the code of the CLI, so
 * the console words nothing itself.
 */
export interface CardPresentation {
  readonly schema: 'stroq-card-view/1';
  readonly version: string;
  readonly generated: string;
  readonly days: number;
  readonly owl: FrameName;
  readonly view: CardView;
  readonly moments: readonly Moment[];
  /** How many of the moments the terminal's card shows. */
  readonly shown: number;
}

/** A moment as `stroq show` prints it: every word made safe once more, since the file is data. */
function safeMoment(moment: Moment): Moment {
  return {
    ...moment,
    line: clean(moment.line, 600),
    groups: moment.groups.map((group) => ({
      title: clean(group.title, 60),
      rows: group.rows.map(([label, value]): [string, string] => [
        clean(label, 60),
        clean(value, 700),
      ]),
    })),
    next: moment.next.map((command) => clean(command, 600)),
  };
}

/** The presentation of `stroq card --json`'s output, or null when it is not a card this version wrote. */
export function presentCard(raw: unknown, home: string): CardPresentation | null {
  const parsed = cardDataSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    schema: 'stroq-card-view/1',
    version: data.version,
    generated: data.generated,
    days: data.days,
    owl: owlFrame(data),
    view: cardView(data, home),
    moments: data.moments.map(safeMoment),
    shown: SHOWN,
  };
}
