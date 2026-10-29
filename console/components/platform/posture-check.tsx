'use client';
import { useState } from 'react';
import Link from 'next/link';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { usePosture } from './use-posture';
import {
  AGENT_NAMES,
  CANNOT_CHECK,
  POSTURE_CATALOG,
  SCOPE_WORDS,
  SEVERITY_WORDS,
  SOURCE_STATE_WORDS,
  postureCounts,
  postureKey,
  postureLocation,
  uncheckedSources,
  type PostureAudit,
  type PostureChanges,
  type PostureFinding,
  type PostureSeverity,
} from '@/lib/posture';

type Filter = 'all' | 'serious';

const TONE: Readonly<Record<PostureSeverity, 'red' | 'orange' | 'muted'>> = {
  critical: 'red',
  high: 'orange',
  medium: 'muted',
  info: 'muted',
};

const TILES: readonly { severity: PostureSeverity; label: string }[] = [
  { severity: 'critical', label: 'Critical' },
  { severity: 'high', label: 'High' },
  { severity: 'medium', label: 'Medium' },
  { severity: 'info', label: 'Notes' },
];

function Counts({ audit }: { audit: PostureAudit }) {
  const counts = postureCounts(audit.findings);
  return (
    <ul className="posture-counts" aria-label="Findings by severity">
      {TILES.map(({ severity, label }) => (
        <li key={severity} className={`posture-count ${severity}`}>
          <span className="posture-count-number">{counts[severity]}</span>
          <span className="posture-count-label">{label}</span>
        </li>
      ))}
    </ul>
  );
}

function Finding({ finding, isNew }: { finding: PostureFinding; isNew: boolean }) {
  const entry = POSTURE_CATALOG[finding.id];
  const place = postureLocation(entry.agent, entry.file, finding.scope);
  return (
    <li className="posture-item">
      <div className="posture-head">
        <Badge tone={TONE[entry.severity]}>{SEVERITY_WORDS[entry.severity]}</Badge>
        <strong>{entry.title}</strong>
        {isNew ? <span className="posture-new">New</span> : null}
        {finding.count !== null ? (
          <span className="posture-rules">
            {finding.count.toLocaleString()} {finding.count === 1 ? 'rule' : 'rules'}
          </span>
        ) : null}
      </div>
      <p className="posture-where">
        <span>{AGENT_NAMES[finding.agent]}</span>
        {place ? <span className="mono">{place}</span> : null}
        <span>{SCOPE_WORDS[finding.scope]}</span>
      </p>
      <p className="posture-why">{entry.why}</p>
      <dl className="posture-fix">
        <dt>Setting</dt>
        <dd className="mono">{entry.setting}</dd>
        <dt>To change it</dt>
        <dd>{entry.fix}</dd>
      </dl>
    </li>
  );
}

function Verdict({ audit }: { audit: PostureAudit }) {
  const read = audit.sources.filter((source) => source.state === 'read').length;
  const unchecked = uncheckedSources(audit).length;
  const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
  if (read === 0 && unchecked === 0)
    return (
      <p className="posture-verdict">
        <strong>No settings files found.</strong> Nothing was checked, because none of the files
        listed below exist yet.
      </p>
    );
  if (read === 0)
    return (
      <p className="posture-verdict">
        <strong>No settings file could be read.</strong> Nothing was checked; see the files listed
        below.
      </p>
    );
  if (audit.findings.length === 0)
    return (
      <p className="posture-verdict">
        <strong>No weakening settings found</strong> in the {files(read)} read
        {unchecked > 0 ? `, and ${files(unchecked)} could not be checked` : ''}. That is not a
        statement that your agents are set up well; see what this cannot see below.
      </p>
    );
  const n = audit.findings.length;
  return (
    <p className="posture-verdict">
      <strong>
        {n} {n === 1 ? 'setting' : 'settings'} to look at
      </strong>{' '}
      in the {files(read)} read
      {unchecked > 0 ? `, and ${files(unchecked)} could not be checked` : ''}. Stroq changes nothing
      here: edit the file yourself, then check again.
    </p>
  );
}

/** The files that exist but could not be checked, named, so a file that hides itself is never a clean result. */
function Unchecked({ audit }: { audit: PostureAudit }) {
  const sources = uncheckedSources(audit);
  if (sources.length === 0) return null;
  return (
    <section className="posture-unchecked" aria-label="Files that could not be checked">
      <h2>Could not be checked</h2>
      <ul>
        {sources.map((source) => (
          <li key={`${source.agent}/${source.scope}/${source.file}`}>
            <span>{AGENT_NAMES[source.agent]}</span>
            <span className="mono">
              {postureLocation(source.agent, source.file, source.scope) ?? ''}
            </span>
            <span>{SOURCE_STATE_WORDS[source.state]}</span>
          </li>
        ))}
      </ul>
      <p>
        A file that is too large, is a link or cannot be understood may hold settings that are not
        in the findings. Look at it yourself.
      </p>
    </section>
  );
}

function Summary({ audit, changes }: { audit: PostureAudit; changes: PostureChanges | null }) {
  const since =
    changes !== null && (changes.added.size > 0 || changes.gone > 0)
      ? [
          changes.added.size > 0 ? `${changes.added.size} new` : null,
          changes.gone > 0 ? `${changes.gone} gone` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(', ')
      : null;
  return (
    <>
      <Verdict audit={audit} />
      <Unchecked audit={audit} />
      {since ? (
        <p className="posture-since" role="status">
          Since you last checked: {since}.
        </p>
      ) : null}
    </>
  );
}

export function PosturePage() {
  const { localAccess, audit, changes, state, error, reload } = usePosture({ track: true });
  const [filter, setFilter] = useState<Filter>('all');

  const shown =
    audit === null
      ? []
      : filter === 'all'
        ? audit.findings
        : audit.findings.filter((f) => {
            const severity = POSTURE_CATALOG[f.id].severity;
            return severity === 'critical' || severity === 'high';
          });

  return (
    <div className="page-stack" role="region" aria-label="Settings check">
      <PageHeading
        title="Settings check"
        description="Settings that weaken your agents. Stroq reads the settings files of Claude Code, Codex, Cursor and Windsurf, in your home folder and in this workspace, and lists the ones that switch off or loosen an agent’s own checks. It shows the setting, never its value."
        actions={
          localAccess ? (
            <button className="button" onClick={() => void reload()} disabled={state === 'loading'}>
              <RefreshCw size={15} aria-hidden="true" />
              Check again
            </button>
          ) : null
        }
      />
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect the local console"
            description="Open the private link printed by the local server. The settings check reads files in your own folders."
          />
        </Panel>
      ) : (
        <>
          {error ? (
            <p className="control-error" role="alert">
              <CircleAlert size={18} aria-hidden="true" />
              {error}
            </p>
          ) : null}
          {audit === null ? (
            state === 'loading' ? (
              <Panel>
                <EmptyState
                  title="Reading settings files"
                  description="This takes a moment. Nothing is changed."
                />
              </Panel>
            ) : null
          ) : (
            <>
              <Summary audit={audit} changes={changes} />
              <Counts audit={audit} />
              <Panel
                title="Findings"
                actions={
                  <div className="filter-tabs" role="group" aria-label="Show">
                    {(['all', 'serious'] as const).map((value) => (
                      <button
                        key={value}
                        className={filter === value ? 'is-active' : ''}
                        aria-pressed={filter === value}
                        onClick={() => setFilter(value)}
                      >
                        {value === 'all' ? 'Everything' : 'Critical and high'}
                      </button>
                    ))}
                  </div>
                }
              >
                {shown.length === 0 ? (
                  <EmptyState
                    title={filter === 'serious' ? 'Nothing critical or high' : 'Nothing to list'}
                    description={
                      audit.findings.length > 0
                        ? 'Switch to Everything to see the lower findings.'
                        : 'None of the checked settings were found in the files that could be read.'
                    }
                  />
                ) : (
                  <ul className="posture-list" aria-label="Settings that weaken an agent’s checks">
                    {shown.map((finding) => (
                      <Finding
                        key={postureKey(finding)}
                        finding={finding}
                        isNew={changes?.added.has(postureKey(finding)) ?? false}
                      />
                    ))}
                  </ul>
                )}
                <p className="posture-foot">
                  To see whether each agent really calls Stroq, open{' '}
                  <Link href="/agents/" className="inline-link">
                    Agents &amp; coverage
                  </Link>
                  . To see what your policy does with an action, use{' '}
                  <Link href="/try/" className="inline-link">
                    Try an action
                  </Link>
                  .
                </p>
              </Panel>
              <details className="posture-more">
                <summary>Files checked ({audit.sources.length})</summary>
                <ul className="posture-sources">
                  {audit.sources.map((source) => (
                    <li key={`${source.agent}/${source.scope}/${source.file}`}>
                      <span>{AGENT_NAMES[source.agent]}</span>
                      <span className="mono">
                        {postureLocation(source.agent, source.file, source.scope) ?? ''}
                      </span>
                      <span className={`posture-state ${source.state}`}>
                        {SOURCE_STATE_WORDS[source.state]}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
              <details className="posture-more">
                <summary>What this cannot see</summary>
                <ul className="posture-limits">
                  {audit.cannotCheck.map((id) => (
                    <li key={id}>
                      <strong>{CANNOT_CHECK[id].title}.</strong> {CANNOT_CHECK[id].why}
                    </li>
                  ))}
                  {audit.limitations.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </>
      )}
    </div>
  );
}
