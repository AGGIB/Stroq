'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import {
  AgentGlyph,
  Badge,
  EmptyState,
  ExportButton,
  PageHeading,
  Panel,
} from '@/components/platform-ui';
import { INVENTORY_AGENTS } from '@/lib/inventory';
import { mcpToolContractText } from '@/lib/mcp-tool-contract-presentation';
import { mcpToolContractHref, mcpToolContractSelection } from '@/lib/mcp-tool-contract-navigation';
import { useMcpToolContracts } from './use-mcp-tool-contracts';
import { McpToolContractDetail, toolContractLabel } from './mcp-tool-contract-detail';
import { mcpToolComparisonLabel } from './mcp-tool-contract-comparison';

export function McpToolContractsPage() {
  const selection = mcpToolContractSelection(useSearchParams()),
    action = useMcpToolContracts(selection),
    { state, registration, workspaceId } = action;
  const blocked =
    selection.invalid || (selection.requested && selection.workspaceId !== workspaceId);
  const missing =
    state?.available &&
    selection.requested &&
    (!registration || action.bindingMismatch || (selection.toolId && !action.tool));
  const select = (href: string) => {
    action.invalidate();
    window.history.pushState(null, '', href);
  };
  const close = () => {
    action.invalidate();
    window.history.replaceState(
      null,
      '',
      registration
        ? mcpToolContractHref({
            workspaceId,
            registrationId: registration.id,
            bindingId: registration.bindingId,
          })
        : mcpToolContractHref(),
    );
  };
  const affected = action.affected
    ? state?.registrations.find((row) => row.bindingId === action.affected?.bindingId)
    : null;
  return (
    <div className="page-stack">
      <PageHeading
        title="MCP tool review"
        actions={
          <>
            <Link className="button subtle" href="/skills/mcp/">
              <ArrowLeft size={16} aria-hidden="true" />
              MCP recovery
            </Link>
            <button
              className="button"
              disabled={!action.allowed || !!action.busy}
              onClick={action.refresh}
            >
              <RefreshCw
                size={16}
                className={action.busy === 'load' ? 'spin' : undefined}
                aria-hidden="true"
              />
              Refresh records
            </button>
            {state && (
              <ExportButton
                filename="stroq-mcp-tool-contracts.json"
                label="Export evidence"
                data={action.getEvidence}
              />
            )}
          </>
        }
      />
      {action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {action.needsRecheck && (
        <p className="control-error" role="status">
          Decision completion is unknown. Recheck the affected exact version before another action.{' '}
          {affected && action.affected && (
            <Link
              className="inline-link"
              href={mcpToolContractHref({
                workspaceId,
                registrationId: affected.id,
                bindingId: affected.bindingId,
                toolId: action.affected.toolId,
                contractSha256: action.affected.sha256,
              })}
              onClick={action.invalidate}
            >
              Open affected tool <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </p>
      )}
      {blocked ? (
        <Panel>
          <EmptyState
            title={selection.invalid ? 'Invalid tool-contract link' : 'Different workspace'}
            description="An exact registration and connection binding are required."
          />
          <Link className="button" href={mcpToolContractHref()} onClick={action.invalidate}>
            Open current records
          </Link>
        </Panel>
      ) : !action.localAccess ? (
        <Panel>
          <EmptyState
            title="Connect your local engine"
            description="Open the private local link to read recorded MCP tool contracts."
          />
          <Link className="button" href="/settings/">
            Connection settings
          </Link>
        </Panel>
      ) : !state ? (
        <Panel>
          <EmptyState
            title={action.busy ? 'Reading recorded contracts…' : 'Records unavailable'}
            description="No server is launched by this page."
          />
        </Panel>
      ) : !state.available ? (
        <Panel>
          <EmptyState
            title="Tool-contract records unavailable"
            description={
              state.reason === 'runtime-unavailable'
                ? 'The local review runtime is unavailable.'
                : state.reason === 'context-unavailable'
                  ? 'The workspace context could not be verified.'
                  : 'Private tool-contract storage could not be read safely.'
            }
          />
        </Panel>
      ) : (
        <>
          {!!state.gaps.length && (
            <p className="control-error" role="status">
              Registration coverage is incomplete. Unlisted connections are not established as
              absent.
            </p>
          )}
          {missing && (
            <p className="control-error" role="status">
              {action.bindingMismatch
                ? 'The registration connection binding changed.'
                : action.versionMismatch
                  ? 'The selected tool version changed.'
                  : 'This exact recorded registration or tool is unavailable.'}{' '}
              <Link
                className="inline-link"
                href={mcpToolContractHref()}
                onClick={action.invalidate}
              >
                Open current records
              </Link>
            </p>
          )}
          <Panel
            title={registration ? 'Selected registration' : 'Opted-in registrations'}
            actions={
              registration ? (
                <button className="inline-link" onClick={() => select(mcpToolContractHref())}>
                  All registrations
                </button>
              ) : undefined
            }
          >
            {!state.registrations.length ? (
              <EmptyState
                title={
                  state.gaps.length
                    ? 'Registration coverage unavailable'
                    : 'No opted-in registrations'
                }
                description="Choose Protect & review tools on an eligible installed MCP entry."
              />
            ) : (
              <div
                className="table-scroll mcp-tool-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Opted-in MCP registrations"
              >
                <table className="data-table mcp-tool-registrations">
                  <thead>
                    <tr>
                      <th>Registration</th>
                      <th>Client & scope</th>
                      <th>Observed listing</th>
                      <th>Needs review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(registration ? [registration] : state.registrations).map((row) => (
                      <tr key={row.id}>
                        <td>
                          <button
                            className="inventory-name-button"
                            onClick={() =>
                              select(
                                mcpToolContractHref({
                                  workspaceId,
                                  registrationId: row.id,
                                  bindingId: row.bindingId,
                                }),
                              )
                            }
                          >
                            {row.name}
                            <ArrowRight size={14} aria-hidden="true" />
                          </button>
                        </td>
                        <td>
                          <span className="agent-label">
                            <AgentGlyph name={row.agent} />
                            {INVENTORY_AGENTS[row.agent]}
                          </span>
                          <small className="mcp-source-caption">
                            {row.scope === 'user' ? 'User · multiple workspaces' : 'Workspace'}
                          </small>
                        </td>
                        <td>
                          <Badge tone={row.status === 'incomplete' ? 'orange' : 'muted'}>
                            {row.status === 'none'
                              ? 'Awaiting tool listing'
                              : row.status === 'incomplete'
                                ? 'Listing incomplete'
                                : 'Complete capture'}
                          </Badge>
                          {row.observedAt && (
                            <small className="mcp-source-caption">
                              {new Date(row.observedAt).toLocaleString('en-GB')}
                            </small>
                          )}
                        </td>
                        <td>
                          {row.status === 'complete'
                            ? row.tools.filter((tool) => tool.decision === 'pending').length
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="panel-body">
              <Link className="inline-link" href="/skills/?kind=mcp">
                Inspect installed MCP entries <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </Panel>
          {registration && (
            <Panel title="Observed tools">
              {registration.status === 'none' ? (
                <EmptyState
                  title="No complete listing observed"
                  description="Reconnect this registration in its client. Tool versions are observed through the existing opted-in proxy."
                />
              ) : registration.status === 'incomplete' ? (
                <EmptyState
                  title="Tool listing incomplete"
                  description="This capture was invalidated. Incomplete listings cannot be approved."
                />
              ) : !registration.tools.length ? (
                <EmptyState
                  title="No tools advertised in this capture"
                  description="A complete empty listing was observed. This is not an active-client health check."
                />
              ) : (
                <div
                  className="table-scroll mcp-tool-table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Observed MCP tools"
                >
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th>Version decision</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {registration.tools.map((tool) => (
                        <tr key={tool.id}>
                          <td>
                            <strong>{mcpToolContractText(tool.name)}</strong>
                            <small className="mcp-source-caption">
                              {mcpToolComparisonLabel(tool.comparison)}
                            </small>
                          </td>
                          <td>
                            <Badge tone={tool.decision === 'pending' ? 'orange' : 'muted'}>
                              {toolContractLabel(registration, tool)}
                            </Badge>
                          </td>
                          <td>
                            <button
                              className="button small"
                              onClick={() =>
                                select(
                                  mcpToolContractHref({
                                    workspaceId,
                                    registrationId: registration.id,
                                    bindingId: registration.bindingId,
                                    toolId: tool.id,
                                    contractSha256: tool.sha256,
                                  }),
                                )
                              }
                            >
                              Review version <ArrowRight size={14} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <details className="artifact-section mcp-tool-history">
                <summary>Decision history · {registration.history.length}</summary>
                {registration.history.length ? (
                  <ol>
                    {registration.history.map((row, index) => (
                      <li key={index}>
                        <Badge>
                          {row.action === 'approve' ? 'Approval recorded' : 'Revocation recorded'}
                        </Badge>
                        <span>{new Date(row.at).toLocaleString('en-GB')}</span>
                        <code>
                          {row.toolId.slice(0, 13)} · {row.contractSha256.slice(0, 12)}
                        </code>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="control-meta">No decisions recorded for this binding.</p>
                )}
              </details>
            </Panel>
          )}
          <details className="artifact-section">
            <summary>Observation & private retention limits</summary>
            {state.limitations.map((line) => (
              <p className="control-meta" key={line}>
                {line}
              </p>
            ))}
          </details>
        </>
      )}
      <McpToolContractDetail action={action} onClose={close} />
    </div>
  );
}
