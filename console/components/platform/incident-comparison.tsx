'use client';
import Link from 'next/link';
import { ArrowRight, GitCompareArrows, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { usePlatform } from '@/components/platform-provider';
import { policyEventHref } from '@/lib/policy-navigation';
import { SaveRegressionDialog } from './policy-case-save';
import {
  ACTION_LABELS,
  type IncidentComparison,
  type PolicyEffect,
} from '@/lib/incident-comparison';
const EFFECTS: Record<PolicyEffect, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
const RELATIONS = {
  matchesRecorded: 'Both scenarios match the recorded effect',
  mixed: 'The result depends on session taint',
  changed: 'Both scenarios differ from the recorded effect',
};
export function IncidentComparisonPanel({
  report,
  busy,
  comparing,
  onCompare,
}: {
  report: IncidentComparison | null;
  busy: boolean;
  comparing: boolean;
  onCompare: () => void;
}) {
  const { localAccess, localContext } = usePlatform();
  const policyHref = report
    ? policyEventHref(report.incidentId, localContext?.workspace.id ?? null)
    : '/policies/';
  const canDraft =
    localAccess && report && report.classes.length > 0 && policyHref !== '/policies/';
  return (
    <section
      className="incident-policy-comparison"
      aria-label="Current policy comparison"
      aria-busy={comparing}
    >
      <div className="incident-comparison-heading">
        <div>
          <h3>Current policy comparison</h3>
          <p>Recorded action classes · two taint assumptions</p>
        </div>
        <button className="button" disabled={busy} onClick={onCompare}>
          {comparing ? <LoaderCircle size={16} className="spin" /> : <GitCompareArrows size={16} />}
          {report ? 'Compare again' : 'Compare policy'}
        </button>
      </div>
      {report ? (
        <>
          <div className="incident-comparison-meta">
            <span>
              Recorded effect: <strong>{EFFECTS[report.previousEffect]}</strong>
            </span>
            <span>Compared {new Date(report.comparedAt).toLocaleString('en-GB')}</span>
          </div>
          <div className="incident-class-list">
            {report.classes.length ? (
              report.classes.map((item) => (
                <Badge tone="muted" key={item}>
                  {ACTION_LABELS[item]}
                </Badge>
              ))
            ) : (
              <Badge tone="muted">No recorded action classes · policy default only</Badge>
            )}
          </div>
          <div className="incident-scenarios">
            {report.scenarios.map((scenario) => (
              <div key={scenario.taint}>
                <div>
                  <strong>
                    {scenario.taint === 'none' ? 'No session taint' : 'Suspect session'}
                  </strong>
                  <span>Policy would return</span>
                </div>
                <Badge
                  tone={
                    scenario.effect === 'deny'
                      ? 'red'
                      : scenario.effect === 'ask'
                        ? 'orange'
                        : 'muted'
                  }
                >
                  {EFFECTS[scenario.effect]}
                </Badge>
                {scenario.matchedRule ? (
                  <details>
                    <summary>Rule {scenario.matchedRule.index + 1}</summary>
                    <p>Session condition: {scenario.matchedRule.taint}</p>
                    <ul>
                      {scenario.matchedRule.classes.map((item) => (
                        <li key={item}>{ACTION_LABELS[item]}</li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <span className="control-meta">Policy default</span>
                )}
              </div>
            ))}
          </div>
          <p className="incident-comparison-relation" role="status">
            {RELATIONS[report.relation]}
          </p>
          {report.scopeRecorded && (
            <p className="control-meta">
              This record includes task scope. Its task gate is outside this comparison.
            </p>
          )}
          <details className="incident-comparison-limits">
            <summary>Snapshot & limits</summary>
            <dl className="property-list">
              <div>
                <dt>Policy source</dt>
                <dd>
                  {report.currentPolicy.source === 'built-in'
                    ? 'Built-in default'
                    : 'Local policy file'}
                </dd>
              </div>
              <div>
                <dt>Policy fingerprint</dt>
                <dd className="inventory-digest">{report.currentPolicy.semanticSha}</dd>
              </div>
              {report.currentPolicy.rawSha && (
                <div>
                  <dt>File fingerprint</dt>
                  <dd className="inventory-digest">{report.currentPolicy.rawSha}</dd>
                </div>
              )}
            </dl>
            <ul>
              {report.limitations.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="control-meta">
          The original taint state was not recorded. Compare both current-policy outcomes without
          executing the action.
        </p>
      )}
      <div className="incident-comparison-next">
        <p className="control-meta">A comparison does not verify a fix or host blocking.</p>
        {canDraft && <SaveRegressionDialog report={report} disabled={busy} />}
        {canDraft && (
          <Link className="inline-link" href={policyHref}>
            {report.scenarios.every((scenario) => scenario.effect === 'deny')
              ? 'View action controls'
              : 'Draft action controls'}
            <ArrowRight size={14} />
          </Link>
        )}
      </div>
    </section>
  );
}
