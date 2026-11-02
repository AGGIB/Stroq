import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCard,
  defaultBudgetMs,
  defaultGraceMs,
  BUDGET_MS,
  type BuildEnv,
} from '../../src/card/build.js';
import { handleJob, type CardJob, type CardResult } from '../../src/card/jobs.js';
import type { Channel } from '../../src/card/pool.js';
import { renderCard, WIDTH } from '../../src/card/render.js';
import { readSessionCache } from '../../src/card/store.js';
import { cardSessionsFileIn } from '../../src/paths.js';
import {
  ago,
  bash,
  claudeSession,
  DAY,
  furnish,
  machine,
  populate,
  type Machine,
} from './machine.js';

/**
 * One transcript whose replay never finishes must cost the next runs nothing: the first run to meet it
 * notes that it ran out of time on that exact file, and the runs after it do not wait. Every value is made up.
 */

let m: Machine;
beforeEach(() => {
  m = machine();
  furnish(m);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const env = (over: Partial<BuildEnv> = {}): BuildEnv => ({
  home: m.home,
  env: process.env,
  stroqHome: m.stroqHome,
  cwd: m.work,
  now: new Date(),
  version: '0.29.0',
  workers: 1,
  budgetMs: 2_000,
  graceMs: 100,
  ...over,
});

/**
 * A worker that does one job at a time and says when it begins each, and that never finishes the replay
 * of `stuck`: whatever is behind it waits, as behind a real one.
 */
function stuckOn(stuck: string, log: CardJob[] = []): () => Channel<CardJob, CardResult> {
  return () => {
    let message: (id: number, result: CardResult) => void = () => undefined;
    let began: (id: number) => void = () => undefined;
    let closed = false;
    let chain: Promise<void> = Promise.resolve();
    return {
      send(id, job) {
        chain = chain.then(async () => {
          if (closed) return;
          began(id);
          log.push(job);
          if (job.kind === 'session' && job.path === stuck) await new Promise(() => undefined);
          const result = await handleJob(job);
          if (!closed) message(id, result);
        });
      },
      onMessage: (callback) => {
        message = callback;
      },
      onStart: (callback) => {
        began = callback;
      },
      onFailure: () => undefined,
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
  };
}

const replays = (log: readonly CardJob[]): string[] =>
  log.flatMap((j) => (j.kind === 'session' ? [j.path] : []));

/** The newest session of the machine: the first one a run starts, and the one that never finishes. */
function withStuckSession(): string {
  populate(m);
  return claudeSession(m, {
    id: 'stuck',
    at: ago(DAY / 4),
    calls: [bash('make'), bash('make test')],
  });
}

describe('a replay that runs out the time', () => {
  it('is noted as too slow, and the sessions behind it as not yet checked', async () => {
    const stuck = withStuckSession();
    const first = await buildCard(30, env({ open: stuckOn(stuck) }));
    expect(first.coverage).toMatchObject({ found: 5, tooSlow: 1, checked: 0 });
    // The ones held behind it were only waiting: they are not blamed, and a later run does them.
    expect(first.coverage.notChecked).toBe(4);
    const kept = readSessionCache(m.stroqHome);
    const entries = [...kept.values()];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ unfinished: true, budgetMs: 2_000 });
  });

  it('is not waited for in the runs after it, which go on with the others', async () => {
    const stuck = withStuckSession();
    await buildCard(30, env({ open: stuckOn(stuck) }));
    const log: CardJob[] = [];
    const started = Date.now();
    const again = await buildCard(30, env({ open: stuckOn(stuck, log) }));
    // Not waited for: no replay of it was sent, and the run did not sit out its time.
    expect(replays(log)).not.toContain(stuck);
    expect(Date.now() - started).toBeLessThan(1_900);
    expect(again.coverage).toMatchObject({ tooSlow: 1, notChecked: 0, checked: 4 });
    expect(again.counts.commands).toBe(5);
  });

  it('says so on the card, once, in plain words', async () => {
    const stuck = withStuckSession();
    await buildCard(30, env({ open: stuckOn(stuck) }));
    const again = await buildCard(30, env({ open: stuckOn(stuck) }));
    const lines = renderCard(again, m.home);
    const said = lines.filter((l) => l.includes('could not be checked in time'));
    expect(said).toEqual(['1 session could not be checked in time.']);
    for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(WIDTH);
  });

  it('is tried again when the file changes', async () => {
    const stuck = withStuckSession();
    await buildCard(30, env({ open: stuckOn(stuck) }));
    writeFileSync(stuck, `${readFileSync(stuck, 'utf8')}\n`);
    const when = new Date(Date.now() - DAY / 8);
    utimesSync(stuck, when, when);
    const log: CardJob[] = [];
    await buildCard(30, env({ budgetMs: 5_000, open: stuckOn('/none', log) }));
    expect(replays(log)).toContain(stuck);
  });

  it('is tried again by a run that is given more time than it had', async () => {
    const stuck = withStuckSession();
    await buildCard(30, env({ open: stuckOn(stuck) }));
    const same: CardJob[] = [];
    await buildCard(30, env({ open: stuckOn('/none', same) }));
    expect(replays(same)).not.toContain(stuck);
    const more: CardJob[] = [];
    await buildCard(30, env({ budgetMs: 4_000, open: stuckOn('/none', more) }));
    expect(replays(more)).toContain(stuck);
  });

  it('is the replay of the session that ran out the time, not of one that only waited', async () => {
    const stuck = withStuckSession();
    const log: CardJob[] = [];
    await buildCard(30, env({ open: stuckOn(stuck, log) }));
    const next: CardJob[] = [];
    await buildCard(30, env({ open: stuckOn(stuck, next) }));
    // The four that waited behind it were replayed.
    expect(replays(next)).toHaveLength(4);
  });

  it('keeps the unfinished note out of the JSON file of a machine where nothing was cut off', async () => {
    populate(m);
    const data = await buildCard(30, env({ budgetMs: 5_000 }));
    expect(data.coverage.tooSlow).toBe(0);
    expect(readFileSync(cardSessionsFileIn(m.stroqHome), 'utf8')).not.toContain('unfinished');
  });
});

describe('the time a run is given', () => {
  it('is the default, or the number STROQ_CARD_BUDGET_MS names from 200 ms to ten minutes', () => {
    expect(defaultBudgetMs(undefined)).toBe(BUDGET_MS);
    expect(defaultBudgetMs('3000')).toBe(3_000);
    expect(defaultBudgetMs('199')).toBe(BUDGET_MS);
    expect(defaultBudgetMs('600001')).toBe(BUDGET_MS);
    expect(defaultBudgetMs('3s')).toBe(BUDGET_MS);
    expect(defaultBudgetMs('')).toBe(BUDGET_MS);
  });

  it('lets a job already begun go on for the pool default, or STROQ_CARD_GRACE_MS', () => {
    expect(defaultGraceMs(undefined)).toBeUndefined();
    expect(defaultGraceMs('500')).toBe(500);
    expect(defaultGraceMs('nonsense')).toBeUndefined();
  });
});
