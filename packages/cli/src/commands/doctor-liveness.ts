import { formatAge, readHookStamp } from '../hook-stamp.js';

/**
 * What a `doctor` line adds for an install that is whole: when a host last called the hook. It is
 * a fact and not a verdict. A fresh install has not been called yet, and a host that has hooks
 * switched off looks the same as one that has not been used, so neither fails the check; what the
 * line does is put the question where someone who sees a green tick will see it.
 *
 * The time is the agent's on this machine and not the project's: an install in one project reads
 * the calls the same agent made in another, and the words say so.
 */

/** The row for the MCP proxy, which is no hook and has no adapter to leave a stamp. */
const MCP_ROW_ID = 'mcp';

/**
 * Two clocks (the host's and `doctor`'s) differ by a moment at most; a stamp further ahead than
 * this was written by a clock that was wrong, and a dead host never overwrites it.
 */
const CLOCK_SKEW_MS = 5 * 60_000;

export function livenessDetail(agent: string, now: number): string {
  const stamp = readHookStamp(agent);
  if (stamp === null) return ' · no hook call recorded on this machine yet';
  const age = now - stamp.getTime();
  return age < -CLOCK_SKEW_MS
    ? ' · last hook call is dated in the future (check the clock)'
    : ` · last hook call on this machine ${formatAge(age)}`;
}

/**
 * The line `doctor` prints for one row, with the host's last call on the end when the install it
 * describes is whole. A broken install has something more urgent to say, and a row that is not
 * installed has nothing to be called.
 */
export function withLiveness<T extends { readonly ok: boolean; readonly detail: string }>(
  check: T,
  agent: string,
  installed: boolean,
  now: number,
): T {
  if (agent === MCP_ROW_ID || !installed || !check.ok) return check;
  return { ...check, detail: `${check.detail}${livenessDetail(agent, now)}` };
}
