'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { RefreshCw, Server } from 'lucide-react';
import { Badge, EmptyState, Panel } from '@/components/platform-ui';
import { mcpCallControlLocation, mcpCallControlSelected } from '@/lib/mcp-call-control-navigation';
import type { McpCallControlOverviewRow } from '@/lib/mcp-call-control-overview';
import { inventoryHref } from '@/lib/inventory-navigation';
import { McpCallControl } from './mcp-call-control';
import { useMcpCallControls } from './use-mcp-call-controls';

const label = (row: McpCallControlOverviewRow) =>
  row.current?.mode === 'paused'
    ? 'Desired: paused'
    : row.current?.mode === 'enabled'
      ? 'Desired: enabled'
      : 'Authority unavailable';
export function McpCallControls() {
  const location = mcpCallControlLocation(useSearchParams()),
    action = useMcpCallControls(location),
    { state } = action;
  const resolved = mcpCallControlSelected(location, state);
  const [opened, setOpened] = useState<{ contextId: string; controlId: string } | null>(null),
    [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const selectedId = location.requested
    ? resolved === 'selected'
      ? location.controlId
      : null
    : opened?.contextId === state?.contextId
      ? opened?.controlId
      : null;
  useEffect(() => {
    if (resolved === 'selected') anchor.current?.focus();
  }, [resolved, location.controlId, location.contextId]);
  if (!action.localAccess) return null;
  const invalid = ['invalid', 'different-profile', 'missing'].includes(resolved);
  const rows = invalid ? [] : (state?.controls ?? []),
    selected = rows.find((row) => row.controlId === selectedId) ?? null;
  const visibleIds = new Set(selected?.artifact ? [selected.artifact.id] : []);
  const pending = invalid
    ? []
    : [...action.pending, ...action.foreignPending, ...action.unscopedPending].filter(
        (w) => !visibleIds.has(w.preview.artifact.id),
      );
  const recoveryArtifacts = [
    ...new Map(pending.map((w) => [w.preview.artifact.id, w.preview.artifact])).values(),
  ];
  return (
    <div ref={anchor} tabIndex={-1} id="call-controls" role="region" aria-label="MCP call controls">
      <Panel
        title="Call controls"
        actions={
          <button
            className="button"
            disabled={busy || action.loading || location.invalid}
            onClick={() => void action.refresh()}
          >
            <RefreshCw size={16} className={action.loading ? 'spin' : undefined} />
            Refresh controls
          </button>
        }
      >
        {invalid ? (
          <div className="panel-body">
            <p className="control-error" role="status">
              {resolved === 'invalid'
                ? 'Invalid call-control link.'
                : resolved === 'different-profile'
                  ? 'This link belongs to a different local profile.'
                  : 'This exact call control is unavailable.'}
            </p>
            {location.contextId && <code className="inventory-digest">{location.contextId}</code>}
            <Link className="inline-link" href="/skills/mcp/">
              Open local controls
            </Link>
          </div>
        ) : (
          <>
            {action.error && (
              <div className="panel-body">
                <p className="control-error" role="alert">
                  {action.error}
                </p>
              </div>
            )}
            {state && (state.authority === 'unavailable' || state.gaps.length > 0) && (
              <div className="panel-body">
                <p className="control-meta" role="status">
                  Some control evidence could not be verified. No enabled state is inferred.
                </p>
              </div>
            )}
            {!rows.length && !recoveryArtifacts.length ? (
              <EmptyState
                title={
                  action.loading
                    ? 'Reading call controls…'
                    : state?.authority === 'unavailable'
                      ? 'Call-control authority unavailable'
                      : 'No retained call controls'
                }
                description="Set up call control from an installed MCP registration."
              />
            ) : (
              <div className="panel-body">
                {rows.map((row) => (
                  <div className="artifact-section" key={row.controlId}>
                    <div className="inventory-signal-heading">
                      <button
                        className="inventory-name"
                        disabled={busy}
                        aria-expanded={selectedId === row.controlId}
                        aria-label={
                          'Inspect call control for ' + (row.artifact?.name ?? row.controlId)
                        }
                        onClick={() => {
                          if (location.requested) {
                            window.history.replaceState(null, '', '/skills/mcp/');
                          }
                          setOpened({
                            contextId: state!.contextId,
                            controlId: selectedId === row.controlId ? '' : row.controlId,
                          });
                        }}
                      >
                        <Server size={18} aria-hidden="true" />
                        <strong>{row.artifact?.name ?? 'Retained control'}</strong>
                      </button>
                      <Badge
                        tone={
                          ['drifted', 'ambiguous', 'unavailable'].includes(row.capability) ||
                          !row.current ||
                          (row.capability === 'missing-registration' &&
                            row.current.mode === 'enabled') ||
                          (['prepared', 'authority-recorded', 'configuration-unconfirmed'].includes(
                            row.setup,
                          ) &&
                            (row.setupConfiguration !== 'confirmed' || !row.current))
                            ? 'orange'
                            : 'muted'
                        }
                      >
                        {label(row)}
                      </Badge>
                    </div>
                    {row.capability === 'missing-registration' && (
                      <p className="control-meta">
                        Registration not in this view · a running controlled proxy may still accept
                        calls.
                      </p>
                    )}
                    {['prepared', 'authority-recorded', 'configuration-unconfirmed'].includes(
                      row.setup,
                    ) &&
                      (row.setupConfiguration !== 'confirmed' || !row.current) && (
                        <p className="control-meta">
                          Setup recovery needs attention · {row.setup.replaceAll('-', ' ')}.
                        </p>
                      )}
                    {selectedId === row.controlId && row.artifact && state && (
                      <McpCallControl
                        target={
                          row.capability === 'supported' || !row.retainedSetupId
                            ? {
                                kind: 'source',
                                id: row.artifact.id,
                                expectedSha256: row.artifact.sha256,
                              }
                            : { kind: 'retained', state, row }
                        }
                        setupRecovery={
                          row.setupCandidate
                            ? {
                                workspaceId: state.workspaceId,
                                contextId: state.contextId,
                                controlId: row.controlId,
                                candidate: row.setupCandidate,
                              }
                            : null
                        }
                        onBusyChange={setBusy}
                        onChanged={() => void action.refresh()}
                      />
                    )}
                    {selectedId === row.controlId && !row.artifact && (
                      <p className="control-meta">
                        The retained source could not be verified. Restore access to it before
                        changing this control.
                      </p>
                    )}
                    {selectedId === row.controlId &&
                      row.artifact &&
                      row.capability !== 'missing-registration' && (
                        <Link
                          className="inline-link"
                          href={inventoryHref(
                            row.artifact.id,
                            state!.workspaceId,
                            row.artifact.sha256,
                            'mcp',
                          )}
                          aria-disabled={busy}
                          tabIndex={busy ? -1 : undefined}
                          onClick={(e) => {
                            if (busy) e.preventDefault();
                          }}
                        >
                          Open current registration
                        </Link>
                      )}
                  </div>
                ))}
                {recoveryArtifacts.map((artifact) => (
                  <div className="artifact-section" key={artifact.id}>
                    <div className="inventory-signal-heading">
                      <h3>{artifact.name}</h3>
                      <Badge tone="orange">
                        {action.pending.some((w) => w.preview.artifact.id === artifact.id)
                          ? 'Completion unknown'
                          : action.contextId
                            ? 'Other local profile'
                            : 'Profile not verified'}
                      </Badge>
                    </div>
                    <McpCallControl
                      target={{ kind: 'recovery', id: artifact.id, contextId: action.contextId }}
                      disabled={busy}
                      onBusyChange={setBusy}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
