import type { ToolCall } from './platform-types';

/**
 * What the Live address says: which decisions to show, one session, one day, some words, and the one
 * event whose chain is open. Everything is read back through these guards, so a hand-made address
 * can only select; it never reaches anything the page does not already show.
 */
export const LIVE_SHOWS = ['all', 'denied', 'asked', 'flagged'] as const;
export type LiveShow = (typeof LIVE_SHOWS)[number];

export interface LiveSelection {
  readonly show: LiveShow;
  /** A session by the name the console gives it (`session-` and sixteen hex digits), or null. */
  readonly session: string | null;
  /** A local day, `YYYY-MM-DD`, or null. */
  readonly date: string | null;
  readonly text: string;
  /**
   * The open event: the digest of its journal line (64 hex digits) or, for an older link, its
   * number in the journal. Null when none is open.
   */
  readonly event: string | null;
}

const SESSION = /^session-[a-f0-9]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT = /^(?:[a-f0-9]{64}|[1-9]\d{0,15})$/;
const MAX_TEXT = 200;

type Params = Pick<URLSearchParams, 'get'>;

export function liveSelection(params: Params): LiveSelection {
  const show = params.get('show');
  const session = params.get('session');
  const date = params.get('date');
  const text = params.get('q') ?? '';
  const event = params.get('event');
  return {
    show: LIVE_SHOWS.find((value) => value === show) ?? 'all',
    session: session !== null && SESSION.test(session) ? session : null,
    date:
      date !== null && DATE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
        ? date
        : null,
    text: text.length <= MAX_TEXT ? text : '',
    event: event !== null && EVENT.test(event) ? event : null,
  };
}

/** The address of Live for a selection; what is left at its default is left out. */
export function liveHref(selection: Partial<LiveSelection>): string {
  const params = new URLSearchParams();
  if (selection.show !== undefined && selection.show !== 'all') params.set('show', selection.show);
  if (selection.session) params.set('session', selection.session);
  if (selection.date) params.set('date', selection.date);
  if (selection.text) params.set('q', selection.text);
  if (selection.event) params.set('event', selection.event);
  return `/live/${params.size > 0 ? `?${params}` : ''}`;
}

/** The address of one recorded decision: by its journal line's digest when it has one, else its number. */
export function liveEventHref(call: Pick<ToolCall, 'id' | 'evidenceSha'>): string {
  const number = /^audit-([1-9]\d*)$/.exec(call.id)?.[1];
  const event =
    call.evidenceSha !== undefined && /^[a-f0-9]{64}$/.test(call.evidenceSha)
      ? call.evidenceSha
      : number;
  return liveHref(event === undefined ? {} : { event });
}
