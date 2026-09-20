import { agentHookStatus, type AgentHookStatus } from '../commands/doctor.js';
import { repoFindings, repoSurface, type RepoSurface } from '../exposure/repo-surface.js';

/**
 * What `stroq run` establishes before it starts anything.
 *
 * Both checks here answer questions that stop being answerable the moment the agent
 * is running. The hook check is the launcher's own claim — `stroq run` says it starts
 * an agent already confined, and an agent with no Stroq hook is not confined by
 * anything. The repository check is the one Stroq's hooks provably cannot cover:
 * agents run `git status` to orient themselves, on Claude Code before the
 * workspace-trust prompt, and a `SessionStart` hook is gated on that same prompt
 * (see `commands/inspect.ts`). A launcher is the only place that moment exists.
 *
 * Both are refusals rather than warnings, and the reason is the same for both: a
 * warning printed a quarter of a second before a full-screen TUI takes the terminal
 * is a warning nobody reads. `--force` launches anyway, after printing the same text,
 * so nothing here is a dead end — it is a stop that has to be answered rather than
 * scrolled past.
 */

export interface PreflightRefusal {
  /** What is wrong, in the words the user needs to judge it. */
  readonly reason: string;
  /** The one thing that resolves it. */
  readonly fix: string;
}

export interface PreflightResult {
  readonly refusals: readonly PreflightRefusal[];
  /** Said either way, and never a reason to stop. */
  readonly notes: readonly string[];
}

export interface PreflightOptions {
  /** The Stroq agent id, or `null` when the command is not one Stroq recognises. */
  readonly agent: string | null;
  /** The program as the user wrote it, for the note when `agent` is null. */
  readonly command: string;
  readonly cwd: string;
  /** Whether to read the repository at all; `--no-inspect` turns it off. */
  readonly inspect: boolean;
  /** Injected so a test needs no real install; defaults to `stroq doctor`'s own check. */
  readonly hooks?: (agent: string, cwd: string) => AgentHookStatus | null;
  /** Injected for the same reason; defaults to the real repository read. */
  readonly surface?: (cwd: string) => RepoSurface;
}

function hookRefusals(agent: string, status: AgentHookStatus | null): readonly PreflightRefusal[] {
  if (status === null) {
    return [
      {
        reason: `"${agent}" is not an agent Stroq installs hooks for`,
        fix: 'name one of claude-code, cursor, codex, copilot, openclaw, windsurf, antigravity',
      },
    ];
  }
  // Checked before "installed": a changed entry IS installed, and reporting it as
  // present would be the reassurance the drift check exists to withhold.
  if (status.changed) {
    return [
      {
        reason: `${status.name}: the installed entry is no longer the command stroq init wrote — ${status.detail}`,
        fix: `stroq init --agent ${agent} — and find out who rewrote it`,
      },
    ];
  }
  if (!status.installed) {
    return [
      {
        reason: `${status.name}: Stroq has no hook in ${agent}, so nothing would judge this session's tool calls — ${status.detail}`,
        fix: `stroq init --agent ${agent}`,
      },
    ];
  }
  return [];
}

export function preflight(options: PreflightOptions): PreflightResult {
  const hooks = options.hooks ?? agentHookStatus;
  const surface = options.surface ?? repoSurface;
  const refusals: PreflightRefusal[] = [];
  const notes: string[] = [];

  if (options.agent === null) {
    // Deliberately not a refusal. Stroq cannot tell whether an unrecognised program
    // is an agent at all, and refusing to start one would make the launcher useless
    // for the wrapper scripts people really run — while the git hardening it applies
    // is real either way. What it must not do is let that pass in silence.
    notes.push(
      `Stroq does not recognise "${options.command}" as one of its supported agents, so it did not check whether hooks are installed for it. Name it with --agent <id> if it is one.`,
    );
  } else {
    refusals.push(...hookRefusals(options.agent, hooks(options.agent, options.cwd)));
  }

  if (!options.inspect) {
    notes.push('The repository was not read for pre-approval execution (--no-inspect).');
  } else {
    const findings = repoFindings(surface(options.cwd));
    refusals.push(...findings.map((f) => ({ reason: f.detail, fix: f.fix ?? '' })));
  }
  return { refusals, notes };
}
