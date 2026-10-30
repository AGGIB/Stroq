'use client';
import { Badge } from '@/components/platform-ui';
import { CAPABILITIES, type InventoryEvidence } from '@/lib/inventory';

const VERDICTS = {
  clean: 'Below threshold',
  suspect: 'Threshold reached',
  incomplete: 'Incomplete',
  'not-scanned': 'Not scanned',
};
export function InventoryEvidencePanel({ report }: { report: InventoryEvidence }) {
  const files = new Map(report.files.map((file) => [file.id, file]));
  return (
    <div className="artifact-evidence">
      <section className="artifact-verdict" aria-label="Captured inspection result" role="status">
        <div>
          <span className="control-meta">
            {report.artifact.kind === 'mcp' ? 'MCP inspection' : 'Markdown scan'}
          </span>
          <strong>
            {report.artifact.kind === 'mcp' ? 'Configuration only' : VERDICTS[report.scan.status]}
          </strong>
        </div>
        {report.artifact.kind === 'skill' && (
          <div>
            <span className="control-meta">Matched signals</span>
            <strong>{report.scan.findings}</strong>
          </div>
        )}
        {report.scan.score !== null && (
          <p className="control-meta">
            Score {report.scan.score.toFixed(2)} · threshold {report.engine.threshold.toFixed(2)}
          </p>
        )}
      </section>
      <p className="control-meta">
        Captured {new Date(report.capture.completedAt).toLocaleString('en-GB')}
      </p>
      {report.mcp ? (
        <>
          <dl className="property-list">
            <div>
              <dt>Transport</dt>
              <dd>{report.mcp.transport}</dd>
            </div>
            <div>
              <dt>Stroq wrapper</dt>
              <dd>{report.mcp.wrapper === 'configured' ? 'Configured' : 'Not confirmed'}</dd>
            </div>
            <div>
              <dt>Strict flag</dt>
              <dd>{report.mcp.strict ? 'Present' : 'Not present'}</dd>
            </div>
          </dl>
          <p className="control-meta">
            Configuration signals only. Server code, tool descriptions and runtime behavior were not
            scanned.
          </p>
        </>
      ) : (
        <section className="artifact-signals" aria-label="Matching bundled rules">
          <h3>Matched signals</h3>
          {report.matches.length ? (
            report.matches.map((match, index) => (
              <article
                className="artifact-signal"
                key={`${match.fileId}:${match.ruleId}:${match.variant}:${index}`}
              >
                <div className="artifact-signal-heading">
                  <strong>{match.title}</strong>
                  <Badge
                    tone={
                      match.severity === 'critical' || match.severity === 'high'
                        ? 'red'
                        : match.severity === 'medium'
                          ? 'orange'
                          : 'muted'
                    }
                  >
                    {match.severity}
                  </Badge>
                </div>
                <p>{files.get(match.fileId)?.label}</p>
                <span className="control-meta">
                  {match.ruleId} · {match.category} · {match.variant}
                </span>
              </article>
            ))
          ) : (
            <p className="control-meta">
              {report.scan.status === 'incomplete'
                ? 'No matching details returned. Inspection is incomplete.'
                : 'No matching rules in the scanned Markdown.'}
            </p>
          )}
          {report.coverage.omittedMatchDetails > 0 && (
            <p className="control-meta">
              {report.coverage.omittedMatchDetails} matching details omitted from this bounded
              report.
            </p>
          )}
        </section>
      )}
      <details className="artifact-section">
        <summary>
          Captured files <span>{report.coverage.capturedFiles}</span>
        </summary>
        {report.files.map((file) => (
          <div className="artifact-file" key={file.id}>
            <div>
              <strong>{file.label}</strong>
              <span className="control-meta">
                {file.bytes.toLocaleString()} bytes ·{' '}
                {file.scan.status === 'clean'
                  ? 'Below threshold'
                  : file.scan.status === 'suspect'
                    ? 'Threshold reached'
                    : file.scan.status.replaceAll('-', ' ')}
              </span>
            </div>
            {file.labelHidden && <p className="control-meta">File label hidden.</p>}
            <code className="inventory-digest">{file.sha256}</code>
          </div>
        ))}
        {report.coverage.omittedFileDetails > 0 && (
          <p className="control-meta">{report.coverage.omittedFileDetails} file details omitted.</p>
        )}
      </details>
      {report.artifact.kind === 'skill' && (
        <details className="artifact-section">
          <summary>
            Static capabilities <span>{report.capabilities.length}</span>
          </summary>
          <p className="control-meta">
            Source and declaration signals across the captured tree; runtime behavior is unverified.
          </p>
          {report.capabilities.length ? (
            report.capabilities.map((cap) => (
              <div key={cap.kind} className="protection-check">
                <span>{CAPABILITIES[cap.kind]}</span>
                <Badge tone="muted">{cap.count}</Badge>
              </div>
            ))
          ) : (
            <p className="control-meta">No capability signals found in the inspected scope.</p>
          )}
        </details>
      )}
      <details className="artifact-section">
        <summary>
          Scope & limits <span>{report.coverage.gaps.length}</span>
        </summary>
        {report.artifact.kind === 'skill' && (
          <p className="control-meta">
            {report.coverage.scannedMarkdownFiles} / {report.coverage.markdownFiles} Markdown files
            scanned. Static scope limits are listed separately from the content scan result.
          </p>
        )}
        {report.coverage.gaps.length > 0 && (
          <ul>
            {report.coverage.gaps.map((gap) => (
              <li key={gap}>{gap.replaceAll('-', ' ')}</li>
            ))}
          </ul>
        )}
        {report.limitations.map((limit) => (
          <p className="control-meta" key={limit}>
            {limit}
          </p>
        ))}
      </details>
      <details className="artifact-section">
        <summary>Engine provenance</summary>
        <dl className="property-list">
          <div>
            <dt>Stroq engine</dt>
            <dd>{report.engine.version}</dd>
          </div>
          <div>
            <dt>Bundled rules</dt>
            <dd>{report.engine.ruleCount}</dd>
          </div>
          <div>
            <dt>Capability inspector</dt>
            <dd>{report.engine.inspectorRulesId}</dd>
          </div>
        </dl>
        <code className="inventory-digest">{report.engine.rulesSha256}</code>
        {report.mcp && (
          <p className="control-meta">
            Engine metadata is recorded for provenance; content rules were not applied to this MCP
            entry.
          </p>
        )}
      </details>
    </div>
  );
}
