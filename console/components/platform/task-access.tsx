'use client';
import { Dialog } from 'radix-ui';
import { Check, KeyRound, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { taskAccessIssueInput } from '@/lib/task-access-binding';
// The text the server checked for hidden characters; the screen shows exactly this.
import { taskAccessReviewText } from '@/lib/task-access-review';
import type { useTaskAccess } from './use-task-access';
export function TaskAccessTrigger({
  action,
  disabled,
}: {
  action: ReturnType<typeof useTaskAccess>;
  disabled: boolean;
}) {
  return (
    <button
      ref={action.trigger}
      className="button"
      disabled={disabled || !action.workspaceId}
      onClick={action.openReview}
    >
      <KeyRound size={16} />
      Review one-use access
    </button>
  );
}
export function TaskAccessDialog({ action }: { action: ReturnType<typeof useTaskAccess> }) {
  const p = action.preview,
    r = action.receipt;
  return (
    <Dialog.Root
      open={action.open}
      onOpenChange={(open) => {
        if (!open) action.close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content setup-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (action.trigger.current?.isConnected) action.trigger.current.focus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title>One-use task access</Dialog.Title>
            <Dialog.Description>Explicit permission · no operation is started</Dialog.Description>
            <Dialog.Close className="dialog-close icon-button" aria-label="Close one-use access">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="setup-body">
            {r ? (
              <>
                <div className="live-result-heading">
                  <h3>Permission issued</h3>
                  <Badge tone="muted">
                    {r.state === 'consumed' ? 'Consumed by gate' : 'Unused'}
                  </Badge>
                </div>
                <p>
                  {r.state === 'consumed'
                    ? 'The gate consumed this permission. Execution is unverified.'
                    : 'Retry the operation in your agent.'}
                </p>
                <p className="control-meta">
                  Expires {new Date(r.expiresAt).toLocaleString('en-GB')} · execution unverified.
                </p>
                <details className="setup-next">
                  <summary>Issue receipt</summary>
                  <code className="inventory-digest">{r.id}</code>
                  <code className="inventory-digest">{r.extensionSha256}</code>
                </details>
              </>
            ) : p ? (
              <>
                <div className="live-result-heading">
                  <h3>
                    Task {p.task.id.slice(5, 13)} · {p.operation.tool}
                  </h3>
                  <Badge tone="muted">
                    {p.operation.kind === 'read-target' ? 'Read target once' : 'Exact call once'}
                  </Badge>
                </div>
                <p className="control-meta">
                  {p.operation.kind === 'read-target'
                    ? 'Applies to the recorded file target; read offsets are not bound.'
                    : 'Applies to the captured call, arguments and execution context.'}
                </p>
                <div
                  className="task-access-review"
                  role="region"
                  aria-label="Complete redacted refused operation"
                  tabIndex={0}
                >
                  <pre>{taskAccessReviewText(p.operation.review)}</pre>
                </div>
                <p className="control-meta">
                  Permission expires {new Date(p.grantExpiresAt).toLocaleString('en-GB')}
                  {p.operation.requiredCount > 1
                    ? ` · ${p.operation.requiredCount} permissions are required; this issues one.`
                    : ''}
                </p>
                <label className="policy-ack">
                  <input
                    type="checkbox"
                    checked={action.oneUse}
                    disabled={Boolean(action.busy)}
                    onChange={(e) => action.acknowledge('oneUse', e.target.checked)}
                  />
                  <span>I reviewed the operation and allow this one-use exception.</span>
                </label>
                <label className="policy-ack">
                  <input
                    type="checkbox"
                    checked={action.signingKey}
                    disabled={Boolean(action.busy)}
                    onChange={(e) => action.acknowledge('signingKey', e.target.checked)}
                  />
                  <span>Use my existing local Task Lock signing key to issue it.</span>
                </label>
                <details className="setup-next">
                  <summary>Scope & fingerprints</summary>
                  <p className="control-meta">
                    Preview expires {new Date(p.expiresAt).toLocaleString('en-GB')}
                  </p>
                  <code className="inventory-digest">{p.task.permitSha256}</code>
                  <code className="inventory-digest">{p.operation.fingerprint}</code>
                  {p.limitations.map((limit) => (
                    <p className="control-meta" key={limit}>
                      {limit}
                    </p>
                  ))}
                </details>
              </>
            ) : (
              <p className="control-meta">
                Prepare a fresh preview of this exact refusal before issuing permission.
              </p>
            )}
            {action.busy && (
              <p className="control-meta" role="status">
                {action.busy === 'issue'
                  ? 'Issuing one-use permission…'
                  : action.busy === 'recheck'
                    ? 'Rechecking existing permissions…'
                    : 'Preparing access preview…'}
              </p>
            )}
            {action.error && (
              <p className="control-error" role="alert">
                {action.error}
              </p>
            )}
            {action.message && (
              <p className="control-meta" role="status">
                {action.message}
              </p>
            )}
            {action.needsRecheck && (
              <p className="control-error" role="status">
                Issue completion is unknown. Recheck existing permissions.
              </p>
            )}
            <div className="dialog-footer">
              {r ? (
                <Dialog.Close className="button">Done</Dialog.Close>
              ) : action.needsRecheck ? (
                <button
                  className="button"
                  disabled={Boolean(action.busy)}
                  onClick={() => void action.recheck()}
                >
                  <RefreshCw size={16} />
                  Recheck permissions
                </button>
              ) : p ? (
                <button
                  className="button primary"
                  disabled={
                    Boolean(action.busy) ||
                    taskAccessIssueInput(p, action.oneUse, action.signingKey) === null
                  }
                  onClick={() => void action.issue()}
                >
                  {action.busy === 'issue' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                  Issue one-use permission
                </button>
              ) : (
                <button
                  className="button"
                  disabled={Boolean(action.busy)}
                  onClick={() => void action.prepare()}
                >
                  {action.busy === 'preview' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <KeyRound size={16} />
                  )}
                  Prepare access preview
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
