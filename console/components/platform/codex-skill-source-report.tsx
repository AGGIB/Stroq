'use client';
import { Badge, ExportButton } from '@/components/platform-ui';
import type {
  CodexSkillSourceGapCode,
  CodexSkillSourceItem,
  CodexSkillSourceRow,
  CodexSkillSourcesReport,
} from '@/lib/codex-skill-sources';
import { CodexSkillDisable } from './codex-skill-controls';
import type { CodexSkillControlAction } from './use-codex-skill-controls';
const DECLARED = {
  disabled: 'User config: disabled',
  enabled: 'User config: enabled',
  'not-specified': 'User config: not specified',
  unknown: 'User config: unknown',
} as const;
const PRESENCE = {
  complete: 'Present',
  absent: 'Absent',
  partial: 'Partial',
  uninspected: 'Uninspected',
} as const;
const FAMILY = {
  agents: 'Shared',
  'codex-legacy': 'Codex legacy',
  system: 'System',
  admin: 'Admin',
  plugins: 'Plugins',
} as const;
const SETTINGS = {
  ready: 'Read',
  missing: 'Not found',
  invalid: 'Invalid',
  unavailable: 'Unavailable',
  unsupported: 'Unsupported',
} as const;
const BOUNDARY = {
  marker: 'Repository marker',
  'cwd-only': 'Current directory only',
  unverifiable: 'Boundary unverified',
  limit: 'Ancestor limit reached',
} as const;
const MARKERS = {
  default: 'Default markers',
  'user-config': 'User-configured markers',
  unverified: 'Marker policy unverified',
} as const;
const GAP: Record<CodexSkillSourceGapCode, string> = {
  'marker-unreadable': 'Repository marker could not be read',
  'marker-unsafe': 'Repository marker path was refused',
  'changed-context': 'Source context changed during inspection',
  'ancestor-limit': 'Ancestor inspection limit reached',
  'source-limit': 'Source inspection limit reached',
  'custom-profile-unsupported': 'Custom Codex data directory is unsupported',
  'config-invalid': 'User configuration is invalid',
  'config-unavailable': 'User configuration is unavailable',
  'source-path-refused': 'Source path was refused',
  'source-unreadable': 'Source could not be read',
  'item-path-refused': 'Entrypoint path was refused',
  'item-unreadable': 'Entrypoint could not be read',
  'item-limit': 'Entrypoint inspection limit reached',
  'bytes-limit': 'Inspection byte limit reached',
  deadline: 'Inspection deadline reached',
  'metadata-invalid': 'Skill metadata could not be verified by this inspection',
  'hidden-sources-skipped': 'Hidden sources were skipped',
  'compatibility-uninspected': 'Codex legacy sources were not inspected',
  'system-uninspected': 'System sources were not inspected',
  'admin-uninspected': 'Admin sources were not inspected',
  'plugins-uninspected': 'Plugin sources were not inspected',
  'session-overrides-unverified': 'Named profile and session overrides are unverified',
  'managed-config-unverified': 'Managed configuration is unverified',
};
function scopeLabel(source: CodexSkillSourceRow) {
  if (source.scope === 'cwd') return 'Current directory';
  if (source.scope === 'ancestor')
    return `Ancestor · ${source.distance} ${source.distance === 1 ? 'level' : 'levels'} up`;
  if (source.scope === 'user') return 'User';
  return FAMILY[source.family];
}
function Candidate({
  item,
  source,
  report,
  historical,
  controls,
}: {
  item: CodexSkillSourceItem;
  source: CodexSkillSourceRow;
  report: CodexSkillSourcesReport;
  historical: boolean;
  controls: CodexSkillControlAction;
}) {
  const sourceScope = `${FAMILY[source.family]} · ${scopeLabel(source)}`;
  return (
    <article
      className="codex-source-candidate"
      data-candidate-id={item.id}
      aria-label={`${item.name} · ${sourceScope}`}
    >
      <div className="codex-source-candidate-heading">
        <strong>{item.name}</strong>
        <Badge tone={item.declaredState === 'unknown' ? 'orange' : 'muted'}>
          {DECLARED[item.declaredState]}
        </Badge>
      </div>
      <span className="control-meta">{sourceScope}</span>
      <code>
        {item.location.label}
        {item.location.redacted ? ` · ${item.id.slice(-8)}` : ''}
      </code>
      <div className="codex-source-candidate-status">
        {item.metadata === 'invalid' && <Badge tone="orange">Metadata unverified</Badge>}
        <span>
          {item.scan.status === 'incomplete'
            ? 'Inspection incomplete'
            : item.scan.findings
              ? `${item.scan.findings} rule matches`
              : 'No matches in entrypoint'}
        </span>
      </div>
      <CodexSkillDisable report={report} item={item} historical={historical} action={controls} />
      <details className="artifact-section">
        <summary>Entrypoint evidence</summary>
        {item.entrypointSha256 ? (
          <>
            <span className="control-meta">SKILL.md SHA-256 · {item.bytes} bytes</span>
            <code className="inventory-digest">{item.entrypointSha256}</code>
          </>
        ) : (
          <p className="control-meta">Entrypoint fingerprint unavailable</p>
        )}
        <p className="control-meta">Entrypoint only · full skill tree was not inspected.</p>
        {item.scan.matches.length > 0 && (
          <ul className="codex-source-matches">
            {item.scan.matches.map((match, index) => (
              <li key={`${match.ruleId}:${index}`}>
                <div>
                  <strong>{match.title}</strong>
                  <Badge
                    tone={
                      match.severity === 'critical' || match.severity === 'high'
                        ? 'orange'
                        : 'muted'
                    }
                  >
                    {match.severity}
                  </Badge>
                </div>
                <code>{match.ruleId}</code>
              </li>
            ))}
          </ul>
        )}
        {item.scan.omitted > 0 && (
          <p className="control-meta">
            {item.scan.omitted} additional {item.scan.omitted === 1 ? 'match' : 'matches'} omitted.
          </p>
        )}
        {!!item.capabilities?.length && (
          <div className="codex-source-capabilities">
            <span className="control-meta">Static capability hints</span>
            <dl>
              {item.capabilities.map((capability) => (
                <div key={capability.kind}>
                  <dt>{capability.kind}</dt>
                  <dd>{capability.count}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </details>
    </article>
  );
}
export function SourceReport({
  report,
  historical,
  controls,
}: {
  report: CodexSkillSourcesReport;
  historical: boolean;
  controls: CodexSkillControlAction;
}) {
  return (
    <>
      <div className="codex-source-report-tools">
        <span className="control-meta">
          Inspected{' '}
          <time dateTime={report.generatedAt}>
            {new Date(report.generatedAt).toLocaleString('en-GB')}
          </time>
        </span>
        {historical && <Badge tone="orange">Historical capture</Badge>}
        <ExportButton
          label="Export source evidence"
          filename={`stroq-codex-sources-${report.workspaceId}.json`}
          data={() => ({ schema: 'stroq-codex-skill-sources-export/1', report, historical })}
        />
      </div>
      <dl className="property-list codex-source-context">
        <div>
          <dt>Codex data directory</dt>
          <dd>
            {report.context.profile === 'default'
              ? 'Default'
              : report.context.profile === 'custom'
                ? 'Custom'
                : 'Unverified'}
          </dd>
        </div>
        <div>
          <dt>Source boundary</dt>
          <dd>
            {BOUNDARY[report.context.boundary]}, {report.context.ancestorCount}{' '}
            {report.context.ancestorCount === 1 ? 'ancestor' : 'ancestors'}
          </dd>
        </div>
        <div>
          <dt>Marker policy</dt>
          <dd>{MARKERS[report.context.markerPolicy]}</dd>
        </div>
        <div>
          <dt>User configuration</dt>
          <dd>
            {SETTINGS[report.settings.status]}
            {report.settings.status === 'ready' && (
              <span className="control-meta">
                {' '}
                ({report.settings.rules} skill {report.settings.rules === 1 ? 'rule' : 'rules'},{' '}
                {report.settings.unmatchedRules} unmatched)
              </span>
            )}
          </dd>
        </div>
      </dl>
      <h3 className="codex-source-title">Source chain</h3>
      <ol className="codex-source-chain">
        {report.sources.map((source) => {
          const items = report.items.filter((item) => item.sourceId === source.id);
          const disabled = items.filter((item) => item.declaredState === 'disabled').length;
          return (
            <li key={source.id}>
              <div className="codex-source-heading">
                <code>{source.label}</code>
                <Badge tone={source.status === 'partial' ? 'orange' : 'muted'}>
                  {PRESENCE[source.status]}
                </Badge>
              </div>
              <span className="control-meta">
                {source.family === 'agents' || source.family === 'codex-legacy'
                  ? `${FAMILY[source.family]} · ${scopeLabel(source)}`
                  : scopeLabel(source)}
              </span>
              {items.length > 0 && (
                <details className="codex-source-items">
                  <summary>
                    {source.candidates} {source.candidates === 1 ? 'entrypoint' : 'entrypoints'}
                    {disabled > 0 ? ` · ${disabled} disabled in user config` : ''}
                  </summary>
                  <div>
                    {items.map((item) => (
                      <Candidate
                        key={item.id}
                        item={item}
                        source={source}
                        report={report}
                        historical={historical}
                        controls={controls}
                      />
                    ))}
                  </div>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      {!report.sources.length && <p className="control-meta">No source chain was established.</p>}
      {(report.omitted.sources > 0 || report.omitted.items > 0) && (
        <p className="control-meta" role="status">
          {report.omitted.sources} sources and {report.omitted.items} entrypoints omitted from this
          capture.
        </p>
      )}
      <details className="artifact-section codex-source-limits">
        <summary>
          Coverage & limits{report.gaps.length ? ` · ${report.gaps.length} gaps` : ''}
        </summary>
        <p className="control-meta">
          Bounded static reads of SKILL.md entrypoints. Sources can change during inspection; this
          is not an atomic snapshot.
        </p>
        {report.gaps.length > 0 && (
          <ul>
            {report.gaps.map((gap, index) => (
              <li key={`${gap.code}:${gap.sourceId ?? ''}:${index}`}>
                {gap.sourceId && (
                  <>
                    <code>
                      {report.sources.find((source) => source.id === gap.sourceId)?.label}
                    </code>{' '}
                    ·{' '}
                  </>
                )}
                {GAP[gap.code]}
              </li>
            ))}
          </ul>
        )}
        <span className="control-meta">Analysis runtime SHA-256</span>
        <code className="inventory-digest">{report.runtimeSha256}</code>
        {report.settings.sha256 && (
          <>
            <span className="control-meta">User configuration SHA-256</span>
            <code className="inventory-digest">{report.settings.sha256}</code>
          </>
        )}
      </details>
    </>
  );
}
