import { closed, count, member, stamp } from './local-guards';

/**
 * The card on the Check screen, as the local engine returns it (`stroq-card-state/1`). The words and
 * numbers are the ones `stroq` prints in a terminal: the engine runs the CLI's own card and makes this
 * from the CLI's own wording, so nothing here words a count. A reply that is not exactly this shape is
 * refused whole.
 */

export const CARD_STATUSES = ['idle', 'running', 'done', 'failed'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const OWL_FRAMES = ['alert', 'happy', 'idle'] as const;
export type OwlFrame = (typeof OWL_FRAMES)[number];

export const MOMENT_KINDS = [
  'told-by-text',
  'key-sent',
  'key-maybe',
  'key-seen',
  'autorun-repo',
] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

export const COUNT_IDS = ['commands', 'told', 'keys', 'autorun'] as const;
export type CountId = (typeof COUNT_IDS)[number];

export interface CardMoment {
  readonly n: number;
  readonly kind: MomentKind;
  readonly line: string;
  readonly session?: {
    readonly agent: 'claude-code' | 'codex';
    readonly id: string;
    readonly path: string;
    readonly cwd: string | null;
  };
  readonly groups: readonly {
    readonly title: string;
    readonly rows: readonly (readonly [string, string])[];
  }[];
  /** Commands to dig deeper, ready to paste. */
  readonly next: readonly string[];
}

export interface CardNextStep {
  readonly label: string;
  readonly command: string;
}

export interface CardCountRow {
  readonly id: CountId;
  readonly count: number;
  readonly text: string;
}

export type CardView =
  | {
      readonly kind: 'nothing-to-read';
      readonly title: string;
      readonly looked: string;
      readonly next: CardNextStep;
    }
  | {
      readonly kind: 'card';
      readonly title: string;
      readonly subtitle: string;
      readonly rows: readonly CardCountRow[];
      readonly notes: readonly string[];
      readonly nothing: string | null;
      readonly moments: readonly { readonly n: number; readonly line: string }[];
      readonly next: CardNextStep;
    };

export interface CardPresentation {
  readonly schema: 'stroq-card-view/1';
  readonly version: string;
  readonly generated: string;
  readonly days: number;
  readonly owl: OwlFrame;
  readonly view: CardView;
  readonly moments: readonly CardMoment[];
  readonly shown: number;
}

export const CARD_ERRORS = [
  'engine-unavailable',
  'deadline-exceeded',
  'output-limit',
  'cancelled',
  'invalid-report',
  'card-failed',
  'server-stopped',
] as const;
export type CardError = (typeof CARD_ERRORS)[number];

export interface CardState {
  readonly schema: 'stroq-card-state/1';
  readonly engine: { readonly available: boolean; readonly version: string | null };
  readonly status: CardStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: CardError | null;
  /** The last card made since the console started. It stays while the next one is made. */
  readonly result: CardPresentation | null;
}

/** What went wrong, in plain words, for the error codes the engine uses. */
export const CARD_ERROR_MESSAGES: Readonly<Record<CardError, string>> = {
  'engine-unavailable':
    'The Stroq engine is not built, so the card cannot be made. Run npx @stroq/cli console to start it.',
  'deadline-exceeded':
    'Checking took longer than two and a half minutes and was stopped. Check again: what was read is kept, so the next run starts further on.',
  'output-limit': 'The card was larger than the console accepts, so none of it was shown.',
  cancelled: 'The check was stopped.',
  'invalid-report': 'The card could not be verified, so none of it was shown.',
  'card-failed': 'The card could not be made. Check again, or run npx @stroq/cli in a terminal.',
  'server-stopped': 'The console is stopping. Open it again with npx @stroq/cli console.',
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const str = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const filled = (value: unknown, max: number): value is string =>
  str(value, max) && value.trim().length > 0;

const MAX_LINE = 700;
const MAX_VALUE = 800;

function nextStep(value: unknown): value is CardNextStep {
  return (
    closed(value, ['label', 'command']) && filled(value.label, 80) && filled(value.command, 200)
  );
}

function momentLine(value: unknown): value is { n: number; line: string } {
  return (
    closed(value, ['n', 'line']) &&
    Number.isSafeInteger(value.n) &&
    (value.n as number) >= 1 &&
    (value.n as number) <= 99 &&
    filled(value.line, MAX_LINE)
  );
}

function countRow(value: unknown): value is CardCountRow {
  return (
    closed(value, ['id', 'count', 'text']) &&
    member(value.id, COUNT_IDS) &&
    count(value.count, 1_000_000_000) &&
    filled(value.text, 200)
  );
}

function view(value: unknown): value is CardView {
  if (closed(value, ['kind', 'title', 'looked', 'next']))
    return (
      value.kind === 'nothing-to-read' &&
      filled(value.title, 200) &&
      filled(value.looked, 400) &&
      nextStep(value.next)
    );
  if (!closed(value, ['kind', 'title', 'subtitle', 'rows', 'notes', 'nothing', 'moments', 'next']))
    return false;
  const ids = Array.isArray(value.rows)
    ? value.rows.map((row) => (row as { id?: unknown }).id)
    : [];
  return (
    value.kind === 'card' &&
    filled(value.title, 200) &&
    filled(value.subtitle, 200) &&
    Array.isArray(value.rows) &&
    value.rows.length === COUNT_IDS.length &&
    value.rows.every(countRow) &&
    COUNT_IDS.every((id, index) => ids[index] === id) &&
    Array.isArray(value.notes) &&
    value.notes.length <= 16 &&
    value.notes.every((note) => filled(note, 400)) &&
    (value.nothing === null || filled(value.nothing, 200)) &&
    Array.isArray(value.moments) &&
    value.moments.length <= 10 &&
    value.moments.every(momentLine) &&
    (value.nothing === null) === value.moments.length > 0 &&
    nextStep(value.next)
  );
}

function group(value: unknown): value is CardMoment['groups'][number] {
  return (
    closed(value, ['title', 'rows']) &&
    filled(value.title, 80) &&
    Array.isArray(value.rows) &&
    value.rows.length <= 16 &&
    value.rows.every(
      (row) => Array.isArray(row) && row.length === 2 && str(row[0], 80) && str(row[1], MAX_VALUE),
    )
  );
}

function moment(value: unknown): value is CardMoment {
  if (!closed(value, ['n', 'kind', 'line', 'session', 'groups', 'next'])) return false;
  const session = value.session;
  return (
    Number.isSafeInteger(value.n) &&
    (value.n as number) >= 1 &&
    (value.n as number) <= 99 &&
    member(value.kind, MOMENT_KINDS) &&
    filled(value.line, MAX_LINE) &&
    (session === undefined ||
      (closed(session, ['agent', 'id', 'path', 'cwd']) &&
        member(session.agent, ['claude-code', 'codex']) &&
        str(session.id, 400) &&
        str(session.path, 1_000) &&
        (session.cwd === null || str(session.cwd, 1_000)))) &&
    Array.isArray(value.groups) &&
    value.groups.length <= 8 &&
    value.groups.every(group) &&
    Array.isArray(value.next) &&
    value.next.length <= 4 &&
    value.next.every((command) => filled(command, 600))
  );
}

function presentation(value: unknown): value is CardPresentation {
  if (!closed(value, ['schema', 'version', 'generated', 'days', 'owl', 'view', 'moments', 'shown']))
    return false;
  return (
    value.schema === 'stroq-card-view/1' &&
    filled(value.version, 80) &&
    str(value.generated, 40) &&
    Number.isSafeInteger(value.days) &&
    (value.days as number) >= 1 &&
    (value.days as number) <= 365 &&
    member(value.owl, OWL_FRAMES) &&
    view(value.view) &&
    Array.isArray(value.moments) &&
    value.moments.length <= 10 &&
    value.moments.every(moment) &&
    value.moments.every((m, index) => (m as CardMoment).n === index + 1) &&
    Number.isSafeInteger(value.shown) &&
    (value.shown as number) >= 0 &&
    (value.shown as number) <= 10
  );
}

export function validateCardState(value: unknown): value is CardState {
  if (!closed(value, ['schema', 'engine', 'status', 'startedAt', 'finishedAt', 'error', 'result']))
    return false;
  const engine = value.engine;
  return (
    value.schema === 'stroq-card-state/1' &&
    closed(engine, ['available', 'version']) &&
    typeof engine.available === 'boolean' &&
    (engine.version === null || filled(engine.version, 80)) &&
    member(value.status, CARD_STATUSES) &&
    (value.startedAt === null || stamp(value.startedAt)) &&
    (value.finishedAt === null || stamp(value.finishedAt)) &&
    (value.error === null || member(value.error, CARD_ERRORS)) &&
    (value.result === null || presentation(value.result))
  );
}

/** The frame of the owl for a state: the result's own, or the idle owl when there is no card. */
export function owlFor(state: CardState | null): OwlFrame {
  return state?.result?.owl ?? 'idle';
}

/** The file of the owl for a frame (`console/public/hoo/`, written by `pnpm owl:svg`). */
export const owlSrc = (frame: OwlFrame): string => `/hoo/${frame}.svg`;

/** How long ago, for the line under the card: "just now", "4 min ago", "3 h ago". */
export function checkedAgo(finishedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(finishedAt)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** A card older than this is made again when the screen is opened. */
export const STALE_MS = 10 * 60_000;

/** Whether opening the screen should start a run: nothing made yet, or what was made is old. */
export function shouldStart(state: CardState, now: number): boolean {
  if (!state.engine.available || state.status === 'running') return false;
  if (state.status === 'failed') return false;
  if (state.status === 'idle') return true;
  return state.finishedAt === null || now - Date.parse(state.finishedAt) > STALE_MS;
}
