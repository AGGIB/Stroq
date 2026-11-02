// The key check of one run of the card: which sessions still need it, what its answers add up to, and
// what is kept for the next run.
//
// The check of a transcript is a job for the pool (`key-job.ts`). A transcript whose result is kept,
// for the same file (size and date), the same Stroq and the same keys (`key-index.ts`), is not checked
// again. A transcript past the replay's size limit is not checked and is counted as too large, as the
// replay counts it. What the budget does not reach is counted and said, and the next run goes on from
// what was kept. Every number here is of the sessions checked, never an estimate for the rest.
import { HIDDEN } from '../sent/analyze.js';
import { stoppedFindings } from '../sent/report.js';
import type { Finding, SessionKeySummary } from '../sent/findings.js';
import type { PlacedFinding } from './key-moments.js';
import { keyFinder, loadKeys, type KeyFinder } from '../sent/keys.js';
import { loadMcpServers } from '../sent/mcp-config.js';
import { printableId, projectDirs } from '../sent/run.js';
import { withSessionCanaries } from '../sent/session-canaries.js';
import { canaryNotes, type CanaryNotes } from './canary-memory.js';
import type { CardJob } from './jobs.js';
import type { KeyAnswer } from './key-job.js';
import { indexDigest, newSalt, prepareIndex, type PreparedIndex } from './key-index.js';
import { registerKeyIndex } from './key-registry.js';
import { namesGuard } from './ordinary-value.js';
import { findingsBySession, findingsOf, fitsKept, sanitizeKeys, summaryOf } from './key-result.js';
import type { KeyCacheEntry, SessionKeys } from './key-schema.js';
import { entriesUnder, keptKeys, keyCacheKey, readKeyCache, writeKeyCache } from './key-store.js';
import { scrubber, type Scrub } from './scrub.js';
import { isTooLarge, type WindowSession } from './window.js';

export interface KeysEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stroqHome: string;
  readonly cwd: string;
  readonly version: string;
  /**
   * The start of the window, in milliseconds since 1970: a sighting counts only if it happened at or
   * after it (a hit with no time counts, as its file, whose date is in the window, does).
   */
  readonly since: number;
}

/** What the key check of a run came to. */
export interface KeyOutcome {
  /** One finding for each key, under the most external place it reached: what is counted. */
  readonly findings: readonly Finding[];
  /**
   * One finding for each key in each session it was found in (sent, or only seen): what the moments are
   * made from, so that a moment tells what one session did and not what the key did in the end.
   */
  readonly bySession: readonly PlacedFinding[];
  /** Distinct values in key files that look like examples or placeholders, so were not looked for. */
  readonly placeholders: number;
  /** Their names, each once; never a value. */
  readonly placeholderNames: readonly string[];
  /** Keys sent to another company that were stopped before they left. */
  readonly stopped: number;
  /** Sessions whose keys were checked: now or in an earlier run. Too large ones are not among them. */
  readonly checked: number;
  /** Of those, kept from an earlier run. */
  readonly fromCache: number;
  /** Sessions that could be checked and were not reached in time, or whose check was lost. */
  readonly notChecked: number;
  /** Checked, but not in full: a file could not be read or a bound of the check was reached. */
  readonly incomplete: number;
  /** Sessions (by place in the window) whose files could not be read or whose check was lost. */
  readonly unreadable: ReadonlySet<number>;
  readonly saved: boolean;
}

export interface KeysRun {
  /** Removes any key from a text that is about to be kept. */
  readonly scrub: Scrub;
  /** A name from a session (a folder, a path) as it may be shown: the rule of the key findings'. */
  readonly name: (text: string) => string;
  /** A session's id as it may be shown. */
  readonly id: (text: string) => string;
  /** The digest of the keys this run looked for; empty when there were none. */
  readonly digest: string;
  /** The job that checks session `index`, or null: nothing to look for, too large, or kept. */
  jobFor(index: number): CardJob | null;
  /** An answer for session `index`; null is a check that failed. */
  accept(index: number, answer: KeyAnswer | null): void;
  /** Adds the answers up, keeps what can be kept, and lets go of the index. */
  finish(): KeyOutcome;
}

/** Reads the keys of this machine, looks up what is kept, and registers the index for the checks. */
export function startKeys(env: KeysEnv, sessions: readonly WindowSession[]): KeysRun {
  const dirs = projectDirs(
    env.cwd,
    sessions.map((s) => s.ref),
  );
  // The set `stroq sent` looks for (`checkSessions`): the key files, the environment, the decoys, and
  // the canaries `stroq canary` planted whose decoy is gone and that the sessions themselves show.
  const cache = readKeyCache(env.stroqHome);
  const notes = canaryNotes(cache.canaries);
  const loaded = withSessionCanaries(
    loadKeys({ home: env.home, env: env.env, projectDirs: dirs, stroqHome: env.stroqHome }),
    sessions.map((s) => s.ref),
    env.stroqHome,
    notes.memoryFor,
  );
  const finder = keyFinder(loaded.keys, namesGuard);
  const scrub = scrubber(finder);
  const shown = shownWith(finder, scrub);
  const checkable = sessions.map((s) => !isTooLarge(s));
  if (loaded.keys.length === 0)
    return nothingToLookFor(shown, checkable, loaded.placeholders, loaded.placeholderNames ?? []);

  const mcp = loadMcpServers({ home: env.home, projectDirs: dirs });
  const index = prepareIndex({ home: env.home, keys: loaded.keys, mcp: [...mcp.known] });
  const salt = cache.salt ?? newSalt();
  const digest = indexDigest(index, salt);
  const kept = entriesUnder(cache, digest);
  registerKeyIndex({ digest, data: index.data });
  // No file yet, or one made under other keys: write it, if only to keep the salt (the digest is a
  // stamp other files are kept under, and a new salt each run would be a new digest each run).
  const rewrite = cache.salt === null || cache.digest !== digest;
  return new Run({
    placeholders: loaded.placeholders,
    placeholderNames: loaded.placeholderNames ?? [],
    env,
    sessions,
    finder,
    scrub,
    shown,
    index,
    salt,
    digest,
    kept,
    rewrite,
    checkable,
    notes,
  });
}

/** How a run shows what came from a session: the name rule, then the scrub for what is left. */
interface Shown {
  readonly scrub: Scrub;
  readonly name: (text: string) => string;
  readonly id: (text: string) => string;
}

function shownWith(finder: KeyFinder, scrub: Scrub): Shown {
  return {
    scrub,
    name: (text) => scrub(finder.shown(text) ?? HIDDEN),
    id: (text) => scrub(printableId(text, finder)),
  };
}

/** A machine that holds no key to look for: every session that can be checked is, at once. */
function nothingToLookFor(
  shown: Shown,
  checkable: readonly boolean[],
  placeholders: number,
  placeholderNames: readonly string[],
): KeysRun {
  const checked = checkable.filter(Boolean).length;
  return {
    ...shown,
    digest: '',
    jobFor: () => null,
    accept: () => undefined,
    finish: () => ({
      findings: [],
      bySession: [],
      placeholders,
      placeholderNames,
      stopped: 0,
      checked,
      fromCache: 0,
      notChecked: 0,
      incomplete: 0,
      unreadable: new Set(),
      saved: true,
    }),
  };
}

interface RunParts {
  readonly placeholders: number;
  readonly placeholderNames: readonly string[];
  readonly env: KeysEnv;
  readonly sessions: readonly WindowSession[];
  readonly finder: KeyFinder;
  readonly scrub: Scrub;
  readonly shown: Shown;
  readonly index: PreparedIndex;
  readonly salt: string;
  readonly digest: string;
  readonly kept: ReadonlyMap<string, KeyCacheEntry>;
  /** There is no kept file, or it was made under other keys: it is written (without what was stale). */
  readonly rewrite: boolean;
  readonly checkable: readonly boolean[];
  readonly notes: CanaryNotes;
}

class Run implements KeysRun {
  readonly scrub: Scrub;
  readonly name: (text: string) => string;
  readonly id: (text: string) => string;
  readonly digest: string;
  /** What each session came to: kept or answered, by place in the window. */
  private readonly results = new Map<number, SessionKeys>();
  private readonly fromCache = new Set<number>();
  private readonly unreadable = new Set<number>();
  private readonly fresh = new Map<number, SessionKeys>();
  private incomplete = 0;

  constructor(private readonly p: RunParts) {
    this.scrub = p.scrub;
    this.name = p.shown.name;
    this.id = p.shown.id;
    this.digest = p.digest;
    p.sessions.forEach((s, i) => {
      if (!p.checkable[i]) return;
      const kept = keptKeys(p.kept, this.pathOf(s), this.keyOf(s));
      if (kept === null) return;
      this.results.set(i, kept);
      this.fromCache.add(i);
    });
  }

  /** The path a result is kept under: a transcript is named by its path, which holds no key. */
  private pathOf(s: WindowSession): string {
    return this.scrub(s.path);
  }

  private keyOf(s: WindowSession): string {
    return keyCacheKey({ bytes: s.bytes, mtimeMs: s.mtimeMs, version: this.p.env.version });
  }

  jobFor(index: number): CardJob | null {
    const s = this.p.sessions[index];
    if (s === undefined || !this.p.checkable[index] || this.results.has(index)) return null;
    return { kind: 'keys', ref: s.ref, digest: this.p.digest };
  }

  accept(index: number, answer: KeyAnswer | null): void {
    if (answer === null) {
      this.unreadable.add(index);
      return;
    }
    const result = sanitizeKeys(answer.result, this.p.finder, this.scrub);
    this.results.set(index, result);
    if (answer.unreadable > 0) this.unreadable.add(index);
    if (!answer.complete) this.incomplete += 1;
    else if (fitsKept(result)) this.fresh.set(index, result);
  }

  finish(): KeyOutcome {
    const { sessions, finder, index } = this.p;
    const numbered: [number, SessionKeySummary][] = [];
    sessions.forEach((s, i) => {
      const result = this.results.get(i);
      if (result === undefined) return;
      numbered.push([
        i,
        summaryOf(
          result,
          index.indexOf,
          { agent: s.agent, id: '', path: s.path, cwd: s.cwd },
          this.p.env.since,
        ),
      ]);
    });
    const findings = findingsOf(
      index.data.keys,
      finder,
      numbered.map(([, summary]) => summary),
    );
    const bySession = findingsBySession(index.data.keys, finder, numbered);
    const saved = this.save();
    registerKeyIndex(null);
    const checkable = this.p.checkable.filter(Boolean).length;
    return {
      findings,
      bySession,
      placeholders: this.p.placeholders,
      placeholderNames: this.p.placeholderNames,
      stopped: stoppedFindings(findings),
      checked: this.results.size,
      fromCache: this.fromCache.size,
      notChecked: checkable - this.results.size,
      incomplete: this.incomplete,
      unreadable: this.unreadable,
      saved,
    };
  }

  /** Keeps what was kept and what was just made complete; false when it could not be written. */
  private save(): boolean {
    if (this.fresh.size === 0 && !this.p.notes.changed() && !this.p.rewrite) return true;
    const entries = new Map(this.p.kept);
    for (const [i, result] of this.fresh) {
      const s = this.p.sessions[i] as WindowSession;
      entries.set(this.pathOf(s), { key: this.keyOf(s), mtimeMs: s.mtimeMs, result });
    }
    try {
      writeKeyCache(this.p.env.stroqHome, {
        salt: this.p.salt,
        digest: this.p.digest,
        entries,
        canaries: this.p.notes.result(),
      });
      return true;
    } catch {
      return false;
    }
  }
}
