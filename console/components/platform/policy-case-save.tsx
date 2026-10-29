'use client';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { useRef, useState } from 'react';
import { ArrowRight, BookmarkPlus, Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { ACTION_LABELS, type IncidentComparison } from '@/lib/incident-comparison';
import { caseMatchesComparison } from '@/lib/policy-case-binding';
import { usePolicyCaseAction } from './use-policy-case-action';
import { PolicyCaseScenarios } from './policy-case-scenarios';

export function SaveRegressionDialog({
  report,
  disabled = false,
}: {
  report: IncidentComparison;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const action = usePolicyCaseAction({ open, comparison: report });
  const existing = action.state?.cases.find((item) => caseMatchesComparison(item, report));
  const saved = action.receipt?.record ?? existing;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!action.busy) setOpen(value);
      }}
    >
      <Dialog.Trigger asChild>
        <button className="button" disabled={disabled || !report.classes.length}>
          <BookmarkPlus size={16} aria-hidden="true" />
          Save regression check
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content policy-case-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              Save policy check
            </Dialog.Title>
            <Dialog.Description>
              Keep these current decisions as future expectations.
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              aria-label="Close saved check"
              disabled={action.busy}
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="incident-class-list">
            {report.classes.map((value) => (
              <Badge key={value} tone="muted">
                {ACTION_LABELS[value]}
              </Badge>
            ))}
          </div>
          <PolicyCaseScenarios
            scenarios={report.scenarios.map((item) => ({
              taint: item.taint,
              expected: item.effect,
            }))}
          />
          <p className="control-meta">Policy simulation · live blocking is not tested.</p>
          {action.loading && (
            <p className="control-meta" role="status">
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
              Reading saved checks…
            </p>
          )}
          {action.error && (
            <p className="control-error" role="alert">
              {action.error}
            </p>
          )}
          {action.state && !action.policyMatches && (
            <p className="control-error" role="alert">
              The policy changed after this comparison. Close and compare the event again.
            </p>
          )}
          {action.mutationError && (
            <p className="control-error" role="alert">
              {action.mutationError}
            </p>
          )}
          {action.message && (
            <p className="control-meta" role="status">
              {action.message}
            </p>
          )}
          {saved && action.policyMatches && !action.needsRecheck && (
            <div className="policy-case-complete" role="status">
              <Check size={18} aria-hidden="true" />
              <span>
                {action.receipt?.status === 'saved'
                  ? 'Policy check saved.'
                  : 'A matching check is already saved.'}
                {saved.source.workspaceId !== action.workspaceId && (
                  <small>Captured in another workspace.</small>
                )}
              </span>
            </div>
          )}
          {!saved &&
            !action.receipt &&
            action.state &&
            action.policyMatches &&
            !action.needsRecheck && (
              <label className="policy-ack">
                <input
                  type="checkbox"
                  checked={action.ackSharedScope}
                  disabled={action.busy}
                  onChange={(event) => action.acknowledge('shared', event.target.checked)}
                />
                <span>
                  Use this check for all future policy candidates using this Stroq data directory,
                  across workspaces.
                </span>
              </label>
            )}
          <details className="artifact-section">
            <summary>Scope & retention</summary>
            <p>
              These checks retain fixed action classes, expected decisions and source fingerprints
              locally until removed. They do not replay the original command or establish
              remediation.
            </p>
          </details>
          <div className="dialog-footer policy-case-dialog-actions">
            {(action.needsRecheck || action.error) && (
              <button
                className="button"
                disabled={action.loading || action.busy}
                onClick={() => void action.recheck()}
              >
                <RefreshCw size={16} aria-hidden="true" />
                Recheck
              </button>
            )}
            {saved || action.receipt ? (
              <Link className="button" href="/policies/checks/">
                Saved checks
                <ArrowRight size={15} />
              </Link>
            ) : (
              <button
                className="button primary"
                disabled={
                  action.loading ||
                  action.busy ||
                  !action.state ||
                  !action.policyMatches ||
                  !action.ackSharedScope ||
                  action.needsRecheck
                }
                onClick={() => void action.mutate()}
              >
                {action.busy ? (
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
                ) : (
                  <BookmarkPlus size={16} aria-hidden="true" />
                )}
                Confirm save
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
