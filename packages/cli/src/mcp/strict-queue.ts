/**
 * A bound on how much server output waits for the pump in strict mode.
 *
 * The default proxy bounds its queue through write backpressure alone: a slow client
 * pauses the server's stdout. Strict mode withholds most of what a hostile server floods
 * it with, and a withheld line is never written anywhere, so nothing ever pushes back.
 * Each queued line holds its text until the pump reaches it, and the pump is slow by
 * design (an audit append and a scan per message).
 *
 * The gate bounds it two ways, and a line is held up by whichever is reached first: the
 * NUMBER of lines waiting, and the number of CHARACTERS of text in them. Count alone is
 * not a bound on memory, because a line can be up to 8 MiB: 256 lines is two gigabytes.
 * It pauses the server's stdout at either bound and resumes it when both are down to
 * half.
 *
 * The queue can still hold one chunk's worth of lines past a bound, since lines arrive
 * whole chunks at a time; it cannot grow beyond that however long the pump takes.
 */
export interface QueueGate {
  /** Call as a line is queued, with the length of its text. */
  readonly enter: (chars: number) => void;
  /** Call as the pump finishes with a line, however it ended, with the same length. */
  readonly leave: (chars: number) => void;
}

export function createQueueGate(
  source: NodeJS.ReadableStream,
  maxLines: number,
  maxChars: number,
): QueueGate {
  let lines = 0;
  let chars = 0;
  let gated = false;
  return {
    enter: (size) => {
      lines += 1;
      chars += size;
      // Paused again on every line while over a bound, since the backpressure helper
      // resumes this same stream whenever a write to the client drains.
      if (lines >= maxLines || chars >= maxChars) {
        gated = true;
        source.pause();
      }
    },
    leave: (size) => {
      lines = Math.max(0, lines - 1);
      chars = Math.max(0, chars - size);
      if (gated && lines <= maxLines / 2 && chars <= maxChars / 2) {
        gated = false;
        source.resume();
      }
    },
  };
}
