'use client';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { AgentGlyph, Badge } from '@/components/platform-ui';
import { AGENT_NAMES, AGENT_STATUS_REASONS, type AgentStatus } from '@/lib/agent-status';
import { agentState } from '@/lib/agent-summary';
import { credentialFilterTarget } from '@/lib/credential-filter-binding';
import { hookCheckHref } from '@/lib/hook-check-navigation';
import type { HookCheckEvidence } from '@/lib/hook-check-evidence';
import type { CredentialFilterTarget } from '@/lib/credential-filters';
import { SetupDialog } from './agent-setup';
import { AgentDisconnect } from './agent-disconnect';
import { LiveProofDialog } from './live-proof';
import { HookCheckDialog } from './hook-check-dialog';
import { CredentialFilters } from './credential-filters';
import type { useCredentialFilters } from './use-credential-filters';
import { CodexSkillSources } from './codex-skill-sources';
import { CodexNetworkGuard } from './codex-network-guard';
import { CodexPathGuard } from './codex-path-guard';
export function AgentCard({
  agent,
  scope,
  onRefresh,
  filters,
  onWorkspaceScope,
  selectedFilter,
  onFilterSelection,
  generation,
  hookEvidence,
  hookHistoryLoading,
  onHookChanged,
}: {
  agent: AgentStatus;
  scope: 'project' | 'user';
  onRefresh: () => void;
  filters: ReturnType<typeof useCredentialFilters>;
  onWorkspaceScope: () => void;
  selectedFilter: CredentialFilterTarget | null;
  onFilterSelection: (target: CredentialFilterTarget | null) => void;
  generation: number;
  hookEvidence: HookCheckEvidence;
  hookHistoryLoading: boolean;
  onHookChanged: () => void;
}) {
  const configuration = agent.scopes.find((s) => s.scope === scope)!;
  const summary = agentState(agent, scope);
  const recordedHookHref = hookEvidence.job
    ? hookCheckHref({
        workspaceId: hookEvidence.job.binding.workspaceId,
        jobId: hookEvidence.job.id,
      })
    : null;
  const approval =
    configuration.state === 'missing'
      ? 'Not configured'
      : configuration.approval === 'required'
        ? 'Required in agent'
        : configuration.approval === 'unknown'
          ? 'Not verified'
          : 'Not required';
  const proof =
    agent.proof.state === 'failed'
      ? 'Historical failure'
      : agent.proof.state === 'stale'
        ? 'Needs a fresh check'
        : agent.proof.state === 'unsupported'
          ? 'Driver unsupported'
          : agent.proof.state === 'invalid'
            ? 'Stored proof invalid'
            : 'Not established';
  const hook = hookHistoryLoading ? (
    'Reading history…'
  ) : recordedHookHref ? (
    <Link href={recordedHookHref}>{hookEvidence.label}</Link>
  ) : (
    hookEvidence.label
  );
  return (
    <article id={agent.id} className="agent-card operations-agent-card agent-row" tabIndex={-1}>
      <div className="agent-row-main">
        <div className="agent-row-identity">
          <AgentGlyph name={AGENT_NAMES[agent.id]} />
          <div>
            <div className="agent-row-title">
              <h2>{AGENT_NAMES[agent.id]}</h2>
              <Badge tone={summary.tone}>{summary.label}</Badge>
            </div>
            <p className="agent-row-summary agent-row-line">{summary.line}</p>
          </div>
        </div>
        <div className="agent-row-actions">
          <SetupDialog
            agent={{ id: agent.id }}
            scope={scope}
            label={configuration.state === 'present' ? 'Review setup' : 'Configure'}
            onConfigured={onRefresh}
          />
          <HookCheckDialog
            agent={agent.id}
            scope={scope}
            generation={generation}
            onChanged={onHookChanged}
            label="Test hook"
          />
        </div>
      </div>
      <div className="agent-row-controls">
        {agent.id === 'codex' && (
          <>
            <CodexNetworkGuard />
            <CodexPathGuard />
            <CodexSkillSources compact />
          </>
        )}
        {(agent.id === 'claude-code' || agent.id === 'cursor') && (
          <CredentialFilters
            agent={agent.id}
            scope={scope}
            filters={filters}
            onWorkspaceScope={onWorkspaceScope}
            onChanged={onRefresh}
            linked={
              selectedFilter !== null && selectedFilter === credentialFilterTarget(agent.id, scope)
            }
            onSelectionChange={onFilterSelection}
          />
        )}
      </div>
      <details className="agent-row-details">
        <summary>Details</summary>
        <div className="agent-row-detail-body">
          <div className="operations-agent-status">
            <div>
              <span>Hook approval</span>
              <strong>{approval}</strong>
            </div>
            <div>
              <span>Stroq hook</span>
              <strong>
                {hook}
                {!hookHistoryLoading && hookEvidence.recordedAt && (
                  <>
                    <br />
                    <time className="control-meta" dateTime={hookEvidence.recordedAt}>
                      {new Date(hookEvidence.recordedAt).toLocaleString('en-GB')}
                    </time>
                  </>
                )}
              </strong>
            </div>
            <div>
              <span>In-agent check</span>
              <strong>{proof}</strong>
            </div>
          </div>
          <p className="agent-card-description">{AGENT_STATUS_REASONS[configuration.reason]}</p>
          <dl className="agent-row-evidence">
            <div>
              <dt>Scope</dt>
              <dd>{scope === 'project' ? 'Workspace' : 'User (all workspaces)'}</dd>
            </div>
            <div>
              <dt>Last hook on this machine</dt>
              <dd>
                {agent.observation.state === 'recorded' && agent.observation.lastHookAt
                  ? new Date(agent.observation.lastHookAt).toLocaleString('en-GB')
                  : 'No confirmed observation'}
              </dd>
            </div>
          </dl>
          {agent.proof.checkedAt && (
            <p className="control-meta">
              Stored check: {new Date(agent.proof.checkedAt).toLocaleString('en-GB')}. Current host
              version unverified.
            </p>
          )}
          {configuration.events.length > 0 && (
            <dl className="agent-row-evidence">
              {configuration.events.map((event) => (
                <div key={event.event}>
                  <dt>{event.event}</dt>
                  <dd aria-label={event.state}>
                    {event.state === 'present' ? <Check size={14} /> : event.state}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="agent-row-detail-actions">
            <LiveProofDialog agent={agent.id} label="Test in agent" />
            <AgentDisconnect
              agent={agent.id}
              scope={scope}
              generation={generation}
              onChanged={onRefresh}
              showTrigger={configuration.state !== 'missing'}
            />
          </div>
        </div>
      </details>
    </article>
  );
}
