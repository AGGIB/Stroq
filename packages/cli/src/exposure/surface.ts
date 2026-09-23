import { homedir } from 'node:os';
import {
  antigravityHooksPath,
  isStroqAntigravityHooks,
  readAntigravityHooks,
} from '../commands/antigravity-hooks.js';
import {
  copilotHooksPath,
  isStroqCopilotHooks,
  readCopilotHooks,
} from '../commands/copilot-hooks.js';
import { agentHookStatus, detectedAgents } from '../commands/doctor.js';
import { HOOK_AGENTS } from '../commands/init.js';
import { isStroqOpenClawPlugin, openclawPluginDir } from '../commands/openclaw-plugin.js';
import {
  isStroqWindsurfHooks,
  readWindsurfHooks,
  windsurfHooksPath,
} from '../commands/windsurf-hooks.js';
import type { Finding } from './findings.js';

export interface AgentSurface {
  readonly agent: string;
  /** The agent's config directory exists on this machine. */
  readonly detected: boolean;
  /** A Stroq hook is installed for it, in either scope. */
  readonly protected: boolean;
}

/** Every check is wrapped: a malformed config means "not protected", never a crash. */
const safe = (fn: () => boolean): boolean => {
  try {
    return fn();
  } catch {
    return false;
  }
};

const SCOPES = ['project', 'user'] as const;

function isProtected(agent: string, cwd: string): boolean {
  switch (agent) {
    // The same definition `doctor` and `stroq run` apply: every required event with
    // its matcher and fail-closed flag. A post-only install scans but blocks nothing,
    // and counting it as protection is what A-06 of the 2026-09-23 audit found.
    case 'claude-code':
    case 'cursor':
    case 'codex':
      return safe(() => agentHookStatus(agent, cwd)?.installed === true);
    case 'copilot':
      return SCOPES.some((s) =>
        safe(() => isStroqCopilotHooks(readCopilotHooks(copilotHooksPath(s, cwd)))),
      );
    case 'windsurf':
      return SCOPES.some((s) =>
        safe(() => isStroqWindsurfHooks(readWindsurfHooks(windsurfHooksPath(s, cwd)))),
      );
    case 'antigravity':
      return SCOPES.some((s) =>
        safe(() => isStroqAntigravityHooks(readAntigravityHooks(antigravityHooksPath(s, cwd)))),
      );
    case 'openclaw':
      return safe(() => isStroqOpenClawPlugin(openclawPluginDir()));
    default:
      return false;
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
  return HOOK_AGENTS.map((agent) => ({
    agent,
    detected: detected.has(agent),
    protected: isProtected(agent, cwd),
  }));
}

export function agentFindings(surfaces: readonly AgentSurface[]): readonly Finding[] {
  return surfaces
    .filter((s) => s.detected && !s.protected)
    .map((s) => ({
      class: 'agent-unprotected' as const,
      severity: 'critical' as const,
      detail: `${s.agent} is used on this machine and Stroq is not installed for it — nothing is enforced there`,
      fix: `stroq init --agent ${s.agent}`,
    }));
}
