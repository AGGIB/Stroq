// The screen of `stroq vet`: what a passport says, in about a screen, for a person.
//
// The order is the order of what a person needs: what it is and the digest of its files; what it asks for
// or can do, the lines that are sensitive first, each with what it rests on; the rules that matched; and
// what was NOT looked at, which is always printed in full because an absent line means nothing. The last
// line says what all of that is not.
//
// A screen is about 25 lines. What does not fit is the lines that are not sensitive first, then the rest,
// and the screen says how many it left out and that `--json` lists them all. Nothing else is ever left out:
// the blind spots are all there, however many, because a short list of what was not looked at would
// be the one place where "nothing" could be taken for "all".
import { failedReadings } from '../install/inspect/index.js';
import { READING_PHRASES } from '../install/inspect/blind-spots.js';
import { READ_DIR_BLIND_SPOTS } from '../install/read-dir.js';
import type { Passport, PassportLine } from '../install/types.js';
import { count, lineText, padTo, tailText, widthOf } from './vet-text.js';

/** The lines on a screen, as a goal: the blind spots and the closing sentence are never cut to meet it. */
const SCREEN_LINES = 25;
/** The fewest lines of the passport on a screen, however much else there is to say. */
const MIN_ROWS = 5;
const NAME_MAX = 100;
const VERSION_MAX = 64;
const SUBJECT_MAX = 56;
const FILE_MAX = 40;
const RULE_MAX = 48;
const SIGNAL_RULES_SHOWN = 3;
const BASIS_WIDTH = '[declared]'.length;

export const CLOSING =
  'This is a reading of the files, not a security certificate: an absent line means nothing was seen, not that nothing is there.';

export interface RenderOptions {
  /** The digest was compared with `--expect` and is the one expected. */
  readonly matchedExpect?: boolean;
}

/** Whether the digest was taken from a folder read where the executable bit is not known. */
export const isPlatformDependent = (passport: Passport): boolean =>
  passport.blindSpots.includes(READ_DIR_BLIND_SPOTS.noExecutableBit);

/** Where the title is taken from, when the artifact does not name itself. */
function originOf(type: Passport['artifact']['source']['type']): string {
  if (type === 'dir') return 'named after the folder';
  return type === 'tarball' ? 'named after the archive' : 'named by its source';
}

/** What the name and version in the title rest on: the artifact's own words, or where it was taken from. */
function declaredParts(passport: Passport): { name: boolean; version: boolean } {
  const { name, version } = passport.artifact;
  const subjects = new Set(
    passport.lines.filter((line) => line.basis === 'declared').map((line) => line.subject),
  );
  const versioned = version === null ? null : `declared-name: ${name} ${version}`;
  return {
    name: subjects.has(`declared-name: ${name}`) || (versioned !== null && subjects.has(versioned)),
    version:
      version !== null &&
      (subjects.has(`declared-version: ${version}`) || subjects.has(versioned ?? '')),
  };
}

function titleLine(passport: Passport): string {
  const { kind, name, version, source } = passport.artifact;
  const declared = declaredParts(passport);
  const origin = originOf(source.type);
  const note = declared.name
    ? `name${declared.version ? ' and version' : ''} declared by the artifact, not checked`
    : declared.version
      ? `${origin}; version declared by the artifact, not checked`
      : origin;
  const shownVersion = version === null ? '' : ` ${lineText(version, VERSION_MAX)}`;
  return `${kind} ${lineText(name, NAME_MAX)}${shownVersion} (${note})`;
}

function digestLine(passport: Passport, options: RenderOptions): string {
  const { digest, files, bytes } = passport.artifact;
  const notes = [
    ...(isPlatformDependent(passport) ? ['platform-dependent: no executable bit'] : []),
    ...(options.matchedExpect === true ? ['matches --expect'] : []),
  ];
  const size = `${count(files, 'file')}, ${count(bytes, 'byte')}`;
  const tail = notes.map((note) => ` (${note})`).join('');
  return `stroq-tree/1 sha256:${lineText(digest, 64)}  ${size}${tail}`;
}

/** What is said of each reading that failed, or nothing. A name that is not one of ours is shown as text. */
function incompleteLines(passport: Passport): string[] {
  return failedReadings(passport).map((name) => {
    const phrase = Object.hasOwn(READING_PHRASES, name)
      ? READING_PHRASES[name as keyof typeof READING_PHRASES]
      : 'a reading';
    return `INCOMPLETE: the reading "${lineText(name, RULE_MAX)}" (${phrase}) failed, and what it finds is missing from this passport`;
  });
}

function placeOf(line: PassportLine): string {
  const [first, ...rest] = line.where;
  if (first === undefined) return '';
  const place = `${tailText(first.file, FILE_MAX)}${first.line === null ? '' : `:${first.line}`}`;
  return rest.length === 0 ? place : `${place} (+${rest.length} more)`;
}

interface Row {
  readonly basis: string;
  readonly kind: string;
  readonly subject: string;
  readonly place: string;
}

const rowOf = (line: PassportLine): Row => ({
  basis: `[${lineText(line.basis, 8)}]`,
  kind: lineText(line.kind, 16),
  subject: lineText(line.subject, SUBJECT_MAX),
  place: placeOf(line),
});

/** The rows in columns: the width of each column is that of the widest row on the screen. */
function aligned(rows: readonly Row[]): string[] {
  const kindWidth = Math.max(0, ...rows.map((row) => widthOf(row.kind)));
  const subjectWidth = Math.max(0, ...rows.map((row) => widthOf(row.subject)));
  return rows.map((row) =>
    `  ${padTo(row.basis, BASIS_WIDTH)} ${padTo(row.kind, kindWidth)}  ${padTo(row.subject, subjectWidth)}  ${row.place}`.trimEnd(),
  );
}

/** The plural-aware words for what was left out, with how many of it was sensitive. */
function moreLine(hidden: readonly PassportLine[]): string {
  const sensitive = hidden.filter((line) => line.sensitive).length;
  const of = sensitive > 0 ? ` (${sensitive} of them sensitive)` : '';
  return `  and ${count(hidden.length, 'more line')} not shown${of}; stroq vet --json lists all of them`;
}

function signalsLine(passport: Passport): string {
  if (passport.signals.length === 0) return 'SIGNALS: none seen (static)';
  const counts = new Map<string, number>();
  for (const { ruleId } of passport.signals) counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
  const rules = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  const named = rules
    .slice(0, SIGNAL_RULES_SHOWN)
    .map(([rule, n]) => `${lineText(rule, RULE_MAX)}${n > 1 ? ` x${n}` : ''}`);
  const rest = rules.length - named.length;
  const more = rest > 0 ? [`and ${count(rest, 'more rule')}`] : [];
  return `SIGNALS (${passport.signals.length}): ${[...named, ...more].join(', ')}`;
}

function blindSpotLines(passport: Passport): string[] {
  const spots = passport.blindSpots.map((spot) => `  - ${lineText(spot, 400)}`);
  return [`BLIND SPOTS (${spots.length}), what was not looked at`, ...spots];
}

/** The lines of the passport to put on the screen: how many, so that the screen is about `SCREEN_LINES`. */
function shownCount(total: number, fixed: number): number {
  const budget = Math.max(MIN_ROWS, SCREEN_LINES - fixed);
  return total <= budget ? total : Math.max(MIN_ROWS, budget - 1);
}

/** The text of the screen. A passport is read as it is: nothing is looked up, nothing is run. */
export function renderPassport(passport: Passport, options: RenderOptions = {}): string {
  const sensitive = passport.lines.filter((line) => line.sensitive);
  const plain = passport.lines.filter((line) => !line.sensitive);
  const head = [titleLine(passport), digestLine(passport, options), ...incompleteLines(passport)];
  const tail = [signalsLine(passport), ...blindSpotLines(passport), '', CLOSING];
  const headings = (sensitive.length > 0 ? 1 : 0) + (plain.length > 0 ? 1 : 0);
  const shown = shownCount(
    passport.lines.length,
    head.length + Math.max(1, headings) + tail.length,
  );
  const ordered = [...sensitive, ...plain];
  const rows = aligned(ordered.slice(0, shown).map(rowOf));
  const body: string[] = [];
  if (ordered.length === 0) body.push('LINES: none seen (static)');
  const inSensitive = Math.min(shown, sensitive.length);
  if (sensitive.length > 0)
    body.push(`SENSITIVE (${sensitive.length})`, ...rows.slice(0, inSensitive));
  if (plain.length > 0) body.push(`OTHER (${plain.length})`, ...rows.slice(inSensitive));
  if (shown < ordered.length) body.push(moreLine(ordered.slice(shown)));
  return [...head, ...body, ...tail].join('\n') + '\n';
}
