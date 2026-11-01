// What a run of the card found, as data: the renderer, `--json`, `--share` and the cache for
// `stroq show` all read this one shape.
import type { Moment } from './schema.js';

export const CARD_SCHEMA = 'stroq-card/1';

export interface CardCounts {
  /** Shell commands the agents ran. */
  readonly commands: number;
  /** Of them, the ones a text the agent had read told it to run (the strict rule). */
  readonly toldByText: number;
  /** Keys sent to another company. */
  readonly keysSent: number;
  /** Keys a call to another company tried to send and was stopped; not in `keysSent`. */
  readonly keysStopped: number;
  /** Keys the AI saw (and none was seen leaving). */
  readonly keysSeen: number;
  /** Folders that run code as soon as an agent opens them. */
  readonly autorunRepos: number;
}

export interface CardCoverage {
  /** Sessions in the window, per agent. */
  readonly found: number;
  readonly agents: { readonly claudeCode: number; readonly codex: number };
  /** Sessions whose commands were counted: from this run or from the cache. */
  readonly checked: number;
  /** Of those, read from the cache. */
  readonly fromCache: number;
  /** Not checked because the time ran out, newest first. */
  readonly notChecked: number;
  /** Past the size the card replays. */
  readonly tooLarge: number;
  /** Could not be read, or the worker that held them died. */
  readonly unreadable: number;
  /** Sessions the agents keep that are older than the window. */
  readonly older: number;
  /** The key check: done, cut short, or nothing to check. */
  readonly keys: 'checked' | 'not-finished' | 'no-sessions';
  readonly folders: {
    readonly found: number;
    readonly checked: number;
    /** More folders than the card looks at. */
    readonly capped: boolean;
  };
  /** Where the agents' sessions are looked for. */
  readonly looked: readonly string[];
  /** Whether the cache could be saved. */
  readonly cacheSaved: boolean;
}

export interface CardData {
  readonly schema: typeof CARD_SCHEMA;
  readonly version: string;
  /** ISO 8601. */
  readonly generated: string;
  readonly days: number;
  readonly counts: CardCounts;
  /** Ranked, most worth a look first; the card shows the first few. */
  readonly moments: readonly Moment[];
  readonly coverage: CardCoverage;
  readonly timing: {
    readonly totalMs: number;
    /** Transcripts replayed in this run. */
    readonly replayed: number;
    readonly workers: number;
  };
}

/** The moments the card shows; `stroq show N` takes any of the moments kept. */
export const SHOWN = 3;
/** The moments kept for `--json` and `stroq show`. */
export const KEPT = 10;
