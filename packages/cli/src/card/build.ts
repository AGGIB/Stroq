// One run of the card: find the sessions of the last N days, count what a text told the agent to run,
// look for keys that went out and for folders that run code on open, and rank what is worth a look.
//
// The work is split in jobs for a pool of workers (`pool.ts`, `jobs.ts`): the folder check is one job,
// and each transcript is up to two more, newest first: its replay (when it is not already summed up in
// the cache) and its key check (when its result is not kept; `keys-run.ts`). What the caches hold is keyed
// by the file's size and date and Stroq's version, and by the policy the replay was judged under or the
// keys the check looked for, so a changed transcript, a new version, a new policy or a new key checks it
// again. After `budgetMs` no job is started; what was not reached is counted and said, and the next run
// continues from the caches.
import { statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { loadPolicyWithSource } from '../engine-factory.js';
import { CARD_SCHEMA, KEPT, type CardCounts, type CardData } from './data.js';
import type { CardJob, CardResult } from './jobs.js';
import { buildMoments, type ToldInput } from './moments.js';
import { runPool, type Channel } from './pool.js';
import type { AutorunResult } from './autorun.js';
import { startKeys, type KeyOutcome } from './keys-run.js';
import { scrubSummary } from './scrub.js';
import {
  lookupSummary,
  lookupUnfinished,
  saveReplays,
  type ReplayCacheKeys,
} from './replay-cache.js';
import type { SessionSummary } from './schema.js';
import { readSessionCache } from './store.js';
import { isTooLarge, listWindow, windowStart, type WindowSession } from './window.js';
import { withinWindow } from './within.js';
import { openChannel } from './worker.js';

/** After this long no job is started (the card should answer in about this time on a cold machine). */
export const BUDGET_MS = 25_000;
const MIN_BUDGET_MS = 200;
const MAX_BUDGET_MS = 600_000;

/** `named` as whole milliseconds from `MIN_BUDGET_MS` to `MAX_BUDGET_MS`, or null when it is not. */
function millisFrom(named: string | undefined): number | null {
  if (named === undefined || !/^\d{1,7}$/.test(named)) return null;
  const ms = Number(named);
  return ms >= MIN_BUDGET_MS && ms <= MAX_BUDGET_MS ? ms : null;
}

/** How long jobs may start: `STROQ_CARD_BUDGET_MS` (200 to 600000) when it is set, for measuring. */
export const defaultBudgetMs = (
  named: string | undefined = process.env['STROQ_CARD_BUDGET_MS'],
): number => millisFrom(named) ?? BUDGET_MS;

/** How long a job already started may go on after that: `STROQ_CARD_GRACE_MS`, else the pool's own. */
export const defaultGraceMs = (
  named: string | undefined = process.env['STROQ_CARD_GRACE_MS'],
): number | undefined => millisFrom(named) ?? undefined;
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

/**
 * `min(6, cpus - 1)`, and at least one; `STROQ_CARD_WORKERS` (1 to 16) names another number, for
 * a machine where more threads do not help or for measuring.
 */
export function defaultWorkers(
  cpus: number = availableParallelism(),
  named: string | undefined = process.env['STROQ_CARD_WORKERS'],
): number {
  const asked = named !== undefined && /^\d{1,2}$/.test(named) ? Number(named) : 0;
  if (asked >= 1 && asked <= 16) return asked;
  return Math.max(1, Math.min(6, cpus - 1));
}

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
  readonly tooSlow: number;
  readonly unreadable: number;
  readonly keys: KeyOutcome;
  readonly folders: AutorunResult;
  readonly cacheSaved: boolean;
}

export async function buildCard(days: number, run: BuildEnv): Promise<CardData> {
  const started = Date.now();
  const budget = run.budgetMs ?? defaultBudgetMs();
  const grace = run.graceMs ?? defaultGraceMs();
  const listing = await listWindow(run.home, run.env, days, run.now);
  const since = windowStart(days, run.now);
  const sessions = listing.sessions;
  const policy = loadPolicyWithSource().source.sha256;
  const cache = readSessionCache(run.stroqHome);
  // The keys this machine holds, in this thread and the workers only: the check looks for them, and
  // anything the card keeps is cleaned of them.
  const keys = startKeys(
    {
      home: run.home,
      env: run.env,
      stroqHome: run.stroqHome,
      cwd: run.cwd,
      version: run.version,
      since,
    },
    sessions,
  );
  const keysReadyAt = Date.now();
  // What a kept summary depends on: the version, the policy and the keys of this run, and the file.
  const kept: ReplayCacheKeys = {
    version: run.version,
    policy,
    keys: keys.digest,
    scrub: keys.scrub,
  };

  // Every kept summary is cleaned of today's keys before it is used.
  const summaries: (SessionSummary | undefined)[] = sessions.map(
    (s) => lookupSummary(cache, s, kept) ?? undefined,
  );
  const fromCache = summaries.filter((s) => s !== undefined).length;
  const tooLarge = sessions.filter((s, i) => summaries[i] === undefined && isTooLarge(s)).length;
  // Replays an earlier run gave up on for want of time, for these exact files: not waited for again.
  const tooSlow = new Set<number>();
  sessions.forEach((s, i) => {
    if (summaries[i] === undefined && !isTooLarge(s) && lookupUnfinished(cache, s, kept, budget))
      tooSlow.add(i);
  });

  const { dirs, total: folderTotal } = sessionFolders(sessions, run.home);
  const jobs: CardJob[] = [];
  const kinds: ('repos' | { session: number } | { keys: number })[] = [];
  if (dirs.length > 0) {
    jobs.push({ kind: 'repos', dirs, stopAt: started + budget - FOLDER_MARGIN_MS });
    kinds.push('repos');
  }
  // Newest first, a session's replay and then its key check: when the time is up, both halves of the
  // card stop at about the same session.
  sessions.forEach((session, index) => {
    if (summaries[index] === undefined && !isTooLarge(session) && !tooSlow.has(index)) {
      jobs.push({ kind: 'session', agent: session.agent, path: session.path });
      kinds.push({ session: index });
    }
    const keyJob = keys.jobFor(index);
    if (keyJob !== null) {
      jobs.push(keyJob);
      kinds.push({ keys: index });
    }
  });

  let folders = ZERO_FOLDERS;
  const fresh = new Map<number, SessionSummary>();
  /** Sessions (by place in the window) that could not be read, in either half. */
  const unreadable = new Set<number>();
  let done = 0;
  let lastKeyAt = 0;
  let lastReplayAt = 0;
  const workers = run.workers ?? defaultWorkers();
  const outcome = await runPool<CardJob, CardResult>(jobs, {
    size: workers,
    open: run.open ?? openChannel,
    stopStartingAfterMs: budget,
    ...(grace === undefined ? {} : { graceMs: grace }),
    onResult: (job, result) => {
      const kind = kinds[job];
      if (result.kind === 'repos') folders = result.result;
      else if (result.kind === 'keys' && kind !== undefined && typeof kind === 'object') {
        lastKeyAt = Date.now();
        keys.accept((kind as { keys: number }).keys, result.answer);
      } else if (result.kind === 'session' && kind !== undefined && typeof kind === 'object') {
        done += 1;
        lastReplayAt = Date.now();
        run.progress?.(fromCache + done, sessions.length);
        const at = (kind as { session: number }).session;
        if (result.summary === null) unreadable.add(at);
        else fresh.set(at, scrubSummary(result.summary, keys.scrub));
      }
    },
  });

  for (const [index, summary] of fresh) summaries[index] = summary;
  const replayJob = (job: number): number | null => {
    const kind = kinds[job];
    return typeof kind === 'object' && 'session' in kind ? kind.session : null;
  };
  const keyJob = (job: number): number | null => {
    const kind = kinds[job];
    return typeof kind === 'object' && 'keys' in kind ? kind.keys : null;
  };
  const replays = (list: readonly number[]): number[] =>
    list.map(replayJob).filter((at): at is number => at !== null);
  // A replay a worker had begun and did not finish is the one that ran out the time; those held behind
  // it were only waiting, and are tried again next run. The first is kept as unfinished for this file.
  const cutOff = new Map<number, number>();
  for (const at of replays(outcome.ran)) cutOff.set(at, budget);
  for (const at of cutOff.keys()) tooSlow.add(at);
  const waiting = outcome.unfinished.filter((job) => !outcome.ran.includes(job));
  const notChecked = replays([...outcome.notStarted, ...waiting]).length;
  for (const at of replays(outcome.failed)) unreadable.add(at);
  for (const job of outcome.failed) {
    const at = keyJob(job);
    if (at !== null) keys.accept(at, null);
  }
  const mergeStarted = Date.now();
  const keyOutcome = keys.finish();
  const keysMs =
    (lastKeyAt === 0 ? keysReadyAt : lastKeyAt) - started + (Date.now() - mergeStarted);
  for (const at of keyOutcome.unreadable) unreadable.add(at);
  const cacheSaved =
    saveReplays(run.stroqHome, cache, kept, { sessions, fresh, cutOff }) && keyOutcome.saved;
  return assemble(
    days,
    run,
    {
      summaries,
      fromCache,
      replayed: fresh.size,
      notChecked,
      tooSlow: tooSlow.size,
      unreadable: unreadable.size,
      keys: keyOutcome,
      folders,
      cacheSaved,
    },
    {
      listing,
      tooLarge,
      folderTotal,
      started,
      workers,
      keysMs,
      replayMs: lastReplayAt === 0 ? 0 : lastReplayAt - started,
      name: keys.name,
      id: keys.id,
    },
  );
}

interface Context {
  readonly listing: Awaited<ReturnType<typeof listWindow>>;
  readonly tooLarge: number;
  readonly folderTotal: number;
  readonly started: number;
  readonly workers: number;
  readonly keysMs: number;
  readonly replayMs: number;
  /** A name from a session (a folder, a path) as it may be shown, and a session's id. */
  readonly name: (text: string) => string;
  readonly id: (text: string) => string;
}

function assemble(days: number, run: BuildEnv, got: Gathered, ctx: Context): CardData {
  const sessions = ctx.listing.sessions;
  const counted = got.summaries.filter((s): s is SessionSummary => s !== undefined);
  // Only what happened inside the window, by the time of each event and not by the date of its file.
  const since = windowStart(days, run.now);
  const inside = counted.map((s) => withinWindow(s, since));
  const told: ToldInput[] = [];
  got.summaries.forEach((summary, i) => {
    const session = sessions[i];
    if (summary === undefined || session === undefined) return;
    for (const moment of withinWindow(summary, since).moments)
      told.push({
        moment,
        // A folder or a file named with a key would print it: the rule of the key findings'.
        session: {
          agent: session.agent,
          id: ctx.id(summary.sessionId),
          path: ctx.name(session.path),
          cwd: session.cwd === null ? null : ctx.name(session.cwd),
        },
      });
  });
  const findings = got.keys.findings;
  const moments = buildMoments({ told, findings, repos: got.folders.repos, home: run.home });
  const counts: CardCounts = {
    commands: inside.reduce((sum, s) => sum + s.commands, 0),
    toldByText: inside.reduce((sum, s) => sum + s.told, 0),
    keysSent: findings.filter((f) => f.tier === 'third_party').length,
    keysStopped: got.keys.stopped,
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
      tooSlow: got.tooSlow,
      tooLarge: ctx.tooLarge,
      unreadable: got.unreadable,
      older: ctx.listing.older,
      keys:
        sessions.length === 0
          ? 'no-sessions'
          : got.keys.notChecked > 0
            ? 'not-finished'
            : 'checked',
      keysChecked: got.keys.checked,
      keysFromCache: got.keys.fromCache,
      keysNotChecked: got.keys.notChecked,
      keysIncomplete: got.keys.incomplete,
      folders: {
        found: ctx.folderTotal,
        checked: got.folders.checked,
        capped: ctx.folderTotal > MAX_FOLDERS,
      },
      looked: ctx.listing.looked,
      cacheSaved: got.cacheSaved,
    },
    timing: {
      totalMs: Date.now() - ctx.started,
      replayed: got.replayed,
      workers: ctx.workers,
      replayMs: ctx.replayMs,
      keysMs: ctx.keysMs,
    },
  };
}
