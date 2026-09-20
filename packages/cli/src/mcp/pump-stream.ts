/**
 * The stream plumbing under the MCP proxy's two message pumps: the per-direction
 * ordering queue, and the one write helper that honours backpressure without hanging
 * on a sink that has already died.
 *
 * Split out of `proxy-pump.ts` only to keep both files under the repo's 400-line cap
 * — the same reason `judge.ts` keeps its result-text reader in `mcp-result-text.ts`
 * and re-exports it. `proxy-pump.ts` re-exports `OrderedQueue` and
 * `writeBackpressured` unchanged, so nothing outside this directory needs to know the
 * split exists. Nothing here touches the engine, the audit log or a JSON-RPC message;
 * it only moves bytes.
 */

/**
 * One queue per direction, so lines are handled strictly in arrival order: the
 * session store is file-locked and the audit log is a hash chain, so two engine calls
 * must never overlap, and the order they run in is the order `stroq log` shows. A
 * task that throws is swallowed here — every task answers its own failures first — so
 * one bad line can never stall the stream behind it.
 */
export class OrderedQueue {
  private tail: Promise<void> = Promise.resolve();

  run(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).then(
      () => undefined,
      () => undefined,
    );
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

/**
 * Whether a sink can still take anything at all. `writable` is the only one of these
 * the `NodeJS.WritableStream` interface itself declares; `destroyed`, `closed` and
 * `writableEnded` are what a real Node stream adds, and a `ChildProcess`'s stdin
 * carries all four the moment the child exits (measured: `destroyed` and `closed`
 * true, `writable` false, `writableEnded` false — the pipe was killed, not ended).
 * A caller's own minimal stream may expose none of them, in which case it is treated
 * as alive, which is exactly the wait-for-an-event behaviour below and unchanged.
 */
const isDeadSink = (sink: NodeJS.WritableStream): boolean => {
  if (sink.writable === false) return true;
  const flags = sink as {
    readonly destroyed?: boolean;
    readonly closed?: boolean;
    readonly writableEnded?: boolean;
  };
  return flags.destroyed === true || flags.closed === true || flags.writableEnded === true;
};

/**
 * Honours backpressure in BOTH directions: `sink.write()` returning false means the
 * DESTINATION cannot keep up, so `source` — whichever stream is feeding the queue
 * that produced this write — is paused until the write actually drains. Without
 * this, a fast writer paired with a slow reader grows the queue without bound
 * (measured before this fix: 100k lines from a fast server against a slow-reading
 * client pushed this process's RSS past 380 MiB, with the server never slowed by
 * anything the proxy did).
 *
 * A sink that is already GONE — the MCP server exited, so its stdin is destroyed,
 * or the client disconnected, so its stdout closed — also reports `write()`
 * returning false, but then never emits `drain`, `error` or `close` again: all
 * three fired ONCE, as the stream died, and an `EventEmitter` does not replay a
 * past event to a listener attached afterwards. Waiting on them there hangs
 * forever, leaves `source` paused for good and stalls the caller's
 * `OrderedQueue.idle()` at shutdown, so the proxy never exits at all while a client
 * keeps writing to a server that has died (measured: no exit within 20 s, against
 * 131 ms for the same run with nothing sent after the death). So death is checked
 * BEFORE writing — a dead sink is never even written to — and again the moment a
 * write reports backpressure, since that write can itself be what observes the
 * death. Either way the line is DROPPED: there is no destination left to deliver it
 * to, and the proxy is on its way out. `source` is resumed on that path too, so a
 * pause left by an earlier write can never outlive the sink it was waiting for.
 */
export async function writeBackpressured(
  sink: NodeJS.WritableStream,
  text: string,
  source: NodeJS.ReadableStream,
): Promise<void> {
  if (isDeadSink(sink)) {
    source.resume();
    return;
  }
  if (sink.write(text)) return;
  if (isDeadSink(sink)) {
    source.resume();
    return;
  }
  source.pause();
  await new Promise<void>((resolve) => {
    const done = (): void => {
      sink.off('drain', done);
      sink.off('error', done);
      sink.off('close', done);
      resolve();
    };
    sink.once('drain', done);
    sink.once('error', done);
    sink.once('close', done);
  });
  source.resume();
}
