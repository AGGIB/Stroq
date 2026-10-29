import { AGENT_NAMES, validateAgentStatus, type AgentStatusState } from './agent-status';
import { hookCheckEvidence } from './hook-check-evidence';
import { hookCheckHref } from './hook-check-navigation';
import { HOOK_CHECK_AGENTS, validateHookCheckState, type HookCheckState } from './hook-checks';
import type { ProtectionEvidenceRow } from './protection-evidence';

/** Saved isolated executions only; opening a queue row cannot preview or start a check. */
export function hookCheckRows(
  state: HookCheckState | null,
  agents: AgentStatusState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  const gap = (key: string, title: string, detail: string): ProtectionEvidenceRow => ({
    key: `hook-check-${key}`,
    title,
    detail,
    tone: 'orange',
    href: '/agents/hooks/',
    action: 'Review hook checks',
  });
  if (!workspaceId || !validateHookCheckState(state) || state.workspaceId !== workspaceId)
    return [
      gap(
        'unavailable',
        'Stroq hook history unavailable',
        'No completed isolated hook execution was inferred.',
      ),
    ];
  if (state.history.status !== 'ready')
    return [
      gap(
        'history',
        'Stroq hook history could not be verified',
        'Open saved checks to inspect this coverage gap.',
      ),
    ];

  const rows: ProtectionEvidenceRow[] = [];
  if (!state.engine.available)
    rows.push(
      gap(
        'runtime',
        'Stroq hook runtime unavailable',
        'A fresh isolated check cannot start. Saved results remain historical.',
      ),
    );
  else if (
    validateAgentStatus(agents) &&
    agents.agents.some(
      (agent) =>
        agent.scopes.some((scope) => scope.state === 'present') &&
        state.agents.find((item) => item.id === agent.id)?.supported === false,
    )
  )
    rows.push(
      gap(
        'platform',
        'Stroq hook checks unavailable on this platform',
        'Configured source files remain inspectable. No isolated check can start for this platform.',
      ),
    );
  for (const agent of HOOK_CHECK_AGENTS) {
    for (const scope of ['project', 'user'] as const) {
      const evidence = hookCheckEvidence(state, workspaceId, agent, scope);
      if (evidence.status === 'passed' || evidence.status === 'unavailable') continue;
      const key = `hook-check-${agent}-${scope}`;
      const label = `${AGENT_NAMES[agent]} · ${scope === 'project' ? 'workspace source' : 'user source'}`;
      if (evidence.status === 'not-checked') {
        if (
          !validateAgentStatus(agents) ||
          !agents.agents.some(
            (item) =>
              item.id === agent &&
              item.scopes.some((item) => item.scope === scope && item.state === 'present'),
          )
        )
          continue;
        const href = hookCheckHref({ workspaceId, agent, scope });
        if (href)
          rows.push({
            key,
            title: `Test the Stroq hook for ${AGENT_NAMES[agent]}`,
            detail: `${label}. No isolated hook result has been recorded for this source.`,
            tone: 'muted',
            href,
            action: 'Test Stroq hook',
          });
        continue;
      }
      const href = hookCheckHref({ workspaceId, jobId: evidence.job!.id });
      if (!href) continue;
      const title =
        evidence.status === 'running'
          ? `Stroq hook check running · ${AGENT_NAMES[agent]}`
          : evidence.status === 'attention'
            ? `Stroq hook responses need review · ${AGENT_NAMES[agent]}`
            : evidence.status === 'mismatch'
              ? `Stroq hook response mismatch · ${AGENT_NAMES[agent]}`
              : `Stroq hook check did not finish · ${AGENT_NAMES[agent]}`;
      rows.push({
        key,
        title,
        detail: `${label}. Recorded ${evidence.recordedAt}. This isolated execution does not establish in-agent blocking.`,
        href,
        action: 'Inspect hook result',
        tone: evidence.tone,
      });
    }
  }
  return rows;
}
