'use client';
import { Badge } from '@/components/platform-ui';
import type { HookCheckBinding, HookCheckError, HookCheckJob } from '@/lib/hook-checks';
export const HOOK_CHECK_REASONS: Record<HookCheckError, string> = {
  'engine-unavailable': 'The local Stroq runtime is unavailable.',
  'platform-unsupported': 'Offline hook checks are unavailable on this platform.',
  'configuration-unreadable': 'This hook source could not be read safely.',
  'hooks-not-configured': 'Configure the current Stroq hooks in this scope first.',
  'policy-unavailable': 'The selected Stroq policy could not be read.',
  'preview-stale': 'Configuration, policy or runtime changed. Prepare a fresh preview.',
  'preview-expired': 'Preview expired. Prepare a fresh preview.',
  'hook-check-busy': 'Another hook check is running.',
  'history-unavailable': 'Hook-check history is unavailable.',
  'deadline-exceeded': 'The test exceeded its deadline. No passing result was recorded.',
  'output-limit': 'The hook output exceeded its limit. No result was accepted.',
  'server-stopped': 'The server stopped before this test completed.',
  cancelled: 'Test cancelled. The two-probe check did not complete.',
  'invalid-report': 'The hook report could not be verified.',
  'cleanup-failed': 'Temporary test files could not be fully removed.',
  'hook-check-failed': 'The local hook test did not complete.',
};
export const hookCheckTime = (value: string) => new Date(value).toLocaleString('en-GB');

export function HookCheckBindingDetails({ binding }: { binding: HookCheckBinding }) {
  return (
    <details className="setup-next">
      <summary>Captured configuration</summary>
      <dl className="property-list">
        <div>
          <dt>Workspace context</dt>
          <dd className="inventory-digest">{binding.workspaceId}</dd>
        </div>
        <div>
          <dt>Hook source SHA-256</dt>
          <dd className="inventory-digest">{binding.sourceSha256}</dd>
        </div>
        <div>
          <dt>Policy source</dt>
          <dd>{binding.policySha256 ? 'Local policy file' : 'Bundled default'}</dd>
        </div>
        {binding.policySha256 && (
          <div>
            <dt>Policy file SHA-256</dt>
            <dd className="inventory-digest">{binding.policySha256}</dd>
          </div>
        )}
        <div>
          <dt>Policy semantic SHA-256</dt>
          <dd className="inventory-digest">{binding.policySemanticSha256}</dd>
        </div>
        <div>
          <dt>Runtime SHA-256</dt>
          <dd className="inventory-digest">{binding.runtimeSha256}</dd>
        </div>
      </dl>
    </details>
  );
}

export function HookCheckResult({ job }: { job: HookCheckJob }) {
  const result = job.result;
  if (!result) return null;
  return (
    <div className="live-result">
      <div className="live-result-heading">
        <h3>
          {result.status === 'passed'
            ? 'Hook responses passed'
            : result.status === 'attention'
              ? 'Policy outcomes need review'
              : 'Hook response mismatch'}
        </h3>
        <Badge
          tone={
            result.status === 'passed' ? 'muted' : result.status === 'failed' ? 'red' : 'orange'
          }
        >
          {result.status === 'passed'
            ? '2 probes matched'
            : result.status === 'attention'
              ? 'Review policy'
              : 'Needs attention'}
        </Badge>
      </div>
      <p className="control-meta">
        Recorded {hookCheckTime(job.finishedAt!)} · 0 provider requests
      </p>
      <div className="live-probes">
        {result.probes.map((probe) => (
          <details key={probe.id}>
            <summary>
              <span>{probe.id === 'ordinary' ? 'Ordinary action' : 'Encoded fetch'}</span>
              <Badge tone={probe.matched ? 'muted' : 'orange'}>
                {probe.matched ? 'Matches policy' : 'Mismatch'}
              </Badge>
            </summary>
            <dl>
              <div>
                <dt>Expected policy</dt>
                <dd>{probe.expectedEffect}</dd>
              </div>
              <div>
                <dt>Observed policy</dt>
                <dd>{probe.observedEffect ?? 'Not established'}</dd>
              </div>
              <div>
                <dt>Expected hook response</dt>
                <dd>{probe.expectedWire}</dd>
              </div>
              <div>
                <dt>Observed hook response</dt>
                <dd>{probe.wireEffect === 'unreadable' ? 'Unreadable' : probe.wireEffect}</dd>
              </div>
              <div>
                <dt>Matching audit event</dt>
                <dd>{probe.auditConfirmed ? 'Confirmed' : 'Not confirmed'}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{probe.durationMs} ms</dd>
              </div>
            </dl>
          </details>
        ))}
      </div>
      {result.status === 'attention' && (
        <p className="control-error" role="status">
          {!result.standard.ordinaryAllowed ? 'The policy did not allow the ordinary probe. ' : ''}
          {!result.standard.encodedDenied ? 'The policy did not deny the encoded-fetch probe.' : ''}
        </p>
      )}
      <p className="control-meta">Agent enforcement not tested.</p>
      <HookCheckBindingDetails binding={job.binding} />
    </div>
  );
}
