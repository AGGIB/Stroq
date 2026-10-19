import { showable } from '../install/inspect/safe-text.js';
import { isFailing, type FailOn, type TaggedHit } from './agent-change.js';
import { VALUE_MAX, describe, groupHits, plainQuote, type Quote } from './agent-report.js';

/**
 * `stroq inspect --format github`: a job summary in Markdown on standard output, which the
 * Action redirects to `$GITHUB_STEP_SUMMARY`, and at most ten annotation lines on standard
 * error, where the runner reads workflow commands as well and the redirect does not take them.
 *
 * Every name, value and path here was written by the author of the change being checked.
 * In an annotation a newline would start a workflow command of its own, so data and
 * properties are escaped exactly as the Actions toolkit escapes them. In the summary each
 * piece of repository text is put in a code span with its backticks taken out, so it cannot
 * become a link, an image, a mention or a heading.
 */

/** GitHub shows ten annotations of each kind for a step; the rest are in the summary. */
export const MAX_ANNOTATIONS = 10;
/** The most entries of one group the summary lists before it says how many more there are. */
const MAX_LISTED = 50;
const WHERE_MAX = 240;

/** `escapeData` of `@actions/core`. */
export const escapeData = (text: string): string =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** `escapeProperty` of `@actions/core`. */
export const escapeProperty = (text: string): string =>
  escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

const levelOf = (h: TaggedHit, failOn: FailOn): 'error' | 'warning' =>
  isFailing(h, failOn) ? 'error' : 'warning';

/**
 * What runs before anyone approves anything, read from the checkout's own `.git` and its
 * nested repositories. Only a check without a base has these: a change cannot alter `.git`.
 */
export interface PreTrustItem {
  readonly kind: string;
  readonly file: string;
  readonly what: string;
  readonly why: string;
}

const annotation = (level: string, file: string, line: number, kind: string, text: string) =>
  `::${level} ${[
    `file=${escapeProperty(showable(file, WHERE_MAX))}`,
    `line=${line}`,
    `title=${escapeProperty(`stroq inspect: ${kind}`)}`,
  ].join(',')}::${escapeData(text)}`;

/**
 * One `::error` or `::warning` line per finding worth a look on the change: the failing ones
 * first, then the other new or changed ones. Notices and what was already there are only in
 * the summary.
 */
export function annotations(
  hits: readonly TaggedHit[],
  failOn: FailOn,
  preTrust: readonly PreTrustItem[] = [],
): string[] {
  const { failing, review } = groupHits(hits, failOn);
  const before = preTrust.map((p) =>
    annotation(
      failOn === 'any' ? 'error' : 'warning',
      p.file,
      1,
      p.kind,
      `${plainQuote(p.what)}: ${p.why}`,
    ),
  );
  const agent = [...failing, ...review.filter((h) => h.severity !== 'notice')].map((h) =>
    annotation(levelOf(h, failOn), h.file, h.line, h.kind, describe(h, plainQuote)),
  );
  return [...before, ...agent].slice(0, MAX_ANNOTATIONS);
}

/** Repository text as a Markdown code span that nothing inside can close. */
export const codeSpan: Quote = (text) => `\`${showable(text, VALUE_MAX).replace(/`/g, "'")}\``;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function listed(heading: string, hits: readonly TaggedHit[]): string[] {
  if (hits.length === 0) return [];
  const lines = hits
    .slice(0, MAX_LISTED)
    .map((h) => `- ${codeSpan(`${h.file}:${h.line}`)} ${describe(h, codeSpan)}`);
  const more = hits.length > MAX_LISTED ? [`- and ${hits.length - MAX_LISTED} more`] : [];
  return [`#### ${heading}`, '', ...lines, ...more, ''];
}

export interface SummaryContext {
  readonly failOn: FailOn;
  /** The revision the change was compared with, as given, and the commit it named. */
  readonly changedFrom?: string;
  readonly base?: string;
  readonly preTrust?: readonly PreTrustItem[];
}

function preTrustList(items: readonly PreTrustItem[]): string[] {
  if (items.length === 0) return [];
  const lines = items.map((p) => `- ${codeSpan(p.file)} ${codeSpan(p.what)}: ${p.why}`);
  return ['#### Before you approve anything', '', ...lines, ''];
}

function verdict(groups: ReturnType<typeof groupHits>, context: SummaryContext): string {
  const before = context.failOn === 'any' ? (context.preTrust ?? []).length : 0;
  const n = groups.failing.length + before;
  if (n > 0) {
    const what = context.failOn === 'new' ? ['new entry', 'new entries'] : ['entry', 'entries'];
    return `**Fails.** ${plural(n, what[0] as string, what[1] as string)} ${n === 1 ? 'takes effect by itself' : 'take effect by themselves'} when an agent or editor opens this repository.`;
  }
  if (groups.review.length > 0)
    return `**Passes.** ${plural(groups.review.length, 'entry', 'entries')} to review; none fails.`;
  return context.changedFrom === undefined
    ? '**Passes.** Nothing here fails.'
    : '**Passes.** Nothing in this change runs by itself when an agent or editor opens the repository.';
}

export function githubSummary(hits: readonly TaggedHit[], context: SummaryContext): string {
  const groups = groupHits(hits, context.failOn);
  const compared =
    context.changedFrom === undefined
      ? []
      : [
          `Compared with ${codeSpan(context.changedFrom)} (${codeSpan((context.base ?? '').slice(0, 12))}). Fails on: ${context.failOn}.`,
          '',
        ];
  const presentHeading = `Already there before this change (${groups.present.length}, not failing)`;
  return [
    '### stroq inspect',
    '',
    verdict(groups, context),
    '',
    ...compared,
    ...preTrustList(context.preTrust ?? []),
    ...listed('Fails', groups.failing),
    ...listed('To review', groups.review),
    ...listed(context.changedFrom === undefined ? 'Not failing' : presentHeading, groups.present),
  ].join('\n');
}
