import { expect, vi } from 'vitest';
import { buildCard, type BuildEnv } from '../../src/card/build.js';
import type { CardJob, CardResult } from '../../src/card/jobs.js';
import type { Channel } from '../../src/card/pool.js';
import { inProcessChannel } from '../../src/card/worker.js';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Expire the real pool's budget only after exactly `count` key results have arrived. */
export async function partialKeys(count: number, run: BuildEnv) {
  let taken = 0;
  let completed = 0;
  let stalled = 0;
  const pending = new Set<number>();
  let ready = () => {};
  const settled = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const check = () => {
    if (stalled > 0 && pending.size === 0) ready();
  };
  const open = (): Channel<CardJob, CardResult> => {
    const real = (run.open ?? inProcessChannel)();
    return {
      ...real,
      send: (id, job) => {
        if (job.kind === 'keys' && ++taken > count) {
          stalled += 1;
          check();
          return;
        }
        pending.add(id);
        real.send(id, job);
      },
      onMessage: (callback) =>
        real.onMessage((id, result) => {
          pending.delete(id);
          if (result.kind === 'keys') completed += 1;
          callback(id, result);
          check();
        }),
    };
  };

  // File reads and the wall/performance clocks stay real. Only the pool's budget/grace
  // timers are advanced; a slow CI worker cannot consume the intended partial fixture first.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const building = buildCard(30, { ...run, budgetMs: 1_000, graceMs: 100, workers: 1, open });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      building.then(() => {
        throw new Error('Partial key check finished before the channel stalled');
      }),
      new Promise<never>((_, reject) => {
        watchdog = realSetTimeout(
          () =>
            reject(
              new Error(
                `Partial key check did not settle: completed=${completed}, stalled=${stalled}, pending=${pending.size}`,
              ),
            ),
          5_000,
        );
      }),
    ]);
    await vi.runAllTimersAsync();
    const partial = await building;
    expect(partial.coverage).toMatchObject({
      keys: 'not-finished',
      keysChecked: count,
      keysFromCache: 0,
      keysIncomplete: 0,
      cacheSaved: true,
    });
    return partial;
  } finally {
    realClearTimeout(watchdog);
    try {
      await vi.runAllTimersAsync();
    } finally {
      try {
        vi.runAllTimers();
      } finally {
        vi.useRealTimers();
        // A delayed file read may not have registered the pool timers yet. Never wait
        // for it with a frozen clock; its eventual timers must run on the real clock.
        void building.catch(() => undefined);
      }
    }
  }
}
