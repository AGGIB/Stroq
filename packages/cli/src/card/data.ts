// What a run of the card found, as data: the renderer, `--json`, `--share` and the cache for
// `stroq show` all read this one shape.
import type { Moment } from './schema.js';

export const CARD_SCHEMA = 'stroq-card/1';

export interface CardCounts {
  /** Shell commands the agents ran. */
  readonly commands: number;
  /** Of them, the ones a text the agent had read told it to run (the strict rule). */
  readonly toldByText: number;
  /**
   * Keys that left this machine: every key `stroq sent` puts under "sent to another company", whatever
   * the destination (a server the user logs in to by ssh is in it: it may be theirs, and the words of the
   * moment say so).
   */
  readonly keysSent: number;
  /** Keys a call tried to send out of this machine and was stopped; not in `keysSent`. */
  readonly keysStopped: number;
  /** Keys the AI saw (and none was seen leaving). */
  readonly keysSeen: number;
  /** Folders that run code as soon as an agent opens them. */
  readonly autorunRepos: number;
}

export interface CardCoverage {
  /** Sessions in the window, per agent. */
  readonly found: number;
  readonly agents: {
    readonly claudeCode: number;
    readonly codex: number;
    readonly cursor?: number;
  };
  /** Sessions whose commands were counted: from this run or from the cache. */
  readonly checked: number;
  /** Of those, read from the cache. */
  readonly fromCache: number;
  /** Not checked because the time ran out, newest first. */
  readonly notChecked: number;
  /**
   * Whose replay was cut off by the time limit, now or in an earlier run on the same file, and is not
   * waited for again until the file changes (or a run is given more time).
   */
  readonly tooSlow: number;
  /** Past the size the card replays. */
  readonly tooLarge: number;
  /** Values in key files that look like examples or placeholders: not traced, and counted here. */
  readonly placeholders: number;
  /** The names of those values, each once: names only, never a value. */
  readonly placeholderNames: readonly string[];
  /** Could not be read, or the worker that held them died. */
  readonly unreadable: number;
  /** Sessions the agents keep that are older than the window. */
  readonly older: number;
  /** The key check: every session that can be checked is, cut short, or nothing to check. */
  readonly keys: 'checked' | 'not-finished' | 'no-sessions';
  /** Sessions whose keys were checked: in this run or in an earlier one. The sessions too large are not. */
  readonly keysChecked: number;
  /** Of those, read from what an earlier run kept. */
  readonly keysFromCache: number;
  /** Sessions that can be checked and were not reached in time, or whose check was lost. */
  readonly keysNotChecked: number;
  /** Checked, but a file could not be read or a bound of the check was reached: not kept for later. */
  readonly keysIncomplete: number;
  readonly folders: {
    readonly found: number;
    readonly checked: number;
    /** More folders than the card looks at. */
    readonly capped: boolean;
  };
  /** Where the agents' sessions are looked for. */
  readonly looked: readonly string[];
  /** A Cursor store that was unreadable, cut short, or has uncommitted changes. */
  readonly cursorNote?: string;
  /** Moments the person marked as false alarms (`stroq show <n> --false-alarm`). */
  readonly falseAlarms: {
    /** Left out of `moments`. The counts still hold them: they are what the rules found. */
    readonly leftOut: number;
    /** The marks could not be read, so none was applied. */
    readonly unreadable: boolean;
  };
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
    /** From the start until the replay had nothing more to do: its last answer (0 when none was needed). */
    readonly replayMs: number;
    /**
     * From the start until the key check had nothing more to do: its last answer, or, when everything
     * was kept from an earlier run, the moment the kept results were read and merged.
     */
    readonly keysMs: number;
  };
}

/** The moments the card shows; `stroq show N` takes any of the moments kept. */
export const SHOWN = 3;
/** The moments kept for `--json` and `stroq show`. */
export const KEPT = 10;
