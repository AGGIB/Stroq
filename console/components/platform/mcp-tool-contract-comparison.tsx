import type { McpToolContractComparison } from '@/lib/mcp-tool-contract-comparison';
import { getMcpToolContractFragment } from '@/lib/mcp-tool-contract-comparison';
import { formatMcpToolContract, mcpToolContractText } from '@/lib/mcp-tool-contract-presentation';

export function mcpToolComparisonLabel(comparison: McpToolContractComparison) {
  switch (comparison.status) {
    case 'first-seen':
      return 'First observed version';
    case 'baseline-unavailable':
      return 'Earlier approval body unavailable';
    case 'incomplete':
      return 'Comparison incomplete';
    case 'unchanged':
      return 'No changes since approval';
    case 'changed': {
      const count = Object.values(comparison.counts!).reduce((sum, value) => sum + value, 0);
      return `${count} ${count === 1 ? 'field' : 'fields'} changed`;
    }
  }
}

function ContractValue({ value, label }: { value: string | undefined; label: string }) {
  return (
    <div className="mcp-tool-change-value">
      <h4>{label}</h4>
      {value === undefined ? (
        <p className="mcp-tool-value-absent">Not present</p>
      ) : (
        <pre className="mcp-tool-contract-json" tabIndex={0} aria-label={label}>
          {formatMcpToolContract(value)}
        </pre>
      )}
    </div>
  );
}

export function McpToolContractComparison({
  comparison,
  contract,
  previousApprovedContract,
}: {
  comparison: McpToolContractComparison;
  contract: string;
  previousApprovedContract: string | null;
}) {
  const complete = comparison.status === 'changed' || comparison.status === 'unchanged';
  return (
    <section className="mcp-tool-comparison" aria-label="Comparison with last approved version">
      <div className="mcp-tool-comparison-heading">
        <h3>
          {comparison.status === 'changed'
            ? 'Changes since approval'
            : mcpToolComparisonLabel(comparison)}
        </h3>
        {complete && comparison.counts && (
          <p className="mcp-tool-change-counts" aria-label="Complete field change counts">
            <span>{comparison.counts.added} added</span>
            <span>{comparison.counts.changed} changed</span>
            <span>{comparison.counts.removed} removed</span>
          </p>
        )}
      </div>
      {comparison.status === 'first-seen' && (
        <p className="control-meta">No approved baseline. Review the full advertised contract.</p>
      )}
      {comparison.status === 'baseline-unavailable' && (
        <p className="control-meta">
          An earlier approval is recorded, but its full contract body is unavailable.
        </p>
      )}
      {comparison.status === 'incomplete' && (
        <p className="control-meta">
          The comparison limit was reached. Full contract bodies remain available below.
        </p>
      )}
      {comparison.status === 'changed' && (
        <div className="mcp-tool-changes">
          {comparison.changes.map((change) => (
            <details className="mcp-tool-change" key={change.path}>
              <summary>
                <span className="mcp-tool-change-kind">{change.kind}</span>
                <code>
                  {change.path === '' ? '(root)' : mcpToolContractText(JSON.stringify(change.path))}
                </code>
              </summary>
              <div className="mcp-tool-change-values">
                <ContractValue
                  label="Last approved"
                  value={
                    previousApprovedContract === null
                      ? undefined
                      : getMcpToolContractFragment(previousApprovedContract, change.path)
                  }
                />
                <ContractValue
                  label="Advertised now"
                  value={getMcpToolContractFragment(contract, change.path)}
                />
              </div>
            </details>
          ))}
        </div>
      )}
      <details className="artifact-section mcp-tool-full-contracts">
        <summary>Full contract bodies</summary>
        <section className="mcp-tool-definition" aria-label="Captured tool contract">
          <h3>Captured contract</h3>
          <pre className="mcp-tool-contract-json" tabIndex={0}>
            {formatMcpToolContract(contract)}
          </pre>
        </section>
        {previousApprovedContract !== null && (
          <section className="mcp-tool-definition" aria-label="Earlier approved contract">
            <h3>Earlier approved contract</h3>
            <pre className="mcp-tool-contract-json" tabIndex={0}>
              {formatMcpToolContract(previousApprovedContract)}
            </pre>
          </section>
        )}
      </details>
    </section>
  );
}
