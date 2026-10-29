/**
 * Where each piece the reading took out of a command runs: inside the segment of the line's own it
 * was taken from, at its place in that segment's text. A substitution runs before the command it is
 * in goes on (`x=$(curl -o y.sh …); sh y.sh`), and the commands of a body run in the order of the body
 * (`bash -c 'sed "s|/a|/b|" f; tar xzf t.tgz'`), so a piece is taken where it runs, not where the list
 * of segments puts it, after all of the line's own.
 *
 * Which of the places its text has a piece came from is not known: it may be in the same segment more
 * than once (`sh y.sh; curl -o y.sh …; sh y.sh`), inside a piece around it (`sh y.sh $(curl -o y.sh
 * …)`, which runs before it), or in another segment (`echo "bash y.sh"; …; x=$(bash y.sh)`). So what
 * a piece writes is known from the start of the first of them, and what it runs is judged after the
 * end of the last: as early, and as late, as the piece can run.
 */

/** The most comparisons made to place the pieces of one line; past it, the rest are not placed. */
const MAX_PLACINGS = 20_000;

export interface PlacedPiece {
  readonly index: number;
  /** Its place in the text of the segment it is placed in. */
  readonly at: number;
  /** Whether what it runs is judged there. */
  readonly judged: boolean;
  /** Whether what it writes is known from there on. */
  readonly writes: boolean;
}

export interface RunOrder {
  /** For a segment of the line's own: the pieces placed in it, in the order of its text. */
  readonly within: ReadonlyMap<number, readonly PlacedPiece[]>;
  /** The pieces judged in a segment of the line's own rather than at their own place in the list. */
  readonly placed: ReadonlySet<number>;
}

/** Where a piece is in one segment of the line's own: what it writes from `write`, what it runs at `judge`. */
interface Spot {
  readonly host: number;
  readonly write: number;
  readonly judge: number;
}

/**
 * Where a segment of the line's own that is also a substitution's command runs inside another: the
 * first place in it that a `$(`, a backtick, `<(` or `>(` opens just before, past blanks and `{`
 * (`x=$(   curl …)`), or -1.
 */
function inSubstitution(host: string, text: string): number {
  for (let at = host.indexOf(text); at !== -1; at = host.indexOf(text, at + text.length)) {
    let i = at - 1;
    while (i >= 0 && /[\s{]/.test(host.charAt(i))) i -= 1;
    const opener = host.charAt(i);
    if (opener === '`' || (opener === '(' && /[$<>]/.test(host.charAt(i - 1)))) return at;
  }
  return -1;
}

/**
 * Places the pieces among the first `end` segments in the segments of the line's own. A segment of
 * the line's own is placed too where its text is also in another's substitution
 * (`x=$(curl -o y.sh …); sh y.sh; curl -o y.sh …`), for what it writes only: it is judged where it is.
 */
export function runOrder(
  segments: readonly string[],
  end: number,
  own: (index: number) => boolean,
): RunOrder {
  const owners: number[] = [];
  for (let i = 0; i < end; i += 1) if (own(i)) owners.push(i);
  const within = new Map<number, PlacedPiece[]>();
  const placed = new Set<number>();
  const add = (host: number, piece: PlacedPiece): void => {
    const list = within.get(host) ?? [];
    list.push(piece);
    within.set(host, list);
  };
  let placings = 0;
  for (let k = 0; k < end && placings <= MAX_PLACINGS; k += 1) {
    const text = (segments[k] as string).trim();
    if (text === '') continue;
    const mine = own(k);
    const spots: Spot[] = [];
    for (const j of owners) {
      if (j === k) continue;
      placings += 1;
      if (placings > MAX_PLACINGS) break;
      const host = segments[j] as string;
      if (mine) {
        const at = inSubstitution(host, text);
        if (at !== -1) spots.push({ host: j, write: at, judge: at + text.length });
        continue;
      }
      const at = host.indexOf(text);
      if (at !== -1)
        spots.push({ host: j, write: at, judge: host.lastIndexOf(text) + text.length });
    }
    const first = spots[0];
    const last = spots[spots.length - 1];
    if (first === undefined || last === undefined) continue;
    add(first.host, { index: k, at: first.write, judged: false, writes: true });
    if (!mine) {
      placed.add(k);
      add(last.host, { index: k, at: last.judge, judged: true, writes: false });
    }
  }
  // At one place, what is written there is known before what runs there.
  for (const list of within.values())
    list.sort((a, b) => a.at - b.at || Number(a.judged) - Number(b.judged));
  return { within, placed };
}
