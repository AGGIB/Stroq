import { AgentBrand } from '@/components/agent-brand';
import { AGENT_NAMES } from '@/lib/agent-status';

/** Static branding remains visible while the URL-bound controls hydrate. */
export function AgentsLoading() {
  return (
    <div className="page-stack" aria-busy="true">
      <div className="page-heading">
        <div>
          <h1>Agents</h1>
        </div>
      </div>
      <p className="control-meta" role="status">
        Loading Agents…
      </p>
      <div className="agent-grid" aria-label="Supported agents">
        {Object.entries(AGENT_NAMES).map(([id, name]) => (
          <article className="agent-card operations-agent-card" key={id}>
            <div className="agent-card-top">
              <span className={`agent-glyph ${id === 'claude-code' ? 'claude' : ''}`}>
                <AgentBrand name={name} />
              </span>
              <h2>{name}</h2>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
