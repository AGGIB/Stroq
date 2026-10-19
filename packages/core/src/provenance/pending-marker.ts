/**
 * The longest time any agent's hook gives itself before Stroq answers on its own. The hook
 * command holds the table (`LONGEST_HOOK_DEADLINE_MS` in `commands/hook.ts`), which the core
 * cannot read, so the number is repeated here and a test in the CLI fails when the two differ.
 */
export const HOOK_DEADLINE_CEILING_MS = 18_000;

/** What a marker is allowed beyond that: the time to write it, and to settle it. */
export const MARKER_MARGIN_MS = 2_000;

/** How long after it was put down a marker may stand before it is no longer a result in flight. */
export const MARKER_LIFETIME_MS = HOOK_DEADLINE_CEILING_MS + MARKER_MARGIN_MS;

/**
 * The marker for a result that is about to be recorded: who is recording it, since when, and the
 * time by which that process has to be done. A marker is read by later hooks, which cannot tell
 * a result in flight from one whose process was killed except by asking what the marker says.
 */
export function pendingMarkerBody(at: Date, pid: number = process.pid): string {
  return JSON.stringify({
    pending: true,
    since: at.toISOString(),
    pid,
    deadlineAt: at.getTime() + MARKER_LIFETIME_MS,
  });
}

/**
 * Whether a process exists. Signal 0 only checks: it is not sent. A process this user may not
 * signal (`EPERM`) exists; one that is gone (`ESRCH`), or any other failure, does not count as one.
 * Works on Windows too, where Node maps it to an existence check.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface MarkerFields {
  readonly pid?: unknown;
  readonly deadlineAt?: unknown;
}

const isProcessNumber = (value: unknown): value is number =>
  // Zero and negative numbers would address a whole group of processes, not one.
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Whether the marker `text` is stale at `nowMs`: a result that was being read and, by now, will not
 * be scanned. It is stale when it cannot be parsed, names no owner or no deadline, the deadline has
 * passed, or the process that owns it is gone. A hook that is running answers within its deadline,
 * so none of these is a result in flight.
 */
export function markerIsStale(
  text: string,
  nowMs: number,
  isAlive: (pid: number) => boolean = processIsAlive,
): boolean {
  let fields: MarkerFields;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true;
    fields = parsed as MarkerFields;
  } catch {
    return true;
  }
  const { pid, deadlineAt } = fields;
  if (!isProcessNumber(pid) || typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) {
    return true;
  }
  if (nowMs > deadlineAt) return true;
  return !isAlive(pid);
}
