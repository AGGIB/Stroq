// A pool of workers that run jobs and hand the results back in the order the jobs were given.
//
// The pool does not know what a worker is: it is given `open`, which makes a channel, so the same
// code runs over `worker_threads` in the CLI and over an in-process fake in tests, and the results of
// both can be compared. Each channel takes a couple of jobs at a time, so that a worker is never idle
// while the main thread is busy with a result. After `stopStartingAfterMs` no job is started; the
// ones in flight get `graceMs` to finish and the workers are closed. A worker that dies fails the jobs
// it held and is replaced a few times; a pool with no worker left leaves the rest not started.

/** The two ends of a worker, as the pool needs them. */
export interface Channel<J, R> {
  send(id: number, job: J): void;
  onMessage(callback: (id: number, result: R) => void): void;
  /** The worker died (an error, an exit): every job it held is lost. */
  onFailure(callback: (reason: string) => void): void;
  /**
   * The worker began a job it was sent (not merely holds it). A channel that does not say has no job
   * known to be running, so none is blamed when the time runs out.
   */
  onStart?(callback: (id: number) => void): void;
  close(): Promise<void>;
}

export interface PoolOptions<J, R> {
  readonly size: number;
  readonly open: () => Channel<J, R>;
  /** Jobs a worker holds at once. */
  readonly depth?: number;
  readonly stopStartingAfterMs?: number;
  readonly graceMs?: number;
  /** Called with each result as it arrives. */
  readonly onResult?: (index: number, result: R) => void;
  /** Called when a worker dies, with the reason. */
  readonly onWorkerLost?: (reason: string) => void;
}

export interface PoolOutcome<R> {
  /** By job index; undefined for a job without a result. */
  readonly results: readonly (R | undefined)[];
  /** Jobs whose worker died. */
  readonly failed: readonly number[];
  /** Jobs never given to a worker: the time was up, or no worker was left. */
  readonly notStarted: readonly number[];
  /** Jobs a worker had when the time was up and did not finish. */
  readonly unfinished: readonly number[];
  /** Of those, the ones the worker had begun: the others were only waiting behind them. */
  readonly ran: readonly number[];
}

const DEFAULT_DEPTH = 2;
const DEFAULT_GRACE_MS = 3_000;
const MAX_REPLACEMENTS = 3;

interface Slot<J, R> {
  readonly channel: Channel<J, R>;
  readonly held: Set<number>;
  /** Held jobs the worker has begun. */
  readonly running: Set<number>;
  alive: boolean;
}

export function runPool<J, R>(
  jobs: readonly J[],
  options: PoolOptions<J, R>,
): Promise<PoolOutcome<R>> {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const results: (R | undefined)[] = jobs.map(() => undefined);
  const failed: number[] = [];
  const queue: number[] = jobs.map((_, i) => i);
  const slots: Slot<J, R>[] = [];
  let replacements = 0;
  let finished = false;
  let stopped = false;

  return new Promise<PoolOutcome<R>>((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      const unfinished = slots.flatMap((s) => [...s.held]).sort((a, b) => a - b);
      const ran = slots.flatMap((s) => [...s.running]).sort((a, b) => a - b);
      const notStarted = [...queue];
      void Promise.all(slots.map((s) => s.channel.close().catch(() => 0))).then(() =>
        resolve({ results, failed: failed.sort((a, b) => a - b), notStarted, unfinished, ran }),
      );
    };

    const settled = (): boolean =>
      queue.length === 0 && slots.every((s) => !s.alive || s.held.size === 0);

    const feed = (slot: Slot<J, R>): void => {
      while (slot.alive && !stopped && slot.held.size < depth && queue.length > 0) {
        const index = queue.shift() as number;
        slot.held.add(index);
        slot.channel.send(index, jobs[index] as J);
      }
      if (settled() || (stopped && slots.every((s) => s.held.size === 0))) finish();
    };

    const add = (): void => {
      const channel = options.open();
      const slot: Slot<J, R> = { channel, held: new Set(), running: new Set(), alive: true };
      slots.push(slot);
      channel.onStart?.((id) => {
        if (!finished && slot.held.has(id)) slot.running.add(id);
      });
      channel.onMessage((id, result) => {
        if (finished || !slot.held.delete(id)) return;
        slot.running.delete(id);
        results[id] = result;
        options.onResult?.(id, result);
        feed(slot);
      });
      channel.onFailure((reason) => {
        if (finished || !slot.alive) return;
        slot.alive = false;
        failed.push(...slot.held);
        slot.held.clear();
        slot.running.clear();
        options.onWorkerLost?.(reason);
        if (replacements < MAX_REPLACEMENTS && !stopped) {
          replacements += 1;
          add();
        } else if (slots.every((s) => !s.alive)) {
          finish();
        } else {
          for (const other of slots) feed(other);
        }
      });
      feed(slot);
    };

    if (jobs.length === 0) {
      finish();
      return;
    }
    const size = Math.max(1, Math.min(options.size, jobs.length));
    for (let i = 0; i < size; i += 1) add();

    if (options.stopStartingAfterMs !== undefined) {
      timers.push(
        setTimeout(() => {
          stopped = true;
          if (slots.every((s) => s.held.size === 0)) {
            finish();
            return;
          }
          timers.push(setTimeout(finish, options.graceMs ?? DEFAULT_GRACE_MS));
        }, options.stopStartingAfterMs),
      );
    }
  });
}
