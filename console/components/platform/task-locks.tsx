'use client';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Ban, LoaderCircle, RefreshCw, X } from 'lucide-react';
import {
  AgentGlyph,
  Badge,
  EmptyState,
  ExportButton,
  PageHeading,
  Panel,
} from '@/components/platform-ui';
import { CopyLocalLink } from '@/components/local-link';
import { taskLockHref, taskLockSelection } from '@/lib/task-lock-navigation';
import { taskLockApplyInput } from '@/lib/task-lock-binding';
import { incidentHref } from '@/lib/incident-navigation';
import type { SafeGlob, TaskLockRow } from '@/lib/task-locks';
import { useTaskLocks } from './use-task-locks';
import { TaskAccessLedger } from './task-access-ledger';

const time = (value: string) => new Date(value).toLocaleString('en-GB');
const name = (task: TaskLockRow) => `Task ${task.id.slice(5, 13)}`;
const eligibility = {
  eligible: 'Within validity period',
  expired: 'Expired',
  'not-yet-valid': 'Not yet valid',
};
const standing = { present: 'Present', revoked: 'Revoked', ended: 'Ended' };
const policy = {
  'matches-current': 'Matches current policy',
  'differs-current': 'Launch policy differs',
  unavailable: 'Current policy unavailable',
};
const evidence = {
  verified: 'Captured journal consistent',
  missing: 'No captured task events',
  unavailable: 'Task evidence unavailable',
  limit: 'Evidence exceeds capture limit',
  broken: 'Captured journal is broken',
};
function GlobRules({ title, rows }: { title: string; rows: SafeGlob[] }) {
  return (
    <div>
      <dt>{title}</dt>
      <dd>
        {rows.length ? (
          <ul>
            {rows.map((row, index) => (
              <li key={`${row.id}:${index}`}>
                <code>
                  {row.root === 'external'
                    ? 'External path · withheld'
                    : row.pattern === null
                      ? `${row.root === 'workspace' ? 'Workspace' : 'User home'} path · withheld`
                      : `${row.root === 'workspace' ? 'Workspace' : 'User home'}/${row.pattern}`}
                </code>
              </li>
            ))}
          </ul>
        ) : (
          'None'
        )}
      </dd>
    </div>
  );
}
function TaskScope({ task }: { task: TaskLockRow }) {
  return (
    <details className="setup-next">
      <summary>Permission scope</summary>
      <dl className="property-list">
        <div>
          <dt>Tools</dt>
          <dd>{task.scope.tools.length ? task.scope.tools.join(' · ') : 'None'}</dd>
        </div>
        <div>
          <dt>Shell</dt>
          <dd>{task.scope.shell}</dd>
        </div>
        <GlobRules title="Read allow" rows={task.scope.read.allow} />
        <GlobRules title="Read deny" rows={task.scope.read.deny} />
        <GlobRules title="Write allow" rows={task.scope.write.allow} />
        <GlobRules title="Write deny" rows={task.scope.write.deny} />
        <div>
          <dt>Tool network</dt>
          <dd>
            {task.scope.net.mode === 'none'
              ? 'None'
              : task.scope.net.hosts.join(' · ') || 'No hosts'}
          </dd>
        </div>
        <div>
          <dt>MCP grants</dt>
          <dd>
            {task.scope.mcp.length ? (
              <ul>
                {task.scope.mcp.map((grant, index) => (
                  <li key={`${grant.server}:${index}`}>
                    {grant.server} ·{' '}
                    {grant.tools === '*' ? 'All tools' : grant.tools.join(' · ') || 'No tools'}
                  </li>
                ))}
              </ul>
            ) : (
              'None'
            )}
          </dd>
        </div>
      </dl>
    </details>
  );
}
function TaskDetails({ task }: { task: TaskLockRow }) {
  const counts = task.evidence.counts;
  return (
    <>
      <dl className="property-list">
        <div>
          <dt>Permission</dt>
          <dd>{standing[task.standing]}</dd>
        </div>
        <div>
          <dt>Valid until</dt>
          <dd>{time(task.expiresAt)}</dd>
        </div>
        <div>
          <dt>Declared mode</dt>
          <dd>{task.declaredMode}</dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd>{policy[task.policyRelation]}</dd>
        </div>
      </dl>
      <TaskScope task={task} />
      <details className="setup-next">
        <summary>Captured task evidence</summary>
        <p className="control-meta">{evidence[task.evidence.status]}</p>
        {counts && (
          <dl className="property-list">
            <div>
              <dt>Recorded calls</dt>
              <dd>{counts.calls}</dd>
            </div>
            <div>
              <dt>Gate allowed / denied / asked</dt>
              <dd>
                {counts.allowed} / {counts.denied} / {counts.asks}
              </dd>
            </div>
            <div>
              <dt>Host-reported completion pairs</dt>
              <dd>{counts.hostReported}</dd>
            </div>
            <div>
              <dt>Host-reported failures</dt>
              <dd>{counts.hostFailure}</dd>
            </div>
            <div>
              <dt>Unconfirmed</dt>
              <dd>{counts.unconfirmed}</dd>
            </div>
          </dl>
        )}
        {task.evidence.lastGate && (
          <p className="control-meta">
            Last gate: {task.evidence.lastGate.effect} · {task.evidence.lastGate.kind} ·{' '}
            {time(task.evidence.lastGate.at)}
          </p>
        )}
        <p className="control-meta">
          Recorded tool reports do not establish that a process is running or has stopped.
        </p>
      </details>
      <details className="setup-next">
        <summary>Permit fingerprints</summary>
        <dl className="property-list">
          <div>
            <dt>Task reference</dt>
            <dd className="inventory-digest">{task.id}</dd>
          </div>
          <div>
            <dt>Permit SHA-256</dt>
            <dd className="inventory-digest">{task.permitSha256}</dd>
          </div>
          <div>
            <dt>Launch policy SHA-256</dt>
            <dd className="inventory-digest">{task.policySha256}</dd>
          </div>
          <div>
            <dt>Profile</dt>
            <dd>{task.profile}</dd>
          </div>
          <div>
            <dt>Issued</dt>
            <dd>{time(task.issuedAt)}</dd>
          </div>
        </dl>
        <p className="control-meta">
          Existing tasks retain their launch policy. The declared mode does not verify OS isolation.
        </p>
      </details>
    </>
  );
}

export function TaskLocksPage() {
  const selection = taskLockSelection(useSearchParams());
  const action = useTaskLocks(selection);
  const selected = action.task ?? action.receiptTask;
  const state = action.state;
  const task = action.preview?.task ?? selected;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const refresh = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const previous = useRef<string | null>(null);
  const blocked =
    selection.invalid ||
    action.permitMismatch ||
    (action.workspaceId !== null &&
      selection.requested &&
      selection.workspaceId !== action.workspaceId);
  const close = () => {
    action.invalidate();
    window.history.replaceState(null, '', taskLockHref());
  };
  const pageNavigate = (navigate: () => void) => {
    navigate();
    window.history.replaceState(null, '', taskLockHref());
  };
  const open = (row: TaskLockRow, button: HTMLButtonElement) => {
    trigger.current = button;
    action.invalidate();
    window.history.pushState(
      null,
      '',
      taskLockHref(row.id, action.workspaceId, {
        permitSha256: row.permitSha256,
      }),
    );
  };
  useEffect(() => {
    if (selected?.id && previous.current !== selected.id) heading.current?.focus();
    previous.current = selected?.id ?? null;
  }, [selected?.id]);
  return (
    <div className="page-stack">
      <PageHeading
        title="Task permissions"
        actions={
          <>
            <Link className="button subtle" href="/agents/">
              <ArrowLeft size={16} />
              Agents
            </Link>
            {selection.originIncidentId && (
              <Link
                className="button subtle"
                href={incidentHref(selection.originIncidentId, 'all')}
              >
                Return to finding <ArrowRight size={16} />
              </Link>
            )}
            <button
              ref={refresh}
              className="button"
              disabled={!action.allowed || Boolean(action.busy)}
              onClick={action.refresh}
            >
              <RefreshCw size={16} className={action.busy === 'load' ? 'spin' : undefined} />
              {action.needsRecheck ? 'Recheck permissions' : 'Refresh'}
            </button>
            {!state && action.canResetPage && (
              <button
                className="button subtle"
                disabled={!!action.busy}
                onClick={() => pageNavigate(action.firstPage)}
              >
                Open first page
              </button>
            )}
            {state && (
              <ExportButton
                data={() => ({
                  schema: 'stroq-task-permission-export/1',
                  exportedAt: new Date().toISOString(),
                  state,
                  page: action.page?.page ?? null,
                  origin: selection.originIncidentId
                    ? {
                        incidentId: selection.originIncidentId,
                        expectedPermitSha256: selection.expectedPermitSha256,
                        relationship: 'navigation-only',
                      }
                    : null,
                  receipt: action.receipt,
                })}
                filename="stroq-task-permissions.json"
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
          Revocation completion is unknown. Recheck the affected permission before another action.
          {action.unknownTask && (
            <>
              {' '}
              <Link
                className="inline-link"
                href={taskLockHref(action.unknownTask.id, action.workspaceId, {
                  permitSha256: action.unknownTask.permitSha256,
                })}
                onClick={action.invalidate}
              >
                Open affected permission <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </>
          )}
        </p>
      )}
      {blocked ? (
        <Panel>
          <EmptyState
            title={
              selection.invalid
                ? 'Invalid permission link'
                : action.permitMismatch
                  ? 'Permission version changed'
                  : 'Different workspace'
            }
            description="Open current task permissions to choose an exact record."
          />
          <div className="panel-body">
            <Link className="button" href="/agents/tasks/">
              Open current permissions <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      ) : !action.localAccess ? (
        <Panel>
          <EmptyState
            title="Connect your local engine"
            description="Use the private server link to read task permissions."
          />
        </Panel>
      ) : !state ? (
        <Panel>
          <div className="control-empty" role="status">
            {action.busy === 'load' ? (
              <>
                <LoaderCircle className="spin" size={26} />
                <p>Reading task permissions…</p>
              </>
            ) : (
              <p>Task permissions are unavailable. Refresh to retry.</p>
            )}
          </div>
        </Panel>
      ) : !state.available ? (
        <Panel>
          <EmptyState
            title="Task permissions unavailable"
            description={
              state.reason === 'platform-unsupported'
                ? 'This platform is not supported.'
                : state.reason === 'runtime-unavailable'
                  ? 'The local Stroq runtime is unavailable.'
                  : 'The selected workspace context could not be established.'
            }
          />
        </Panel>
      ) : (
        <>
          <div className="protection-status">
            <div className="protection-status-main">
              <AgentGlyph name="Claude Code" />
              <strong>Claude Code</strong>
              <Badge tone="muted">Signed permission records</Badge>
            </div>
            <time className="control-meta" dateTime={state.checkedAt}>
              Read {time(state.checkedAt)}
            </time>
          </div>
          {selection.taskId && !selected && (
            <p className="control-error">
              This exact permission is not in the current verified records. No other task has been
              substituted.{' '}
              <button className="inline-link" onClick={close}>
                Clear selection
              </button>
            </p>
          )}
          {!state.coverage.complete && (
            <p className="control-meta" role="status">
              This page is a bounded observation. Unlisted tasks are not established as absent.
            </p>
          )}
          {action.page?.page.catalogLimited && (
            <p className="control-error" role="status">
              The task catalog limit was reached. Further permissions may be outside this view.
            </p>
          )}
          <Panel title="Permissions in this workspace">
            <nav className="task-page-controls" aria-label="Task permission pages">
              <span className="control-meta">Page {action.page?.page.index ?? 1}</span>
              <div>
                <button
                  className="button subtle small"
                  disabled={!!action.busy || (action.page?.page.index ?? 1) === 1}
                  onClick={() => pageNavigate(action.firstPage)}
                >
                  First page
                </button>
                <button
                  className="button subtle small"
                  disabled={!!action.busy || !action.canGoBack}
                  onClick={() => pageNavigate(action.previousPage)}
                >
                  Back
                </button>
                <button
                  className="button small"
                  disabled={!!action.busy || !action.page?.page.nextCursor}
                  onClick={() => pageNavigate(action.nextPage)}
                >
                  Next page <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            </nav>
            {state.tasks.length === 0 ? (
              <EmptyState
                title={
                  state.coverage.complete
                    ? 'No verified task permissions'
                    : 'No verified permissions on this page'
                }
                description="This view reads existing Stroq task permits. It does not start an agent or issue new rights."
              />
            ) : (
              <div
                className="table-wrap"
                role="region"
                aria-label="Task permission records"
                tabIndex={0}
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Permission</th>
                      <th>Scope</th>
                      <th>Validity</th>
                      <th>Standing</th>
                      <th>
                        <span className="sr-only">Inspect permission</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.tasks.map((row) => (
                      <tr key={row.id} aria-selected={selected?.id === row.id}>
                        <td>
                          <button
                            className="inventory-name"
                            onClick={(event) => open(row, event.currentTarget)}
                          >
                            <strong>{name(row)}</strong>
                          </button>
                          <span className="control-meta">Declared {row.declaredMode}</span>
                        </td>
                        <td>
                          {row.scope.write.allow.length} write rules · shell {row.scope.shell}
                          <br />
                          <span className="control-meta">
                            {row.policyRelation === 'matches-current'
                              ? 'Launch policy matches'
                              : policy[row.policyRelation]}
                          </span>
                        </td>
                        <td>
                          <span>{eligibility[row.eligibility]}</span>
                          <br />
                          <time className="control-meta" dateTime={row.expiresAt}>
                            {time(row.expiresAt)}
                          </time>
                        </td>
                        <td>
                          <Badge
                            tone={
                              row.standing === 'present' && row.policyRelation !== 'matches-current'
                                ? 'orange'
                                : 'muted'
                            }
                          >
                            {standing[row.standing]}
                          </Badge>
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`Inspect ${name(row)}`}
                            onClick={(event) => open(row, event.currentTarget)}
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
          </Panel>
          <details className="panel">
            <summary className="panel-heading">
              <h2>Scope & limits</h2>
            </summary>
            <div className="panel-body">
              <dl className="property-list">
                <div>
                  <dt>Unverified entries on this page</dt>
                  <dd>{state.coverage.unverified}</dd>
                </div>
                <div>
                  <dt>Other workspace entries on this page</dt>
                  <dd>{state.coverage.foreign}</dd>
                </div>
                <div>
                  <dt>Page coverage limited</dt>
                  <dd>{state.coverage.limited ? 'Yes' : 'No'}</dd>
                </div>
              </dl>
              {state.limitations.map((limit) => (
                <p key={limit} className="control-meta">
                  {limit}
                </p>
              ))}
            </div>
          </details>
        </>
      )}
      <Dialog.Root
        open={selected !== null}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content setup-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              heading.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              requestAnimationFrame(() =>
                (trigger.current?.isConnected ? trigger.current : refresh.current)?.focus(),
              );
            }}
          >
            <div className="dialog-header">
              <Dialog.Title ref={heading} tabIndex={-1}>
                {task ? name(task) : 'Task permission'}
              </Dialog.Title>
              <Dialog.Description>
                Recorded permission · process status unverified
              </Dialog.Description>
              <Dialog.Close className="dialog-close icon-button" aria-label="Close task permission">
                <X size={18} />
              </Dialog.Close>
            </div>
            {task && (
              <div className="setup-body">
                <CopyLocalLink
                  href={taskLockHref(task.id, action.workspaceId, {
                    permitSha256: selection.expectedPermitSha256 ?? task.permitSha256,
                    incidentId: selection.originIncidentId,
                  })}
                />
                {action.receipt ? (
                  <>
                    <div className="live-result-heading">
                      <h3>Permission revoked</h3>
                      <Badge tone="muted">Store readback confirmed</Badge>
                    </div>
                    <p className="control-meta">
                      Recorded {time(action.receipt.checkedAt)} · isolated gate returned Deny.
                    </p>
                    <p className="control-meta">
                      Agent termination is unverified. Revocation affects further gated tools.
                    </p>
                    <details className="setup-next">
                      <summary>Revocation receipt</summary>
                      <code className="inventory-digest">{action.receipt.id}</code>
                    </details>
                  </>
                ) : (
                  <>
                    <TaskDetails task={task} />
                    <TaskAccessLedger task={task} />
                    {action.preview && (
                      <>
                        {action.preview.canApply ? (
                          <label className="policy-ack">
                            <input
                              type="checkbox"
                              checked={action.acknowledged}
                              disabled={action.busy === 'apply'}
                              onChange={(event) => action.acknowledge(event.target.checked)}
                            />
                            <span>
                              I understand this cannot be undone and may interrupt this task.
                            </span>
                          </label>
                        ) : (
                          <p className="control-meta" role="status">
                            {action.preview.reason === 'already-revoked'
                              ? 'This permission is already revoked.'
                              : action.preview.reason === 'task-ended'
                                ? 'This task has an ended marker. Nothing to revoke.'
                                : 'This permission has expired. No revocation is needed.'}
                          </p>
                        )}
                        <details className="setup-next">
                          <summary>Revocation preview</summary>
                          <p className="control-meta">Expires {time(action.preview.expiresAt)}</p>
                          <code className="inventory-digest">{action.preview.bindingSha256}</code>
                        </details>
                      </>
                    )}
                  </>
                )}
                {action.error && (
                  <p className="control-error" role="alert">
                    {action.error}
                  </p>
                )}
                {action.needsRecheck && (
                  <p className="control-error">
                    Completion is unknown. Recheck current permissions before another action.
                  </p>
                )}
                <div className="dialog-footer">
                  {(action.needsRecheck || action.error) && (
                    <button
                      className="button"
                      disabled={Boolean(action.busy)}
                      onClick={action.refresh}
                    >
                      <RefreshCw size={16} />
                      Recheck permissions
                    </button>
                  )}
                  {action.receipt ? (
                    <Dialog.Close className="button">Done</Dialog.Close>
                  ) : action.preview?.canApply ? (
                    <button
                      className="button primary"
                      disabled={
                        Boolean(action.busy) ||
                        action.needsRecheck ||
                        taskLockApplyInput(action.preview, action.acknowledged) === null
                      }
                      onClick={() => void action.apply()}
                    >
                      {action.busy === 'apply' ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Ban size={16} />
                      )}
                      Revoke permission
                    </button>
                  ) : (
                    <button
                      className="button"
                      disabled={
                        Boolean(action.busy) ||
                        action.needsRecheck ||
                        task.standing !== 'present' ||
                        task.eligibility === 'expired' ||
                        !state?.available
                      }
                      onClick={() => void action.prepare()}
                    >
                      {action.busy === 'preview' ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Ban size={16} />
                      )}
                      Preview revocation
                    </button>
                  )}
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
