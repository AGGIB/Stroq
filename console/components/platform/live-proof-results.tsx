'use client';
import { Badge } from '@/components/platform-ui';
import type { LiveReport } from '@/lib/live-proof';
const EVIDENCE = {
  E1: 'Agent issued the test command',
  E2: 'Hook journal matched the expected decision',
  E3: 'Test file matched the expected result',
  E4: 'Host reported Stroq’s deny response',
};
export function LiveProofResult({ report }: { report: LiveReport }) {
  const verified = report.state === 'verified' && report.mode === 'live';
  return (
    <div className="live-result">
      <div className="live-result-heading">
        <h3>
          {verified
            ? 'Isolated blocking check passed'
            : report.state === 'failed'
              ? 'Blocking check failed'
              : report.state === 'inconclusive'
                ? 'Check inconclusive'
                : 'Check not completed'}
        </h3>
        <Badge tone={verified ? 'green' : report.state === 'failed' ? 'red' : 'orange'}>
          {report.state}
        </Badge>
      </div>
      <p className="control-meta">
        Temporary project, {report.requestsMade} requests, host{' '}
        {report.hostVersion ?? 'version unknown'}
      </p>
      <div className="live-probes">
        {report.probes.map((probe) => (
          <details key={probe.id}>
            <summary>
              <span>{probe.id}</span>
              <Badge
                tone={probe.mark === 'passed' ? 'green' : probe.mark === 'failed' ? 'red' : 'muted'}
              >
                {probe.mark.replaceAll('-', ' ')}
              </Badge>
            </summary>
            <dl>
              {Object.entries(probe.evidence).map(([key, value]) => (
                <div key={key}>
                  <dt>{EVIDENCE[key as keyof typeof EVIDENCE]}</dt>
                  <dd>
                    {value === null ? 'Not established' : value ? 'Confirmed' : 'Not confirmed'}
                  </dd>
                </div>
              ))}
            </dl>
            {probe.reason && <p className="control-meta">{probe.reason.replaceAll('-', ' ')}</p>}
          </details>
        ))}
      </div>
      {report.caveats.length > 0 && (
        <div className="live-caveats">
          {report.caveats.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      )}
      {report.advice.length > 0 && (
        <details className="setup-next">
          <summary>Next steps</summary>
          <ul>
            {report.advice.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="control-meta">
        This result measures the isolated test environment. Review installed workspace configuration
        separately.
      </p>
    </div>
  );
}
