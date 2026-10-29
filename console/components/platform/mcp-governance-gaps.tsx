'use client';
import type { McpGovernanceCapture } from '@/lib/mcp-governance';
export function McpGovernanceGaps({ gaps }: { gaps: McpGovernanceCapture['gaps'] }) {
  if (!gaps.length) return null;
  return (
    <details className="mcp-governance-evidence">
      <summary>Inspection gaps · {gaps.length}</summary>
      <p className="control-meta">
        This is a partial registration capture. Other sources and runtime identities can differ.
      </p>
      <ul>
        {gaps.map((g, i) => (
          <li key={`${g.code}:${i}`}>
            {g.code.replaceAll('-', ' ')}
            {g.agent ? ` · ${g.agent}` : ''}
            {g.scope !== 'unknown' ? ` · ${g.scope}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
