import { describe, expect, it } from 'vitest';
import { runPool, type Channel } from '../../src/card/pool.js';

/** A channel that runs jobs in this process, a little later, as a worker does. */
function inProcess<J, R>(
  run: (job: J) => Promise<R>,
  hooks: { fail?: (job: J) => boolean } = {},
): () => Channel<J, R> {
  return () => {
    let message: (id: number, result: R) => void = () => undefined;
    let failure: (reason: string) => void = () => undefined;
    let closed = false;
    return {
      send(id, job) {
        setTimeout(() => {
          if (closed) return;
          if (hooks.fail?.(job) === true) {
            failure('boom');
            return;
          }
          void run(job).then((result) => {
            if (!closed) message(id, result);
          });
        }, 0);
      },
      onMessage: (callback) => {
        message = callback;
      },
      onFailure: (callback) => {
        failure = callback;
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
  };
}

describe('runPool', () => {
  it('gives the results in the order of the jobs, whatever finishes first', async () => {
    const jobs = [30, 1, 20, 2, 10, 3, 5];
    const outcome = await runPool<number, string>(jobs, {
      size: 3,
      open: inProcess(async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return `done ${ms}`;
      }),
    });
    expect(outcome.results).toEqual(jobs.map((ms) => `done ${ms}`));
    expect(outcome.failed).toEqual([]);
    expect(outcome.notStarted).toEqual([]);
    expect(outcome.unfinished).toEqual([]);
  });

  it('gives the same results with one worker and with many', async () => {
    const jobs = Array.from({ length: 40 }, (_, i) => i);
    const square = (n: number): Promise<number> => Promise.resolve(n * n);
    const one = await runPool(jobs, { size: 1, open: inProcess(square) });
    const many = await runPool(jobs, { size: 6, open: inProcess(square) });
    expect(many.results).toEqual(one.results);
    expect(one.results).toEqual(jobs.map((n) => n * n));
  });

  it('is done at once with no jobs', async () => {
    const outcome = await runPool<number, number>([], {
      size: 4,
      open: inProcess((n: number) => Promise.resolve(n)),
    });
    expect(outcome.results).toEqual([]);
  });

  it('reports each result as it arrives', async () => {
    const seen: [number, string][] = [];
    await runPool<string, string>(['a', 'b', 'c'], {
      size: 2,
      open: inProcess((s: string) => Promise.resolve(s.toUpperCase())),
      onResult: (index, result) => seen.push([index, result]),
    });
    expect(seen.sort()).toEqual([
      [0, 'A'],
      [1, 'B'],
      [2, 'C'],
    ]);
  });

  it('starts no job after the time is up, waits a little for those in flight, and says what is left', async () => {
    // Jobs 0 and 1 are fast; job 2 never ends; jobs 3.. wait behind it.
    const outcome = await runPool<number, number>([0, 1, 2, 3, 4, 5], {
      size: 1,
      depth: 1,
      stopStartingAfterMs: 30,
      graceMs: 30,
      open: inProcess((n: number) =>
        n === 2 ? new Promise<number>(() => undefined) : Promise.resolve(n),
      ),
    });
    expect(outcome.results.slice(0, 2)).toEqual([0, 1]);
    expect(outcome.unfinished).toEqual([2]);
    expect(outcome.notStarted).toEqual([3, 4, 5]);
  });

  it('does not wait for the grace when every job in flight has finished', async () => {
    const started = Date.now();
    const outcome = await runPool<number, number>([1, 2], {
      size: 1,
      stopStartingAfterMs: 20,
      graceMs: 5_000,
      open: inProcess(async (n: number) => {
        await new Promise((r) => setTimeout(r, 40));
        return n;
      }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(
      outcome.results.filter((r) => r !== undefined).length + outcome.notStarted.length,
    ).toBeGreaterThan(0);
  });

  it('fails the jobs of a worker that dies and goes on with a new one', async () => {
    const outcome = await runPool<number, number>([1, 2, 3, 4, 5, 6], {
      size: 1,
      depth: 1,
      open: inProcess((n: number) => Promise.resolve(n * 10), { fail: (n) => n === 3 }),
    });
    expect(outcome.failed).toEqual([2]);
    expect(outcome.results).toEqual([10, 20, undefined, 40, 50, 60]);
  });

  it('gives up when every worker keeps dying, and leaves the rest not started', async () => {
    const lost: string[] = [];
    const outcome = await runPool<number, number>([1, 2, 3, 4, 5, 6, 7, 8], {
      size: 1,
      depth: 1,
      onWorkerLost: (why) => lost.push(why),
      open: inProcess((n: number) => Promise.resolve(n), { fail: () => true }),
    });
    expect(lost.length).toBeGreaterThan(1);
    expect(outcome.results.every((r) => r === undefined)).toBe(true);
    expect(outcome.failed.length + outcome.notStarted.length).toBe(8);
  });
});
