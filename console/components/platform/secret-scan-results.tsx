'use client';
import { AgentGlyph, Badge, EmptyState, ExportButton, Panel } from '@/components/platform-ui';
import { AGENT_NAMES } from '@/lib/agent-status';
import type { SecretScanReport } from '@/lib/secret-scan';
const TIERS = {
  third_party: { label: 'External route recorded', tone: 'red' },
  maybe: { label: 'Destination uncertain', tone: 'orange' },
  seen: { label: 'Present in session', tone: 'orange' },
  own_service: { label: 'Provider route recorded', tone: 'muted' },
  blocked: { label: 'Stop reported in text', tone: 'muted' },
} as const;
const SOURCES = {
  'home-credential-file': 'Home credential file',
  'project-env-file': 'Project .env file',
  environment: 'Environment',
  canary: 'Planted canary',
  other: 'Other local source',
};
export function SecretScanResults({ report }: { report: SecretScanReport }) {
  return (
    <>
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label">Credentials compared</span>
          <strong className="stat-value">{report.keys.compared}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Sessions selected</span>
          <strong className="stat-value">{report.sessions.total}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Credentials on external routes</span>
          <strong className={`stat-value ${report.totals.external ? 'red' : ''}`}>
            {report.totals.external}
          </strong>
        </div>
      </div>
      <Panel
        title="Recorded findings"
        actions={<ExportButton data={report} filename="stroq-recorded-exposure.json" />}
      >
        <div className="secret-report-meta">
          <Badge tone={report.complete ? 'muted' : 'orange'}>
            {report.complete ? 'Comparison finished' : 'Coverage gaps'}
          </Badge>
          <span>{new Date(report.checkedAt).toLocaleString('en-GB')}</span>
        </div>
        <div className="secret-tier-totals">
          <span>
            External <strong>{report.totals.external}</strong>
          </span>
          <span>
            Uncertain <strong>{report.totals.uncertain}</strong>
          </span>
          <span>
            In session <strong>{report.totals.modelVisible}</strong>
          </span>
          <span>
            Provider route <strong>{report.totals.ownService}</strong>
          </span>
          <span>
            Reported stop <strong>{report.totals.reportedStopped}</strong>
          </span>
        </div>
        {!report.findings.length ? (
          <EmptyState
            title="No recorded matches"
            description="Known values were not found in the records that could be read. This does not establish that credentials stayed local."
          />
        ) : (
          <div className="secret-findings">
            {report.findings.map((finding) => (
              <details key={finding.id} className="secret-finding">
                <summary>
                  <div>
                    <strong>
                      {finding.provider}
                      {finding.canary ? ' · canary' : ''}
                    </strong>
                    <span>{SOURCES[finding.source]}</span>
                  </div>
                  <Badge tone={TIERS[finding.tier].tone}>{TIERS[finding.tier].label}</Badge>
                </summary>
                <div className="secret-finding-body">
                  <div className="secret-finding-agent">
                    {finding.agent !== 'unknown' && (
                      <AgentGlyph name={AGENT_NAMES[finding.agent]} />
                    )}
                    <strong>
                      {finding.agent === 'unknown'
                        ? 'Agent unrecorded'
                        : AGENT_NAMES[finding.agent]}
                    </strong>
                  </div>
                  <dl className="property-list">
                    <div>
                      <dt>Recorded route</dt>
                      <dd className="mono">{finding.route}</dd>
                    </div>
                    <div>
                      <dt>Occurrences / sessions</dt>
                      <dd>
                        {finding.occurrences} / {finding.sessions}
                      </dd>
                    </div>
                    <div>
                      <dt>Recorded at</dt>
                      <dd>
                        {finding.at ? new Date(finding.at).toLocaleString('en-GB') : 'Unknown'}
                      </dd>
                    </div>
                  </dl>
                  {finding.reportedStopped && (
                    <p className="control-meta">
                      A stop was reported in the transcript. This is not verified host blocking.
                    </p>
                  )}
                  {finding.laterNetworkCommands > 0 && (
                    <p className="control-meta">
                      {finding.laterNetworkCommands} later network commands recorded. Their actual
                      payload was not established.
                    </p>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
        {report.omittedFindings > 0 && (
          <p className="investigation-window-note">
            {report.omittedFindings} additional findings omitted from this bounded report.
          </p>
        )}
      </Panel>
      <details className="panel secret-scan-limits">
        <summary>
          Scope & limits{report.notChecked.length ? ` · ${report.notChecked.length} gaps` : ''}
        </summary>
        <div className="panel-body">
          <p className="control-meta">
            {report.scope === 'last'
              ? 'Most recent related workspace session'
              : 'Related workspace sessions'}{' '}
            · {report.evidence === 'recorded-transcripts' ? 'Recorded transcript evidence' : ''}.
            Each credential is counted once under its most external recorded tier.
          </p>
          {report.notChecked.length > 0 && (
            <p className="secret-gap-list">
              Not checked: {report.notChecked.map((gap) => gap.replaceAll('-', ' ')).join(', ')}.
            </p>
          )}
          <ul>
            {report.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
          <p className="control-meta">
            Names, source paths, destinations and credential values are withheld. Reports are held
            in server memory until it restarts.
          </p>
        </div>
      </details>
    </>
  );
}
