// One run of the card: find the sessions of the last N days, count what a text told the agent to run,
// look for keys that went out and for folders that run code on open, and rank what is worth a look.
//
// The work is split in jobs for a pool of workers (`pool.ts`, `jobs.ts`): the key check is one job, the
// folder check another, and each transcript that is not already summed up in the cache is one more,
// newest first. What the cache holds is keyed by the file's size and date, Stroq's version and the policy
// the replay was judged under, so a changed transcript, a new version or a new policy checks it again.
// After `budgetMs` no job is started; what was not reached is counted and said, and the next run
// continues from the cache.
import { statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { loadPolicyWithSource } from '../engine-factory.js';
import { keyFinder, loadKeys } from '../sent/keys.js';
import { projectDirs } from '../sent/run.js';
import type { SentReport } from '../sent/report.js';
import { stoppedTowardOthers } from '../sent/report.js';
import { CARD_SCHEMA, KEPT, type CardCounts, type CardData } from './data.js';
import type { CardJob, CardResult } from './jobs.js';
import { buildMoments, type ToldInput } from './moments.js';
import { runPool, type Channel } from './pool.js';
import type { AutorunResult } from './autorun.js';
import { scrubber, scrubSummary } from './scrub.js';
import type { CacheEntry, SessionSummary } from './schema.js';
import { cacheKey, cachedSummary, readSessionCache, writeSessionCache } from './store.js';
import { isTooLarge, listWindow, type WindowSession } from './window.js';
import { openChannel } from './worker.js';

/** After this long no job is started (the card should answer in about this time on a cold machine). */
export const BUDGET_MS = 25_000;
/** The most session folders looked at for code that runs on open. */
export const MAX_FOLDERS = 150;
/** Left for the folder check after the budget: it stops starting folders a little before the end. */
const FOLDER_MARGIN_MS = 2_000;

export interface BuildEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stroqHome: string;
  readonly cwd: string;
  readonly now: Date;
  readonly version: string;
  /** Called as sessions are checked, for a progress line. */
  readonly progress?: (done: number, total: number) => void;
  /** How long jobs may start; `BUDGET_MS`. */
  readonly budgetMs?: number;
  /** How long a job already started may go on after that. */
  readonly graceMs?: number;
  /** Workers; the default is `min(6, cpus - 1)`, at least 1. */
  readonly workers?: number;
  /** Opens a worker; the default is a thread when the bundle can start one. */
  readonly open?: () => Channel<CardJob, CardResult>;
}

/** `min(6, cpus - 1)`, and at least one. */
export const defaultWorkers = (cpus: number = availableParallelism()): number =>
  Math.max(1, Math.min(6, cpus - 1));

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The distinct folders the sessions ran in that still exist, newest first, home itself left out. */
export function sessionFolders(
  sessions: readonly WindowSession[],
  home: string,
): { readonly dirs: string[]; readonly total: number } {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const s of sessions) {
    const dir = s.cwd;
    if (dir === null || dir === '' || dir === home || seen.has(dir)) continue;
    seen.add(dir);
    if (isDirectory(dir)) dirs.push(dir);
  }
  return { dirs: dirs.slice(0, MAX_FOLDERS), total: dirs.length };
}

const ZERO_FOLDERS: AutorunResult = { repos: [], checked: 0, total: 0 };

/** Everything the run found, before it is ranked. */
interface Gathered {
  readonly summaries: readonly (SessionSummary | undefined)[];
  readonly fromCache: number;
  readonly replayed: number;
  readonly notChecked: number;
  readonly unreadable: number;
  readonly sent: SentReport | null;
  readonly folders: AutorunResult;
  readonly cacheSaved: boolean;
}

export async function buildCard(days: number, run: BuildEnv): Promise<CardData> {
  const started = Date.now();
  const budget = run.budgetMs ?? BUDGET_MS;
  const listing = await listWindow(run.home, run.env, days, run.now);
  const sessions = listing.sessions;
  const policy = loadPolicyWithSource().source.sha256;
  const cache = readSessionCache(run.stroqHome);
  const keyOf = (s: WindowSession): string =>
    cacheKey({ bytes: s.bytes, mtimeMs: s.mtimeMs, version: run.version, policy });

  const summaries: (SessionSummary | undefined)[] = sessions.map(
    (s) => cachedSummary(cache, s.path, keyOf(s)) ?? undefined,
  );
  const fromCache = summaries.filter((s) => s !== undefined).length;
  const tooLarge = sessions.filter((s, i) => summaries[i] === undefined && isTooLarge(s)).length;
  const pending = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session, index }) => summaries[index] === undefined && !isTooLarge(session));

  const { dirs, total: folderTotal } = sessionFolders(sessions, run.home);
  const jobs: CardJob[] = [];
  const kinds: ('sent' | 'repos' | { session: number })[] = [];
  if (sessions.length > 0) {
    jobs.push({
      kind: 'sent',
      refs: sessions.map((s) => s.ref),
      home: run.home,
      cwd: run.cwd,
      stroqHome: run.stroqHome,
      now: run.now.getTime(),
    });
    kinds.push('sent');
  }
  if (dirs.length > 0) {
    jobs.push({ kind: 'repos', dirs, stopAt: started + budget - FOLDER_MARGIN_MS });
    kinds.push('repos');
  }
  for (const { session, index } of pending) {
    jobs.push({ kind: 'session', agent: session.agent, path: session.path });
    kinds.push({ session: index });
  }

  // The keys this machine holds, in this thread only, to take any of them out of what is kept.
  const scrub = scrubber(
    keyFinder(
      loadKeys({
        home: run.home,
        env: run.env,
        projectDirs: projectDirs(
          run.cwd,
          sessions.map((s) => s.ref),
        ),
        stroqHome: run.stroqHome,
      }).keys,
    ),
  );

  let sent: SentReport | null = null;
  let folders = ZERO_FOLDERS;
  const fresh = new Map<number, SessionSummary>();
  let unreadable = 0;
  let done = 0;
  const workers = run.workers ?? defaultWorkers();
  const outcome = await runPool<CardJob, CardResult>(jobs, {
    size: workers,
    open: run.open ?? openChannel,
    stopStartingAfterMs: budget,
    ...(run.graceMs === undefined ? {} : { graceMs: run.graceMs }),
    onResult: (job, result) => {
      const kind = kinds[job];
      if (result.kind === 'sent') sent = result.report;
      else if (result.kind === 'repos') folders = result.result;
      else if (result.kind === 'session' && kind !== undefined && typeof kind === 'object') {
        done += 1;
        run.progress?.(fromCache + done, sessions.length);
        if (result.summary === null) unreadable += 1;
        else fresh.set(kind.session, scrubSummary(result.summary, scrub));
      }
    },
  });

  for (const [index, summary] of fresh) summaries[index] = summary;
  const isSession = (job: number): boolean => typeof kinds[job] === 'object';
  const notChecked = [...outcome.notStarted, ...outcome.unfinished].filter(isSession).length;
  const lost = outcome.failed.filter(isSession).length;
  const cacheSaved = saveCache(run.stroqHome, cache, sessions, keyOf, fresh);
  return assemble(
    days,
    run,
    {
      summaries,
      fromCache,
      replayed: fresh.size,
      notChecked,
      unreadable: unreadable + lost,
      sent,
      folders,
      cacheSaved,
    },
    { listing, tooLarge, folderTotal, started, workers },
  );
}

/** Keeps the new summaries with the old; false when the cache could not be written. */
function saveCache(
  stroqHome: string,
  old: ReadonlyMap<string, CacheEntry>,
  sessions: readonly WindowSession[],
  keyOf: (s: WindowSession) => string,
  fresh: ReadonlyMap<number, SessionSummary>,
): boolean {
  if (fresh.size === 0) return true;
  const next = new Map(old);
  for (const [index, summary] of fresh) {
    const session = sessions[index] as WindowSession;
    next.set(session.path, { key: keyOf(session), mtimeMs: session.mtimeMs, summary });
  }
  try {
    writeSessionCache(stroqHome, next);
    return true;
  } catch {
    return false;
  }
}

interface Context {
  readonly listing: Awaited<ReturnType<typeof listWindow>>;
  readonly tooLarge: number;
  readonly folderTotal: number;
  readonly started: number;
  readonly workers: number;
}

function assemble(days: number, run: BuildEnv, got: Gathered, ctx: Context): CardData {
  const sessions = ctx.listing.sessions;
  const counted = got.summaries.filter((s): s is SessionSummary => s !== undefined);
  const told: ToldInput[] = [];
  got.summaries.forEach((summary, i) => {
    const session = sessions[i];
    if (summary === undefined || session === undefined) return;
    for (const moment of summary.moments)
      told.push({
        moment,
        session: {
          agent: session.agent,
          id: summary.sessionId,
          path: session.path,
          cwd: session.cwd,
        },
      });
  });
  const findings = got.sent?.findings ?? [];
  const moments = buildMoments({ told, findings, repos: got.folders.repos, home: run.home });
  const counts: CardCounts = {
    commands: counted.reduce((sum, s) => sum + s.commands, 0),
    toldByText: counted.reduce((sum, s) => sum + s.told, 0),
    keysSent: findings.filter((f) => f.tier === 'third_party').length,
    keysStopped: got.sent === null ? 0 : stoppedTowardOthers(got.sent),
    keysSeen: findings.filter((f) => f.tier === 'seen').length,
    autorunRepos: got.folders.repos.length,
  };
  return {
    schema: CARD_SCHEMA,
    version: run.version,
    generated: run.now.toISOString(),
    days,
    counts,
    moments: moments.slice(0, KEPT),
    coverage: {
      found: sessions.length,
      agents: {
        claudeCode: sessions.filter((s) => s.agent === 'claude-code').length,
        codex: sessions.filter((s) => s.agent === 'codex').length,
      },
      checked: counted.length,
      fromCache: got.fromCache,
      notChecked: got.notChecked,
      tooLarge: ctx.tooLarge,
      unreadable: got.unreadable,
      older: ctx.listing.older,
      keys: sessions.length === 0 ? 'no-sessions' : got.sent === null ? 'not-finished' : 'checked',
      folders: {
        found: ctx.folderTotal,
        checked: got.folders.checked,
        capped: ctx.folderTotal > MAX_FOLDERS,
      },
      looked: ctx.listing.looked,
      cacheSaved: got.cacheSaved,
    },
    timing: { totalMs: Date.now() - ctx.started, replayed: got.replayed, workers: ctx.workers },
  };
}
