'use client';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { SKILL_SOURCES } from '@/lib/skill-sources';
import {
  SIGNAL_REASONS,
  SIGNAL_REASON_DECISIONS,
  signalBindingKey,
  type InventorySignalProjection,
  type SignalDecision,
  type SignalReason,
} from '@/lib/inventory-signal-decision';
import type { useInventorySignals } from './use-inventory-signals';

const LABELS: Record<SignalDecision, string> = {
  'accepted-risk': 'Risk accepted',
  'false-positive': 'Marked false positive',
  reopened: 'Reopened',
};
export function InventorySignalBadge({ decision }: { decision?: InventorySignalProjection }) {
  if (!decision || decision.standing === 'unresolved' || decision.standing === 'unavailable')
    return null;
  return (
    <span className="inventory-signal-badge">
      <Badge tone={decision.standing === 'stale' ? 'orange' : 'muted'}>
        {decision.standing === 'stale'
          ? 'Needs a new decision'
          : decision.record
            ? LABELS[decision.record.decision]
            : 'Decision unavailable'}
      </Badge>
    </span>
  );
}
export function InventorySignalControls({
  action,
  disabled = false,
}: {
  action: ReturnType<typeof useInventorySignals>;
  disabled?: boolean;
}) {
  const { state, preview, busy, needsRecheck } = action;
  const identity = state
    ? JSON.stringify([
        state.workspaceId,
        state.artifact.id,
        state.artifact.agent,
        state.artifact.skillSource,
        state.artifact.scope,
        state.artifact.sha256,
        state.binding && signalBindingKey(state.binding),
        state.decision?.id,
      ])
    : null;
  const [stored, setStored] = useState<{
    identity: string | null;
    decision: '' | 'accepted-risk' | 'false-positive';
    reason: '' | SignalReason;
  }>({ identity, decision: '', reason: '' });
  const draft =
    stored.identity === identity
      ? stored
      : { identity, decision: '' as const, reason: '' as const };
  const trigger = useRef<HTMLButtonElement | null>(null),
    acknowledge = useRef<HTMLInputElement | null>(null);
  const previousPreview = useRef(false);
  useEffect(() => {
    if (preview) acknowledge.current?.focus();
    else if (previousPreview.current) trigger.current?.focus();
    previousPreview.current = preview !== null;
  }, [preview]);
  if (state?.reason === 'not-suspect' && !state.decision && !action.error) return null;
  const locked = disabled || Boolean(busy) || needsRecheck;
  const decision = state?.decision;
  const canReopen = state?.standing === 'applies' && state.binding && state.reason !== 'incomplete';
  const source = preview && SKILL_SOURCES[preview.state.artifact.skillSource];
  return (
    <section className="inventory-signal-controls" aria-label="Static signal decision">
      <div className="inventory-signal-heading">
        <h3>Signal decision</h3>
        <button
          className="button subtle small"
          disabled={disabled || Boolean(busy)}
          onClick={action.refresh}
        >
          <RefreshCw size={15} aria-hidden="true" /> Recheck decision
        </button>
      </div>
      {needsRecheck && (
        <p className="control-error" role="status">
          Recheck required. Decision completion is unknown.
        </p>
      )}
      {action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {!state ? (
        <p className="control-meta" role="status">
          {busy === 'load' ? (
            <>
              <LoaderCircle size={16} className="spin" aria-hidden="true" /> Reading signal
              decisions…
            </>
          ) : (
            'No verified signal decision state is available.'
          )}
        </p>
      ) : preview ? (
        <section className="inventory-signal-preview" aria-label="Signal decision preview">
          <h4>{preview.decision === 'reopened' ? 'Reopen signals' : LABELS[preview.decision]}</h4>
          <dl className="property-list">
            <div>
              <dt>Source</dt>
              <dd>
                <code>
                  {preview.state.artifact.scope === 'project'
                    ? source?.projectLabel
                    : source?.userLabel}
                </code>{' '}
                · {preview.state.artifact.scope === 'project' ? 'Workspace' : 'User'}
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>
                <code>{preview.state.artifact.sha256.slice(0, 12)}</code>
              </dd>
            </div>
            <div>
              <dt>Matched signals</dt>
              <dd>{preview.state.findings}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{SIGNAL_REASONS[preview.reason]}</dd>
            </div>
          </dl>
          <p className="control-meta">
            {preview.decision === 'reopened'
              ? 'These signals return to Protection.'
              : 'Only this captured static signal set leaves Protection.'}{' '}
            New, changed and incomplete items remain separate.
          </p>
          <label className="consent-line">
            <input
              ref={acknowledge}
              type="checkbox"
              checked={action.acknowledged}
              disabled={locked}
              onChange={(event) => action.acknowledge(event.target.checked)}
            />
            <span>
              I understand this records an assessment without changing files, permissions or the
              review baseline.
            </span>
          </label>
          <details className="artifact-section">
            <summary>Fingerprints & retention</summary>
            <p className="control-meta">Artifact version</p>
            <code className="inventory-digest">{preview.state.artifact.sha256}</code>
            <p className="control-meta">Source metadata</p>
            <code className="inventory-digest">{preview.state.binding?.sourceSha256}</code>
            <p className="control-meta">Decision analysis</p>
            <code className="inventory-digest">{preview.state.binding?.analysisSha256}</code>
            {preview.limitations.map((limit) => (
              <p className="control-meta" key={limit}>
                {limit}
              </p>
            ))}
          </details>
          <p className="control-meta">
            Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
          </p>
          <div className="inventory-signal-actions">
            <button
              className="button primary"
              disabled={locked || !action.acknowledged}
              onClick={() => void action.apply()}
            >
              {preview.decision === 'reopened' ? 'Reopen signals' : 'Save decision'}
            </button>
            <button className="button" disabled={Boolean(busy)} onClick={action.invalidate}>
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <>
          {decision && (
            <div className="inventory-signal-standing">
              <Badge tone={state.standing === 'stale' ? 'orange' : 'muted'}>
                {state.standing === 'stale' ? 'Needs a new decision' : LABELS[decision.decision]}
              </Badge>
              <p className="control-meta">
                {SIGNAL_REASONS[decision.reason]} ·{' '}
                {new Date(decision.recordedAt).toLocaleString('en-GB')}
                {state.standing === 'applies' ? ' · this revision and analysis' : ''}
              </p>
            </div>
          )}
          {state.standing === 'stale' && (
            <p className="control-meta">
              The previous assessment is historical. Current signals still need review.
            </p>
          )}
          {state.reason === 'incomplete' ? (
            <p className="control-meta">
              Complete inspection required. Incomplete evidence cannot be dismissed.
            </p>
          ) : state.reason === 'store-unavailable' ? (
            <p className="control-meta">
              Saved decisions are unavailable. Signals remain in Protection.
            </p>
          ) : canReopen ? (
            <button
              ref={trigger}
              className="button"
              disabled={locked}
              onClick={() => void action.prepare('reopened', 'reconsidered')}
            >
              <RotateCcw size={15} aria-hidden="true" /> Reopen signals
            </button>
          ) : state.eligible ? (
            <>
              <div className="inventory-signal-fields">
                <label>
                  <span>Decision</span>
                  <select
                    className="select-field"
                    aria-label="Signal decision"
                    value={draft.decision}
                    disabled={locked}
                    onChange={(event) => {
                      action.invalidate();
                      setStored({
                        identity,
                        decision: event.target.value as 'accepted-risk' | 'false-positive',
                        reason: '',
                      });
                    }}
                  >
                    <option value="" disabled>
                      Choose decision
                    </option>
                    <option value="accepted-risk">Accept risk</option>
                    <option value="false-positive">False positive</option>
                  </select>
                </label>
                <label>
                  <span>Reason</span>
                  <select
                    className="select-field"
                    aria-label="Decision reason"
                    value={draft.reason}
                    disabled={locked || !draft.decision}
                    onChange={(event) => {
                      action.invalidate();
                      setStored({ ...draft, reason: event.target.value as SignalReason });
                    }}
                  >
                    <option value="" disabled>
                      Choose reason
                    </option>
                    {(Object.keys(SIGNAL_REASONS) as SignalReason[])
                      .filter((reason) => SIGNAL_REASON_DECISIONS[reason] === draft.decision)
                      .map((reason) => (
                        <option key={reason} value={reason}>
                          {SIGNAL_REASONS[reason]}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <button
                ref={trigger}
                className="button"
                disabled={locked || !draft.decision || !draft.reason}
                onClick={() => {
                  if (draft.decision && draft.reason)
                    void action.prepare(draft.decision, draft.reason);
                }}
              >
                {busy === 'preview' ? 'Preparing…' : 'Preview decision'}
              </button>
            </>
          ) : (
            <p className="control-meta">No threshold signals require a decision in this capture.</p>
          )}
          {busy === 'apply' && (
            <p className="control-meta" role="status">
              <LoaderCircle size={16} className="spin" aria-hidden="true" /> Recording decision…
            </p>
          )}
          {decision && (
            <details className="artifact-section">
              <summary>Decision history</summary>
              {state.history.records.map((record) => (
                <p className="control-meta" key={record.id}>
                  {LABELS[record.decision]} · {SIGNAL_REASONS[record.reason]} ·{' '}
                  {new Date(record.recordedAt).toLocaleString('en-GB')}
                </p>
              ))}
              {state.history.omitted > 0 && (
                <p className="control-meta">
                  {state.history.omitted} earlier records are outside this view.
                </p>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}
