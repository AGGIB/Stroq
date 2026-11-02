// The key check of one run of the card: which sessions still need it, what its answers add up to, and
// what is kept for the next run.
//
// The check of a transcript is a job for the pool (`key-job.ts`). A transcript whose result is kept,
// for the same file (size and date), the same Stroq and the same keys (`key-index.ts`), is not checked
// again. A transcript past the replay's size limit is not checked and is counted as too large, as the
// replay counts it. What the budget does not reach is counted and said, and the next run goes on from
// what was kept. Every number here is of the sessions checked, never an estimate for the rest.
import { stoppedFindings } from '../sent/report.js';
import type { Finding, SessionKeySummary } from '../sent/findings.js';
import { keyFinder, loadKeys, type KeyFinder } from '../sent/keys.js';
import { loadMcpServers } from '../sent/mcp-config.js';
import { projectDirs } from '../sent/run.js';
import { withSessionCanaries } from '../sent/session-canaries.js';
import { canaryNotes, type CanaryNotes } from './canary-memory.js';
import type { CardJob } from './jobs.js';
import type { KeyAnswer } from './key-job.js';
import { indexDigest, newSalt, prepareIndex, type PreparedIndex } from './key-index.js';
import { registerKeyIndex } from './key-registry.js';
import { fitsKept, findingsOf, sanitizeKeys, summaryOf } from './key-result.js';
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
}

/** What the key check of a run came to. */
export interface KeyOutcome {
  readonly findings: readonly Finding[];
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
  const finder = keyFinder(loaded.keys);
  const scrub = scrubber(finder);
  const checkable = sessions.map((s) => !isTooLarge(s));
  if (loaded.keys.length === 0) return nothingToLookFor(scrub, checkable);

  const mcp = loadMcpServers({ home: env.home, projectDirs: dirs });
  const index = prepareIndex({ home: env.home, keys: loaded.keys, mcp: [...mcp.known] });
  const salt = cache.salt ?? newSalt();
  const digest = indexDigest(index, salt);
  const kept = entriesUnder(cache, digest);
  registerKeyIndex({ digest, data: index.data });
  return new Run({ env, sessions, finder, scrub, index, salt, digest, kept, checkable, notes });
}

/** A machine that holds no key to look for: every session that can be checked is, at once. */
function nothingToLookFor(scrub: Scrub, checkable: readonly boolean[]): KeysRun {
  const checked = checkable.filter(Boolean).length;
  return {
    scrub,
    jobFor: () => null,
    accept: () => undefined,
    finish: () => ({
      findings: [],
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
  readonly env: KeysEnv;
  readonly sessions: readonly WindowSession[];
  readonly finder: KeyFinder;
  readonly scrub: Scrub;
  readonly index: PreparedIndex;
  readonly salt: string;
  readonly digest: string;
  readonly kept: ReadonlyMap<string, KeyCacheEntry>;
  readonly checkable: readonly boolean[];
  readonly notes: CanaryNotes;
}

class Run implements KeysRun {
  readonly scrub: Scrub;
  /** What each session came to: kept or answered, by place in the window. */
  private readonly results = new Map<number, SessionKeys>();
  private readonly fromCache = new Set<number>();
  private readonly unreadable = new Set<number>();
  private readonly fresh = new Map<number, SessionKeys>();
  private incomplete = 0;

  constructor(private readonly p: RunParts) {
    this.scrub = p.scrub;
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
    const summaries: SessionKeySummary[] = [];
    sessions.forEach((s, i) => {
      const result = this.results.get(i);
      if (result === undefined) return;
      summaries.push(
        summaryOf(result, index.indexOf, { agent: s.agent, id: '', path: s.path, cwd: s.cwd }),
      );
    });
    const findings = findingsOf(index.data.keys, finder, summaries);
    const saved = this.save();
    registerKeyIndex(null);
    const checkable = this.p.checkable.filter(Boolean).length;
    return {
      findings,
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
    if (this.fresh.size === 0 && !this.p.notes.changed()) return true;
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
