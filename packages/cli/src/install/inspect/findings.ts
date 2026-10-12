// The place where everything the inspectors find is gathered, made safe, put in order and cut.
//
// The inspectors say what they found as they go, in any order, as often as they like. Nothing about
// the order or the number of calls may reach the passport: the same artifact must give the same bytes.
// So findings are joined here (the same thing found in two places is one line with two places), every
// string is made showable, and the result is sorted by a total order that looks only at the content.
import type { Basis, CapKind, PassportLine } from '../types.js';
import {
  ALWAYS_BLIND_SPOTS,
  failedReadingSpot,
  MAX_LINES,
  MAX_PLACES,
  moreLinesSpot,
  morePlacesSpot,
  tallySpots,
  type ReadingName,
  type TallyKey,
} from './blind-spots.js';
import { showable, showableWhere } from './safe-text.js';

const SUBJECT_MAX = 200;
/** Several readings may find the same thing, and all of them are named, so a detector may be long. */
const DETECTOR_MAX = 600;
const SINGLE_DETECTOR_MAX = 300;
const RULE_MAX = 80;
/** How the detectors of the readings that look at text end; said once when several of them are joined. */
const VERDICT_NOTE = '; a signal to look at, not a verdict';
/** The most distinct findings kept before the passport is cut to its lines; the rest are counted. */
const MAX_DRAFTS = 20_000;
/** The most strings whose safe form is remembered: the same few subjects and detectors come back thousands of times. */
const MAX_REMEMBERED = 5000;

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
  readonly detectors: Set<string>;
  readonly places: Map<string, Place>;
}

/** The detectors of several readings as one text: in order, each once, and the note that none is a verdict once at the end. */
function joinDetectors(detectors: ReadonlySet<string>): string {
  const sorted = [...detectors].sort(compareText);
  const noted = sorted.filter((text) => text.endsWith(VERDICT_NOTE));
  const stems = sorted.map((text) =>
    text.endsWith(VERDICT_NOTE) ? text.slice(0, -VERDICT_NOTE.length) : text,
  );
  return `${stems.join('; ')}${noted.length > 0 ? VERDICT_NOTE : ''}`;
}

/** Text compared by its UTF-16 units: the same answer on every machine, which `localeCompare` is not. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareLine = (a: number | null, b: number | null): number => (a ?? 0) - (b ?? 0);
const comparePlace = (a: Place, b: Place): number =>
  compareText(a.file, b.file) || compareLine(a.line, b.line);

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
  private readonly remembered = new Map<string, string>();
  /** Findings that were not kept because there were too many different ones. */
  private dropped = 0;
  private readonly signalEntries = new Map<string, { ruleId: string; file: string }>();
  private readonly spots = new Set<string>();
  private readonly failed = new Set<ReadingName>();
  private readonly counts: Partial<Record<TallyKey, number>> = {};

  /** The safe form of a text, made once for the texts that come back often. */
  private safe(text: string, max: number, fallback: string): string {
    const memo = `${max}\u0000${text}`;
    const known = this.remembered.get(memo);
    if (known !== undefined) return known;
    const shown = showable(text, max);
    const result = shown === '' ? fallback : shown;
    if (this.remembered.size < MAX_REMEMBERED && text.length <= 1000)
      this.remembered.set(memo, result);
    return result;
  }

  /**
   * Records one finding in one place. The same finding in another place is added to the same line, and
   * the same finding made by another reading keeps the line and adds the reading to its detector.
   */
  line(input: LineInput): void {
    const subject = this.safe(input.subject, SUBJECT_MAX, '(no text)');
    const detector = this.safe(input.detector, SINGLE_DETECTOR_MAX, '(no reading named)');
    const place = showableWhere(input.file, input.line);
    const key = [input.kind, subject, input.basis, input.sensitive ? 1 : 0].join('\u0000');
    let draft = this.drafts.get(key);
    if (draft === undefined) {
      if (this.drafts.size >= MAX_DRAFTS) {
        this.dropped += 1;
        return;
      }
      draft = {
        kind: input.kind,
        subject,
        basis: input.basis,
        sensitive: input.sensitive,
        detectors: new Set<string>(),
        places: new Map<string, Place>(),
      };
      this.drafts.set(key, draft);
    }
    draft.detectors.add(detector);
    draft.places.set(`${place.file}\u0000${place.line ?? 0}`, place);
  }

  /**
   * Records a rule that matched. It is two things in a passport: a `signal` line, which says what
   * matched and where, and an entry in `signals`, which is what is counted and listed by file.
   */
  signal(input: SignalInput): void {
    const ruleId = this.safe(input.ruleId, RULE_MAX, '(no rule)');
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

  /**
   * Records that a reading failed. The passport is still made, but it lacks what the reading finds,
   * so the failure is a sensitive signal that names the reading (by one of the fixed names, never by
   * text of the artifact) and a blind spot that names it too; `passportIsIncomplete` reads the signal.
   */
  failedReading(name: ReadingName): void {
    this.failed.add(name);
    this.signal({
      ruleId: `reading-failed:${name}`,
      file: '.',
      line: null,
      sensitive: true,
      basis: 'unknown',
      detector:
        'a reading of the files failed on this tree, so what it finds is missing from this passport and the passport is not complete',
    });
  }

  blindSpot(text: string): void {
    const shown = showable(text, SINGLE_DETECTOR_MAX);
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
        detector: showable(joinDetectors(draft.detectors), DETECTOR_MAX),
      });
    });
    const kept =
      all.length > MAX_LINES ? [...all].sort(compareForKeeping).slice(0, MAX_LINES) : all;
    const lines = [...kept].sort(compareLines);

    const spots = new Set<string>([
      ...ALWAYS_BLIND_SPOTS,
      ...this.spots,
      ...tallySpots(this.counts),
      ...[...this.failed].map(failedReadingSpot),
    ]);
    const hidden = all.length - kept.length + this.dropped;
    if (hidden > 0) spots.add(moreLinesSpot(hidden));
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
