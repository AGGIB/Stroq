/**
 * A bound on how many server lines wait for the pump in strict mode.
 *
 * The default proxy bounds its queue through write backpressure alone: a slow client
 * pauses the server's stdout. Strict mode withholds most of what a hostile server floods
 * it with, and a withheld line is never written anywhere, so nothing ever pushes back.
 * Each queued line holds its text (up to a megabyte or more) until the pump reaches it,
 * and the pump is slow by design (an audit append and a scan per message). The gate
 * pauses the server's stdout while `max` lines are waiting and resumes it at half that.
 *
 * The queue can still hold one chunk's worth of lines past `max`, since lines arrive
 * whole chunks at a time; it cannot grow beyond that however long the pump takes.
 */
export interface QueueGate {
  /** Call as a line is queued. */
  readonly enter: () => void;
  /** Call as the pump finishes with a line, however it ended. */
  readonly leave: () => void;
}

export function createQueueGate(source: NodeJS.ReadableStream, max: number): QueueGate {
  let queued = 0;
  let gated = false;
  return {
    enter: () => {
      queued += 1;
      // Paused again on every line while over the bound, since the backpressure helper
      // resumes this same stream whenever a write to the client drains.
      if (queued >= max) {
        gated = true;
        source.pause();
      }
    },
    leave: () => {
      queued -= 1;
      if (gated && queued <= max / 2) {
        gated = false;
        source.resume();
      }
    },
  };
}
