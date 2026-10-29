'use client';
import Link from 'next/link';
import { ArrowRight, Check, ClipboardCheck, LoaderCircle } from 'lucide-react';
import { Badge, Panel } from '@/components/platform-ui';
import type { PolicyPreview } from '@/lib/policy-control';
import { ACTION_LABELS } from '@/lib/incident-comparison';
import { PolicyCaseScenarios } from './policy-case-scenarios';

interface PolicyPreviewProps {
  preview: PolicyPreview | null;
  busy: 'load' | 'preview' | 'apply' | null;
  ack: boolean;
  ackSharedScope: boolean;
  onAcknowledge: (value: boolean) => void;
  onAcknowledgeSharedScope: (value: boolean) => void;
  onApply: () => Promise<void>;
}

export function PolicyPreviewPanel({
  preview,
  busy,
  ack,
  ackSharedScope,
  onAcknowledge,
  onAcknowledgeSharedScope,
  onApply,
}: PolicyPreviewProps) {
  return (
    <Panel title="Change preview" className="policy-preview">
      <div className="panel-body" aria-live="polite">
        {!preview ? (
          <div className="control-empty">
            {busy === 'preview' ? (
              <LoaderCircle size={30} className="spin" aria-hidden="true" />
            ) : (
              <ClipboardCheck size={30} aria-hidden="true" />
            )}
            <h3>{busy === 'preview' ? 'Testing the candidate' : 'Test before applying'}</h3>
            <p>
              {busy === 'preview'
                ? 'Replaying attack and ordinary-work scenarios against both versions.'
                : 'Compare selected changes with the current policy before saving.'}
            </p>
          </div>
        ) : (
          <>
            <div className="policy-diff">
              {preview.changes.map((change, i) => (
                <div key={i}>
                  <strong>
                    {change.field === 'default'
                      ? 'Unmatched actions'
                      : change.field === 'threshold'
                        ? 'Threshold'
                        : change.field === 'class-deny'
                          ? ACTION_LABELS[change.actionClass]
                          : `Rule ${(change.index ?? 0) + 1}`}
                  </strong>
                  <span>
                    {change.from === 'current-policy' ? 'Current policy' : change.from}
                    <ArrowRight size={14} aria-hidden="true" />
                    <b>{change.to}</b>
                  </span>
                </div>
              ))}
            </div>
            {preview.actionControl && (
              <details className="policy-action-impact">
                <summary>Action control · any session context</summary>
                <dl className="property-list">
                  <div>
                    <dt>Replaced rules</dt>
                    <dd>{preview.actionControl.removedRules}</dd>
                  </div>
                  <div>
                    <dt>Narrowed rules</dt>
                    <dd>{preview.actionControl.narrowedRules}</dd>
                  </div>
                </dl>
                <p className="control-meta">Other action classes retain their current rules.</p>
              </details>
            )}
            <div className="control-meta">
              <Badge tone="muted">Simulation</Badge>
              <span>Compared with the current policy</span>
            </div>
            <p className="control-meta">Scenario replay; live host enforcement is not tested.</p>
            <dl className="property-list">
              <div>
                <dt>Attack scenarios</dt>
                <dd>{preview.simulation.replayed.attack}</dd>
              </div>
              <div>
                <dt>Ordinary-work scenarios</dt>
                <dd>{preview.simulation.replayed.ordinary}</dd>
              </div>
              <div>
                <dt>Attacks allowed</dt>
                <dd>
                  <Badge tone={preview.simulation.attacksPassing ? 'red' : 'muted'}>
                    {preview.simulation.attacksPassing}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt>New interruptions</dt>
                <dd>
                  <Badge tone={preview.simulation.newInterruptions ? 'orange' : 'muted'}>
                    {preview.simulation.newInterruptions}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt>Unjudged scenarios</dt>
                <dd>{preview.simulation.notJudged}</dd>
              </div>
              <div>
                <dt>Unmet expectations</dt>
                <dd>{preview.simulation.violations}</dd>
              </div>
            </dl>
            <section className="policy-regressions" aria-label="Saved check results">
              <div>
                <h3>Saved checks · candidate</h3>
                <Badge tone={preview.regressions.failed ? 'orange' : 'muted'}>
                  {preview.regressions.total
                    ? `${preview.regressions.passed} / ${preview.regressions.total} match`
                    : 'None saved'}
                </Badge>
              </div>
              <p className="control-meta">
                Two session contexts per check · separate from bundled scenarios.
              </p>
              {preview.regressions.failed > 0 && (
                <>
                  <p className="control-error">
                    {preview.regressions.failed} saved{' '}
                    {preview.regressions.failed === 1 ? 'check does' : 'checks do'} not match. Apply
                    is unavailable.
                  </p>
                  <details className="policy-case-candidate-results">
                    <summary>Candidate mismatches</summary>
                    {preview.regressions.results
                      .filter((item) => !item.passed)
                      .map((item) => (
                        <div key={item.caseId}>
                          <strong>Check {item.caseId.slice(5, 17)}</strong>
                          <PolicyCaseScenarios scenarios={item.scenarios} />
                        </div>
                      ))}
                  </details>
                </>
              )}
              <Link className="inline-link" href="/policies/checks/">
                Open saved checks
                <ArrowRight size={14} />
              </Link>
            </section>
            {preview.blockers.length > 0 && (
              <div className="control-error">
                Apply unavailable: {preview.blockers.map((b) => b.replaceAll('-', ' ')).join(', ')}.
              </div>
            )}
            {preview.requiresInterruptionAcknowledgement && (
              <details className="policy-interruptions" open>
                <summary>{preview.simulation.newInterruptions} ordinary-work interruptions</summary>
                <div>
                  {preview.interruptions.map((item, i) => (
                    <div className="policy-interruption" key={`${item.label}-${item.step}-${i}`}>
                      <span>
                        {item.label}
                        <small>Step {item.step}</small>
                      </span>
                      <span>
                        {item.from}
                        <ArrowRight size={12} aria-hidden="true" />
                        <strong>{item.to}</strong>
                      </span>
                    </div>
                  ))}
                </div>
                {preview.interruptionsTruncated && (
                  <p className="control-meta">
                    Showing the first {preview.interruptions.length} changes.
                  </p>
                )}
              </details>
            )}
            {preview.requiresInterruptionAcknowledgement && (
              <label className="policy-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => onAcknowledge(e.target.checked)}
                  disabled={Boolean(busy)}
                />
                <span>
                  I reviewed the {preview.simulation.newInterruptions} new interruptions and accept
                  the change to ordinary work.
                </span>
              </label>
            )}
            {preview.actionControl && (
              <label className="policy-ack">
                <input
                  type="checkbox"
                  checked={ackSharedScope}
                  onChange={(e) => onAcknowledgeSharedScope(e.target.checked)}
                  disabled={Boolean(busy)}
                />
                <span>
                  I understand these actions will be denied in every session context for all agents
                  using this Stroq data directory.
                </span>
              </label>
            )}
            <p className="control-meta">
              Expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}. An existing policy
              is backed up before saving.
            </p>
            <div className="policy-actions">
              <button
                className="button primary"
                disabled={
                  Boolean(busy) ||
                  preview.blockers.length > 0 ||
                  !preview.check.ok ||
                  !preview.simulation.ok ||
                  preview.regressions.failed > 0 ||
                  (preview.requiresInterruptionAcknowledgement && !ack) ||
                  (preview.actionControl !== null && !ackSharedScope)
                }
                onClick={() => void onApply()}
              >
                {busy === 'apply' ? (
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
                ) : (
                  <Check size={16} aria-hidden="true" />
                )}
                Apply policy
              </button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
