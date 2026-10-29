'use client';
import { useSearchParams } from 'next/navigation';
import { useRef } from 'react';
import { ArrowRight, ClipboardCheck, LoaderCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { Badge, EmptyState, ExportButton, PageHeading, Panel } from '@/components/platform-ui';
import { INCIDENT_KINDS, type Incident } from '@/lib/incidents';
import { CapturedJournalPanel, IncidentDetailDialog } from './incident-detail';
import { useIncidentEvidence } from './use-incidents';
import { useIncidentAssessments } from './use-incident-assessments';
import { IncidentAssessmentBadge } from './incident-assessments';
import { assessmentForIncident, incidentAssessmentIndex } from '@/lib/incident-assessment-queue';
import { incidentAssessmentExport } from '@/lib/incident-assessment-export';
import { incidentHref, incidentSelection, type IncidentFilter } from '@/lib/incident-navigation';

export function IncidentsPage() {
  const location = incidentSelection(useSearchParams());
  const {
    localAccess,
    state,
    verification,
    comparisons,
    busy,
    error,
    refresh,
    verify,
    review,
    compare,
  } = useIncidentEvidence();
  const filter = location.filter;
  const selected = localAccess
    ? (state?.incidents.find((item) => item.id === location.id) ?? null)
    : null;
  const assessments = useIncidentAssessments(selected);
  const assessmentApplying = assessments.busy === 'apply';
  const selectionLocked = useRef(false);
  selectionLocked.current = assessmentApplying;
  const assessmentIndex = incidentAssessmentIndex(assessments.state);
  const pendingFindings = new Set(assessments.pending.map((write) => write.preview.incident.id));
  const returnFocus = useRef<HTMLElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const page = useRef<HTMLDivElement | null>(null);
  const select = (incident: Incident | null, trigger?: HTMLElement) => {
    if (selectionLocked.current) return;
    if (incident && !selected) returnFocus.current = trigger ?? null;
    const href = incidentHref(incident?.id ?? null, filter);
    if (incident) window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
  };
  const setFilter = (value: IncidentFilter) => {
    if (!selectionLocked.current)
      window.history.pushState(null, '', incidentHref(location.id, value));
  };
  const rows = (state?.incidents ?? []).filter((i) => filter === 'all' || i.status === filter);
  const open = state?.incidents.filter((i) => i.status === 'open').length ?? 0;
  return (
    <div className="page-stack" ref={page} tabIndex={-1} role="region" aria-label="Investigations">
      <PageHeading
        title="Investigations"
        actions={
          <>
            <button
              className="button"
              ref={refreshButton}
              disabled={!localAccess || Boolean(busy) || Boolean(assessments.busy)}
              onClick={() => {
                void refresh();
                void assessments.refresh();
              }}
            >
              <RefreshCw size={16} className={busy === 'load' ? 'spin' : undefined} />
              Refresh
            </button>
            {state && (
              <ExportButton
                data={() => ({
                  schema: 'stroq-investigations-export/2',
                  source: 'local',
                  exportedAt: new Date().toISOString(),
                  evidence: state,
                  operatorAssessments: incidentAssessmentExport(
                    assessments.state,
                    assessments.pending,
                    state.incidents,
                  ),
                })}
                filename="stroq-investigations.json"
              />
            )}
          </>
        }
      />
      {error && (
        <p className="control-error" role="alert">
          {error}
          {state ? ' Earlier evidence remains visible.' : ''}
        </p>
      )}
      {localAccess && (location.invalid || (state && location.id && !selected)) && (
        <p className="control-error" role="status">
          {location.invalid
            ? 'This investigation link is invalid.'
            : 'The requested finding is outside the displayed journal window or is no longer available.'}
          <button className="inline-link" onClick={() => select(null)}>
            Clear selection
          </button>
        </p>
      )}
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect the local journal"
            description="Open the private server link to investigate recorded decisions and content findings."
          />
        </Panel>
      ) : (
        <>
          <div className="investigation-summary">
            <div>
              <span>Awaiting review</span>
              <strong>{state ? open : '—'}</strong>
            </div>
            <div>
              <span>Recorded findings</span>
              <strong>{state ? state.incidents.length : '—'}</strong>
            </div>
            <div>
              <span>Captured journal</span>
              <strong className="investigation-integrity-label">
                {verification?.status === 'consistent'
                  ? 'Consistent'
                  : verification?.status === 'broken'
                    ? 'Broken'
                    : verification
                      ? 'Unverified'
                      : 'Not checked'}
              </strong>
            </div>
          </div>
          <Panel title="Recorded evidence" actions={<Badge tone="muted">Local journal</Badge>}>
            <div className="inventory-toolbar">
              <div className="filter-tabs" role="group" aria-label="Investigation status">
                {(['open', 'reviewed', 'all'] as const).map((value) => (
                  <button
                    key={value}
                    className={filter === value ? 'is-active' : ''}
                    aria-pressed={filter === value}
                    disabled={assessmentApplying}
                    onClick={() => setFilter(value)}
                  >
                    {value === 'open' ? 'Needs review' : value === 'reviewed' ? 'Reviewed' : 'All'}
                  </button>
                ))}
              </div>
              <span className="control-meta">Policy intent and observations</span>
            </div>
            {!state && busy === 'load' ? (
              <div className="control-empty">
                <LoaderCircle className="spin" size={25} />
                <p>Reading recorded evidence…</p>
              </div>
            ) : state?.window.kind === 'refused' ? (
              <EmptyState
                title="Journal could not be read safely"
                description="This is a coverage gap. No absence of findings is inferred."
              />
            ) : rows.length === 0 ? (
              <EmptyState
                title={
                  state?.window.kind === 'missing'
                    ? 'No local journal yet'
                    : 'No findings in this view'
                }
                description="Only recorded policy denies, approval requests and content findings appear here."
              />
            ) : (
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Recorded incident findings"
              >
                <table className="data-table investigation-table">
                  <thead>
                    <tr>
                      <th>Finding</th>
                      <th>Context</th>
                      <th>Status</th>
                      <th>Recorded · UTC</th>
                      <th aria-label="Investigate" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <button
                            className="inventory-name"
                            disabled={assessmentApplying}
                            onClick={(event) => select(item, event.currentTarget)}
                          >
                            <ShieldAlert size={18} />
                            <span>
                              <strong>{item.title}</strong>
                              <small>
                                Journal #{item.sequence} · {INCIDENT_KINDS[item.kind]}
                              </small>
                            </span>
                          </button>
                        </td>
                        <td>
                          {item.categories.map((c) => (
                            <Badge key={c} tone="muted">
                              {c.replaceAll('-', ' ')}
                            </Badge>
                          ))}
                        </td>
                        <td>
                          <Badge tone={item.status === 'open' ? 'orange' : 'muted'}>
                            {item.status === 'open' ? 'Needs review' : 'Reviewed'}
                          </Badge>
                          <div className="control-meta">
                            <IncidentAssessmentBadge
                              record={assessmentForIncident(assessmentIndex, item)}
                              unavailable={assessmentIndex === null}
                              pending={pendingFindings.has(item.id)}
                            />
                          </div>
                        </td>
                        <td className="mono muted">
                          {new Date(item.recordedAt).toISOString().replace('T', ' ').slice(0, 19)}
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`Investigate journal entry ${item.sequence}`}
                            disabled={assessmentApplying}
                            onClick={(event) => select(item, event.currentTarget)}
                          >
                            <ArrowRight size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {state && (state.window.truncated || state.window.omitted > 0) && (
              <p className="investigation-window-note">
                Bounded journal window
                {state.window.truncated ? ' · earlier entries not loaded' : ''}
                {state.window.omitted
                  ? ` · ${state.window.omitted} entries omitted from this view`
                  : ''}
              </p>
            )}
          </Panel>
          <CapturedJournalPanel
            verification={verification}
            disabled={Boolean(busy) || assessmentApplying}
            verifying={busy === 'verify'}
            onVerify={() => void verify()}
          />
          {state && (
            <details className="panel">
              <summary className="panel-heading">
                <h2>Evidence limits</h2>
                <ClipboardCheck size={17} />
              </summary>
              <div className="panel-body">
                {state.limitations.map((limit) => (
                  <p className="control-meta" key={limit}>
                    {limit}
                  </p>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      <IncidentDetailDialog
        selected={selected}
        assessments={assessments}
        incidents={state?.incidents ?? []}
        busy={Boolean(busy) || assessmentApplying}
        reviewing={busy === 'review'}
        error={error}
        onSelect={select}
        onReview={(incident) => void review(incident)}
        comparison={
          selected
            ? (comparisons.find(
                (item) =>
                  item.incidentId === selected.id && item.evidenceSha === selected.evidenceSha,
              ) ?? null)
            : null
        }
        comparing={busy === 'compare'}
        href={incidentHref(selected?.id ?? null, filter)}
        onCompare={(incident) => void compare(incident)}
        onReturnFocus={() => {
          const trigger = returnFocus.current;
          if (trigger?.isConnected) trigger.focus();
          else if (refreshButton.current && !refreshButton.current.disabled)
            refreshButton.current.focus();
          else page.current?.focus();
          returnFocus.current = null;
        }}
      />
    </div>
  );
}
