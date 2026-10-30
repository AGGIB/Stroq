'use client';
import Link from 'next/link';
import { McpGovernanceDiffPanel } from './mcp-governance-diff';
import { ArrowRight, ClipboardCheck, LoaderCircle, RotateCcw } from 'lucide-react';
import { Badge, Panel } from '@/components/platform-ui';
import { ACTION_LABELS } from '@/lib/incident-comparison';
import type { PolicyRestoreAcknowledgements } from '@/lib/policy-restore-binding';
import type { usePolicyHistory } from './use-policy-history';
const EFFECTS = { allow: 'Allow', ask: 'Ask', deny: 'Deny' } as const;
const BLOCKERS: Record<string, string> = {
  'policy-findings': 'Policy validation needs attention',
  'attacks-allowed': 'Attack scenarios were allowed',
  'unmet-expectations': 'Scenario expectations were not met',
  'unjudged-scenarios': 'Some scenarios could not be judged',
  'saved-case-failures': 'Saved policy checks do not match',
};
export function PolicyRestorePreviewPanel({
  action,
}: {
  action: ReturnType<typeof usePolicyHistory>;
}) {
  const preview = action.preview;
  const acknowledge = (name: keyof PolicyRestoreAcknowledgements, value: boolean) =>
    action.acknowledge(name, value);
  return (
    <Panel title="Tested restore">
      <div className="panel-body" aria-live="polite">
        {!preview ? (
          <div className="control-empty">
            {action.busy === 'preview' ? (
              <LoaderCircle size={28} className="spin" aria-hidden="true" />
            ) : (
              <ClipboardCheck size={28} aria-hidden="true" />
            )}
            <h3>
              {action.busy === 'preview'
                ? 'Testing the retained version'
                : 'Preview before restoring'}
            </h3>
            <p>
              {action.busy === 'preview'
                ? 'Comparing current and candidate policies against the same checks.'
                : 'Select a recorded change, then test its recovery target.'}
            </p>
          </div>
        ) : (
          <>
            <div className="policy-history-preview-heading">
              <strong>
                {preview.target === 'current-default'
                  ? 'Current bundled default'
                  : 'Retained policy file'}
              </strong>
              <Badge>Simulation</Badge>
            </div>
            {preview.target === 'current-default' && (
              <p className="control-meta">
                Uses the default in the current runtime, not a retained historical default.
              </p>
            )}
            <div className="policy-history-test-grid">
              <div>
                <span>Attacks allowed</span>
                <strong className={preview.simulation.attacksPassing ? 'red' : undefined}>
                  {preview.simulation.attacksPassing}
                </strong>
              </div>
              <div>
                <span>New interruptions</span>
                <strong>{preview.simulation.newInterruptions}</strong>
              </div>
              <div>
                <span>Interruptions relieved</span>
                <strong>{preview.simulation.relieved}</strong>
              </div>
              <div>
                <span>Saved checks passed</span>
                <strong>
                  {preview.regressions.passed}/{preview.regressions.total}
                </strong>
              </div>
            </div>
            <p className="control-meta">
              {preview.simulation.replayed.attack} attack scenarios,{' '}
              {preview.simulation.replayed.ordinary} ordinary-work scenarios,{' '}
              {preview.regressions.total} saved checks, two contexts each
            </p>
            <dl className="property-list" aria-label="Current to candidate settings">
              <div>
                <dt>Default</dt>
                <dd>
                  {EFFECTS[preview.settings.current.defaultEffect]} →{' '}
                  {EFFECTS[preview.settings.candidate.defaultEffect]}
                </dd>
              </div>
              <div>
                <dt>Detection threshold</dt>
                <dd>
                  {preview.settings.current.threshold} → {preview.settings.candidate.threshold}
                </dd>
              </div>
              <div>
                <dt>Rule count</dt>
                <dd>
                  {preview.settings.current.rules} → {preview.settings.candidate.rules}
                </dd>
              </div>
            </dl>
            <McpGovernanceDiffPanel value={preview.mcpGovernance} restore />
            <details className="live-details">
              <summary>Decision changes · {preview.decisions.length}</summary>
              <p className="control-meta">
                Class-only comparison. Tool arguments and host enforcement are not replayed.
              </p>
              {preview.decisions.length ? (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>Session</th>
                        <th>Current → Candidate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.decisions.map((item) => (
                        <tr key={`${item.actionClass}:${item.taint}`}>
                          <td>{ACTION_LABELS[item.actionClass]}</td>
                          <td>{item.taint === 'none' ? 'No taint' : 'Suspect'}</td>
                          <td>
                            {EFFECTS[item.from]} → {EFFECTS[item.to]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="control-meta">
                  No changes in the fixed class and taint comparison. Other policy conditions can
                  still differ.
                </p>
              )}
            </details>
            {preview.simulation.newInterruptions > 0 && (
              <details className="live-details" open>
                <summary>New ordinary-work interruptions</summary>
                {preview.interruptions.map((item, index) => (
                  <div className="policy-interruption" key={`${item.label}:${item.step}:${index}`}>
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
                {preview.interruptionsTruncated && (
                  <p className="control-meta">
                    Showing the first {preview.interruptions.length} changes.
                  </p>
                )}
              </details>
            )}
            {preview.regressions.failed > 0 && (
              <details className="live-details" open>
                <summary>{preview.regressions.failed} saved checks need review</summary>
                {preview.regressions.results
                  .filter((item) => !item.passed)
                  .map((item) => (
                    <div className="policy-history-failed-check" key={item.caseId}>
                      <strong>Check {item.caseId.slice(5, 17)}</strong>
                      {item.scenarios.map((scenario) => (
                        <p className="control-meta" key={scenario.taint}>
                          {scenario.taint === 'none' ? 'No taint' : 'Suspect'} · Expected{' '}
                          {EFFECTS[scenario.expected]} · Candidate {EFFECTS[scenario.actual]}
                        </p>
                      ))}
                    </div>
                  ))}
                <Link className="inline-link" href="/policies/checks/">
                  Review saved checks <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </details>
            )}
            {preview.blockers.length > 0 && (
              <div className="control-error" role="alert">
                Restore unavailable: {preview.blockers.map((value) => BLOCKERS[value]).join(' · ')}.
              </div>
            )}
            <details className="live-details">
              <summary>Validation and capture</summary>
              <p className="control-meta">
                {preview.check.ok ? 'Validation passed' : 'Validation needs attention'} ·{' '}
                {preview.simulation.notJudged} unjudged · {preview.simulation.violations} unmet
                expectations
              </p>
              {preview.check.findings.map((finding, index) => (
                <p className="control-meta" key={`${finding.kind}:${index}`}>
                  {finding.kind.replaceAll('-', ' ')} · {finding.severity} · {finding.count}
                </p>
              ))}
              <dl className="property-list">
                <div>
                  <dt>Current raw SHA</dt>
                  <dd className="inventory-digest">
                    {preview.expectedRawSha ?? 'Policy file absent'}
                  </dd>
                </div>
                <div>
                  <dt>Candidate raw SHA</dt>
                  <dd className="inventory-digest">
                    {preview.candidateRawSha ?? 'Use current bundled default'}
                  </dd>
                </div>
                <div>
                  <dt>Current policy SHA</dt>
                  <dd className="inventory-digest">{preview.currentPolicyFingerprint}</dd>
                </div>
                <div>
                  <dt>Candidate policy SHA</dt>
                  <dd className="inventory-digest">{preview.candidateFingerprint}</dd>
                </div>
                <div>
                  <dt>Recovery record SHA</dt>
                  <dd className="inventory-digest">{preview.recordSha256}</dd>
                </div>
                <div>
                  <dt>Runtime SHA</dt>
                  <dd className="inventory-digest">{preview.runtimeSha256}</dd>
                </div>
                <div>
                  <dt>Saved-check revision</dt>
                  <dd className="inventory-digest">
                    {preview.regressions.revision ?? 'No saved checks'}
                  </dd>
                </div>
              </dl>
            </details>
            {preview.blockers.length === 0 && (
              <div className="policy-restore-consent">
                <label className="policy-ack">
                  <input
                    type="checkbox"
                    checked={action.ack.sharedScope}
                    disabled={!!action.busy}
                    onChange={(event) => acknowledge('sharedScope', event.target.checked)}
                  />
                  <span>Apply to all agents using this Stroq data directory.</span>
                </label>
                <label className="policy-ack">
                  <input
                    type="checkbox"
                    checked={action.ack.reducedProtection}
                    disabled={!!action.busy}
                    onChange={(event) => acknowledge('reducedProtection', event.target.checked)}
                  />
                  <span>
                    I accept that restoring this policy may reduce protection beyond the tested
                    scenarios.
                  </span>
                </label>
                <label className="policy-ack">
                  <input
                    type="checkbox"
                    checked={action.ack.backup}
                    disabled={!!action.busy}
                    onChange={(event) => acknowledge('backup', event.target.checked)}
                  />
                  <span>
                    Recovery records are private and unencrypted. An existing policy is copied and
                    may contain sensitive settings.
                  </span>
                </label>
                {preview.simulation.newInterruptions > 0 && (
                  <label className="policy-ack">
                    <input
                      type="checkbox"
                      checked={action.ack.interruptions}
                      disabled={!!action.busy}
                      onChange={(event) => acknowledge('interruptions', event.target.checked)}
                    />
                    <span>
                      I accept the {preview.simulation.newInterruptions} new ordinary-work
                      interruptions.
                    </span>
                  </label>
                )}
              </div>
            )}
            <p className="control-meta">
              Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
            </p>
            <div className="policy-actions">
              <button
                className="button primary"
                disabled={!action.canApply || !!action.busy}
                onClick={() => void action.apply()}
              >
                {action.busy === 'apply' ? (
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
                ) : (
                  <RotateCcw size={16} aria-hidden="true" />
                )}
                {preview.target === 'current-default'
                  ? 'Use current bundled default'
                  : 'Restore saved policy'}
              </button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
