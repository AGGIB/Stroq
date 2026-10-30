'use client';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import type { TaskLockRow } from '@/lib/task-locks';
import { useTaskAccessLedger } from './use-task-access-ledger';
const LABELS = { unused: 'Unused', consumed: 'Consumed', expired: 'Expired', invalid: 'Invalid' };
export function TaskAccessLedger({ task }: { task: TaskLockRow }) {
  const action = useTaskAccessLedger(task),
    state = action.state;
  return (
    <details className="setup-next">
      <summary>Existing one-use permissions</summary>
      <button
        className="button subtle small"
        disabled={!action.available || action.loading}
        onClick={() => void action.load()}
      >
        {action.loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
        Recheck existing permissions
      </button>
      {action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {state && (
        <>
          <p className="control-meta">
            Captured {new Date(state.checkedAt).toLocaleString('en-GB')} · consumed means gate use,
            not tool execution.
          </p>
          {!state.coverage.complete && (
            <p className="control-error" role="status">
              Extension coverage is incomplete. {state.coverage.unverified} entries could not be
              verified.
            </p>
          )}
          {state.permissions.length ? (
            <div
              className="table-wrap"
              role="region"
              aria-label="Existing one-use permission records"
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Fingerprint</th>
                    <th>State</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {state.permissions.map((row) => (
                    <tr key={row.fingerprint}>
                      <td>
                        <code title={row.fingerprint}>{row.fingerprint.slice(0, 12)}</code>
                      </td>
                      <td>
                        <Badge tone={row.state === 'invalid' ? 'orange' : 'muted'}>
                          {LABELS[row.state]}
                        </Badge>
                      </td>
                      <td>
                        {row.expiresAt
                          ? new Date(row.expiresAt).toLocaleString('en-GB')
                          : 'Unverified'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="control-meta">
              {state.coverage.complete
                ? 'No extension files were found.'
                : 'No verified extension rows in this capture.'}
            </p>
          )}
        </>
      )}
    </details>
  );
}
