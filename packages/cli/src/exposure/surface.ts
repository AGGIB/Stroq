import { homedir } from 'node:os';
import { agentHookStatus, detectedAgents, type AgentHookStatus } from '../commands/doctor.js';
import { HOOK_AGENTS } from '../commands/init.js';
import type { Finding } from './findings.js';

export interface AgentSurface {
  readonly agent: string;
  /** The agent's config directory exists on this machine. */
  readonly detected: boolean;
  /** A Stroq hook is installed for it, in either scope, and is still the command `init` wrote. */
  readonly protected: boolean;
  /**
   * An installed entry is no longer the command `init` recorded: the agent still reports a hook,
   * and whatever is on the other end runs on every tool call. `doctor` fails that line on its own.
   */
  readonly changed?: boolean;
  /** The command that fixes it, as `doctor` gives it: `init --agent <name>`, or a better one when the file is shadowed. */
  readonly fix?: string;
}

/** What `doctor` says of an agent's hooks; a malformed config means "not protected", never a crash. */
function statusOf(agent: string, cwd: string): AgentHookStatus | null {
  try {
    return agentHookStatus(agent, cwd);
  } catch {
    return null;
  }
}

/**
 * Detection is delegated to `doctor`'s `detectedAgents` rather than re-listing the
 * config directories here. A second copy of that table would let `doctor` and
 * `exposure` disagree about which agents a machine uses, which is the one thing
 * these two commands must never do.
 */
export function agentSurface(cwd: string, home: string = homedir()): readonly AgentSurface[] {
  const detected = new Set(detectedAgents(cwd, home));
  return HOOK_AGENTS.map((agent) => {
    // The same definition `doctor` and `stroq run` apply, asked once: every required event with
    // its matcher and fail-closed flag. A post-only install scans but blocks nothing, and counting
    // it as protection is what A-06 of the 2026-09-23 audit found. An entry that is no longer the
    // command `init` recorded is not protection either, and is said to be changed.
    const status = statusOf(agent, cwd);
    const changed = status?.changed === true;
    return {
      agent,
      detected: detected.has(agent),
      protected: status?.installed === true && !changed,
      ...(changed ? { changed: true } : {}),
      ...(status === null ? {} : { fix: status.fix }),
    };
  });
}

export function agentFindings(surfaces: readonly AgentSurface[]): readonly Finding[] {
  return surfaces
    .filter((s) => s.detected && !s.protected)
    .map((s) => ({
      class: 'agent-unprotected' as const,
      severity: 'critical' as const,
      detail:
        s.changed === true
          ? `${s.agent} is used on this machine and its Stroq hook entry is no longer the command stroq init wrote — the agent reports a hook, and something else may be running in its place`
          : `${s.agent} is used on this machine and Stroq is not installed for it — nothing is enforced there`,
      fix: s.fix ?? `stroq init --agent ${s.agent}`,
    }));
}
