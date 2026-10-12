// The place where everything the inspectors find is gathered, made safe, put in order and cut.
//
// The inspectors say what they found as they go, in any order, as often as they like. Nothing about
// the order or the number of calls may reach the passport: the same artifact must give the same bytes.
// So findings are joined here (the same thing found in two places is one line with two places), every
// string is made showable, and the result is sorted by a total order that looks only at the content.
import type { Basis, CapKind, PassportLine } from '../types.js';
import {
  ALWAYS_BLIND_SPOTS,
  MAX_LINES,
  MAX_PLACES,
  moreLinesSpot,
  morePlacesSpot,
  tallySpots,
  type TallyKey,
} from './blind-spots.js';
import { showable, showableWhere } from './safe-text.js';

const SUBJECT_MAX = 200;
const DETECTOR_MAX = 300;
const RULE_MAX = 80;

export interface LineInput {
  readonly kind: CapKind;
  readonly subject: string;
  readonly basis: Basis;
  readonly sensitive: boolean;
  /** A path of the tree. */
  readonly file: string;
  readonly line: number | null;
  /** Which reading found it, and what it is worth, in words. */
  readonly detector: string;
}

export interface SignalInput {
  readonly ruleId: string;
  readonly file: string;
  readonly line: number | null;
  readonly sensitive: boolean;
  /** What the rule matched on, when that helps a person find it. */
  readonly detail?: string;
  /** What the signal rests on; a reading found it unless the artifact says so about itself. */
  readonly basis?: Basis;
  readonly detector: string;
}

export interface FindingsResult {
  readonly lines: readonly PassportLine[];
  readonly signals: readonly { readonly ruleId: string; readonly file: string }[];
  readonly blindSpots: readonly string[];
}

type Place = { readonly file: string; readonly line: number | null };

interface Draft {
  readonly kind: CapKind;
  readonly subject: string;
  readonly basis: Basis;
  readonly sensitive: boolean;
  readonly detector: string;
  readonly places: Map<string, Place>;
}

/** Text compared by its UTF-16 units: the same answer on every machine, which `localeCompare` is not. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareLine = (a: number | null, b: number | null): number => (a ?? 0) - (b ?? 0);
const comparePlace = (a: Place, b: Place): number =>
  compareText(a.file, b.file) || compareLine(a.line, b.line);

const nonEmptyText = (text: string, max: number, fallback: string): string => {
  const shown = showable(text, max);
  return shown === '' ? fallback : shown;
};

const firstPlace = (line: PassportLine): Place => line.where[0] ?? { file: '', line: null };

/** A total order over lines that looks at nothing but what they say. */
function compareLines(a: PassportLine, b: PassportLine): number {
  const pa = firstPlace(a);
  const pb = firstPlace(b);
  return (
    compareText(a.kind, b.kind) ||
    compareText(a.subject, b.subject) ||
    compareText(pa.file, pb.file) ||
    compareLine(pa.line, pb.line) ||
    compareText(a.basis, b.basis) ||
    compareText(a.detector, b.detector) ||
    Number(a.sensitive) - Number(b.sensitive)
  );
}

/** Which lines survive when there are too many: the sensitive ones first, then by the total order. */
const compareForKeeping = (a: PassportLine, b: PassportLine): number =>
  Number(b.sensitive) - Number(a.sensitive) || compareLines(a, b);

export class Findings {
  private readonly drafts = new Map<string, Draft>();
  private readonly signalEntries = new Map<string, { ruleId: string; file: string }>();
  private readonly spots = new Set<string>();
  private readonly counts: Partial<Record<TallyKey, number>> = {};

  /** Records one finding in one place. The same finding in another place is added to the same line. */
  line(input: LineInput): void {
    const subject = nonEmptyText(input.subject, SUBJECT_MAX, '(no text)');
    const detector = nonEmptyText(input.detector, DETECTOR_MAX, '(no reading named)');
    const place = showableWhere(input.file, input.line);
    const key = [input.kind, subject, input.basis, input.sensitive ? 1 : 0, detector].join(
      '\u0000',
    );
    const draft = this.drafts.get(key) ?? {
      kind: input.kind,
      subject,
      basis: input.basis,
      sensitive: input.sensitive,
      detector,
      places: new Map<string, Place>(),
    };
    draft.places.set(`${place.file}\u0000${place.line ?? 0}`, place);
    this.drafts.set(key, draft);
  }

  /**
   * Records a rule that matched. It is two things in a passport: a `signal` line, which says what
   * matched and where, and an entry in `signals`, which is what is counted and listed by file.
   */
  signal(input: SignalInput): void {
    const ruleId = nonEmptyText(input.ruleId, RULE_MAX, '(no rule)');
    const place = showableWhere(input.file, input.line);
    this.signalEntries.set(`${ruleId}\u0000${place.file}`, { ruleId, file: place.file });
    const detail = input.detail === undefined ? '' : showable(input.detail, SUBJECT_MAX);
    this.line({
      kind: 'signal',
      subject: detail === '' ? ruleId : `${ruleId}: ${detail}`,
      basis: input.basis ?? 'observed',
      sensitive: input.sensitive,
      file: input.file,
      line: input.line,
      detector: input.detector,
    });
  }

  blindSpot(text: string): void {
    const shown = showable(text, DETECTOR_MAX);
    if (shown !== '') this.spots.add(shown);
  }

  /** Counts one more of something the reading could not do; the words are made at the end. */
  tally(key: TallyKey, by = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + by;
  }

  /** The findings as a passport holds them: in order, joined, cut, and safe to print. */
  result(): FindingsResult {
    let placesCut = false;
    const all: PassportLine[] = [...this.drafts.values()].map((draft) => {
      const places = [...draft.places.values()].sort(comparePlace);
      if (places.length > MAX_PLACES) placesCut = true;
      return Object.freeze({
        kind: draft.kind,
        subject: draft.subject,
        basis: draft.basis,
        sensitive: draft.sensitive,
        where: Object.freeze(places.slice(0, MAX_PLACES).map((place) => Object.freeze(place))),
        detector: draft.detector,
      });
    });
    const kept =
      all.length > MAX_LINES ? [...all].sort(compareForKeeping).slice(0, MAX_LINES) : all;
    const lines = [...kept].sort(compareLines);

    const spots = new Set<string>([
      ...ALWAYS_BLIND_SPOTS,
      ...this.spots,
      ...tallySpots(this.counts),
    ]);
    if (all.length > kept.length) spots.add(moreLinesSpot(all.length - kept.length));
    if (placesCut) spots.add(morePlacesSpot);

    const signals = [...this.signalEntries.values()]
      .sort((a, b) => compareText(a.ruleId, b.ruleId) || compareText(a.file, b.file))
      .map((entry) => Object.freeze({ ...entry }));
    return Object.freeze({
      lines: Object.freeze(lines),
      signals: Object.freeze(signals),
      blindSpots: Object.freeze([...spots].sort(compareText)),
    });
  }
}
