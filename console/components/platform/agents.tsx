'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { SetupDialog } from './agent-setup';
import { AgentCard } from './agent-card';
import { useScrollToHash } from '@/hooks/use-scroll-to-hash';
import { SettingsCheck } from './agent-settings';
import { useHookCheckHistory } from './use-hook-check-history';
import { usePosture } from './use-posture';
import { agentScope, agentsHref } from '@/lib/agent-scope';
import { hookCheckEvidence } from '@/lib/hook-check-evidence';
import { usePlatform } from '@/components/platform-provider';
import { AgentGlyph, Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import {
  AGENT_NAMES,
  validateAgentStatus,
  type AgentStatusState,
  type AgentId,
} from '@/lib/agent-status';
export function AgentsPage() {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const scope = agentScope(useSearchParams());
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const readAllowed = workspaceId !== null;
  const [captured, setCaptured] = useState<{
      workspaceId: string;
      report: AgentStatusState;
    } | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const hookHistory = useHookCheckHistory({ enabled: readAllowed, generation: refreshGeneration });
  const posture = usePosture({ track: true });
  useScrollToHash(captured !== null);
  const active = useRef<AbortController | null>(null);
  const state = readAllowed && captured?.workspaceId === workspaceId ? captured.report : null;
  const setScope = (value: 'project' | 'user') =>
    window.history.pushState(null, '', agentsHref(value));
  const refresh = useCallback(async () => {
    if (!localAccess || !readAllowed || !workspaceId) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setRefreshGeneration((value) => value + 1);
    setError(null);
    try {
      const value = await requestLocal('/api/agents', undefined, controller.signal);
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!validateAgentStatus(value)) throw new Error('Unsupported current-configuration report.');
      if (active.current === controller) setCaptured({ workspaceId, report: value });
    } catch (e) {
      if (active.current === controller)
        setError(
          e instanceof Error && e.name !== 'AbortError'
            ? e.message
            : 'Configuration inspection timed out.',
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) setLoading(false);
    }
  }, [localAccess, requestLocal, readAllowed, workspaceId]);
  useEffect(() => {
    void refresh();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);
  const refreshAll = () => {
    void refresh();
    void posture.reload();
  };
  return (
    <div className="page-stack">
      <PageHeading
        title="Agents"
        description="Whether each agent has Stroq’s hooks, when Stroq was last asked, and which of its settings weaken them."
        actions={
          <>
            <button
              className="icon-button"
              aria-label="Refresh agent configuration and checks"
              disabled={!readAllowed || loading || hookHistory.busy}
              onClick={refreshAll}
            >
              <RefreshCw size={18} className={loading ? 'spin' : undefined} />
            </button>
            {readAllowed && <SetupDialog scope={scope} onConfigured={refreshAll} />}
          </>
        }
      />
      {error && readAllowed && (
        <p className="control-error" role="alert">
          {error}
          {state ? ' Earlier configuration evidence remains visible.' : ''}
        </p>
      )}
      {hookHistory.error && readAllowed && (
        <p className="control-error" role="status">
          Stroq hook history could not be rechecked.
        </p>
      )}
      {!localAccess ? (
        <>
          <Panel>
            <EmptyState
              title="Connect your local agents"
              description="Open the private server link to inspect the current installation in each scope."
            />
            <div className="panel-body">
              <p className="control-meta">
                Not connected to Stroq on this machine. Run <code>npx @stroq/cli console</code> to
                open this page with your data.
              </p>
            </div>
          </Panel>
          <div className="agent-grid agent-rows" aria-label="Supported agents">
            {Object.entries(AGENT_NAMES).map(([id, name]) => (
              <article className="agent-card operations-agent-card" key={id}>
                <div className="agent-card-top">
                  <AgentGlyph name={name} />
                  <h2>{name}</h2>
                  <Badge tone="muted">Not inspected</Badge>
                </div>
                <div className="agent-card-footer supported-agent-footer">
                  <SetupDialog agent={{ id: id as AgentId }} scope={scope} label="Connect agent" />
                </div>
              </article>
            ))}
          </div>
        </>
      ) : !workspaceId ? (
        <Panel>
          <EmptyState
            title="Workspace context not available"
            description="Open the private server link to establish the current workspace."
          />
        </Panel>
      ) : (
        <>
          <div className="toolbar">
            <div className="filter-tabs" aria-label="Agent configuration scope">
              <button
                className={scope === 'project' ? 'is-active' : ''}
                aria-pressed={scope === 'project'}
                onClick={() => setScope('project')}
              >
                Workspace
              </button>
              <button
                className={scope === 'user' ? 'is-active' : ''}
                aria-pressed={scope === 'user'}
                onClick={() => setScope('user')}
              >
                User (all workspaces)
              </button>
            </div>
            <span className="control-meta">
              {state
                ? `Inspected ${new Date(state.generatedAt).toLocaleString('en-GB')}`
                : loading
                  ? 'Inspecting configuration…'
                  : 'No configuration evidence loaded'}
            </span>
          </div>
          <div className="agent-grid agent-rows">
            {state?.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                scope={scope}
                onRefresh={refreshAll}
                generation={refreshGeneration}
                hookEvidence={hookCheckEvidence(
                  hookHistory.error ? null : hookHistory.state,
                  workspaceId,
                  agent.id,
                  scope,
                )}
                hookHistoryLoading={hookHistory.busy && !hookHistory.state}
                onHookChanged={() => void hookHistory.refresh()}
                settings={{ audit: posture.audit, changes: posture.changes, state: posture.state }}
              />
            ))}
          </div>
          <p className="control-meta">
            Recorded Stroq hook checks are offline. In-agent checks test the client separately.
          </p>
          <SettingsCheck
            audit={posture.audit}
            changes={posture.changes}
            state={posture.state}
            error={posture.error}
            shownAgents={state?.agents.map((agent) => agent.id) ?? []}
            onReload={() => void posture.reload()}
          />
        </>
      )}
    </div>
  );
}
