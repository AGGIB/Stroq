import { loadPolicy } from '../engine-factory.js';
import { capabilitiesFor } from '../hosts/capabilities.js';
import { readHookStamp } from '../hook-stamp.js';
import { DRIVEN_AGENTS } from '../live/drivers/agents.js';
import { plainText } from '../live/plain-text.js';
import { policySha256 } from '../live/policy-digest.js';
import { displayState, type InstallStatus } from '../live/states.js';
import { readHostResult } from '../live/store.js';
import { stroqHome } from '../paths.js';
import { stroqVersion } from '../version.js';
import { readInstallRecord } from './install-record.js';

/**
 * What a `doctor` line adds for an install that is whole and that a live check can be run against: what
 * the last `stroq prove` found, read from the one small file it left. `doctor` stays fast and offline, so
 * it never runs the host, and the one thing it cannot see is a host that was updated since: it says so.
 * What it compares the stored check with is what it can read here: this Stroq, the policy in force, and
 * whether the hook was installed again after the check.
 *
 * A fact on the line and not a verdict, as the time of the last call is: a check that has not been run is
 * not a fault, so the line does not fail for it.
 */

const HOST_NOT_RE_READ = 'host version not re-read';

/** When `stroq init` last recorded an install for the agent, in any scope. */
function installRecordedAt(agent: string): Date | null {
  const times = Object.entries(readInstallRecord().entries)
    .filter(([key]) => key.startsWith(`${agent}:`))
    .map(([, entry]) => new Date(entry.recordedAt))
    .filter((time) => !Number.isNaN(time.getTime()));
  return times.length === 0 ? null : new Date(Math.max(...times.map((time) => time.getTime())));
}

function proofText(agent: string, installed: InstallStatus, now: number): string {
  const stored = readHostResult(stroqHome(), agent, new Date(now));
  if (stored.problem !== null)
    return `the stored result cannot be read (${plainText(stored.problem, 60)}); run stroq prove`;
  if (stored.result === null) return 'no live check yet (stroq prove)';
  let digest: string;
  try {
    digest = policySha256(loadPolicy());
  } catch {
    return 'the policy cannot be read, so the stored check cannot be compared with it; mend it and run stroq prove';
  }
  const shown = displayState({
    capabilities: capabilitiesFor(agent),
    installed,
    stampAt: readHookStamp(agent),
    installRecordedAt: installRecordedAt(agent),
    stored: stored.result,
    stroqVersion: stroqVersion(),
    policySha256: digest,
    // Not asked of the host: `doctor` does not start it. The check's own version is taken as today's.
    hostVersion: stored.result.hostVersion,
  });
  const note = shown.state === 'verified' || shown.state === 'stale' ? `; ${HOST_NOT_RE_READ}` : '';
  return `${shown.state} (${shown.reason}${note})`;
}

/** The line of an install that is whole, with what the last live check found on the end of it. */
export function withProof<T extends { readonly ok: boolean; readonly detail: string }>(
  check: T,
  agent: string,
  installed: InstallStatus,
  now: number,
): T {
  if (!DRIVEN_AGENTS.includes(agent) || !installed.installed || !check.ok) return check;
  return { ...check, detail: `${check.detail} · proof: ${proofText(agent, installed, now)}` };
}
