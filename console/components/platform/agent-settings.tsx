'use client';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import type { PostureState } from './use-posture';
import {
  AGENT_NAMES,
  CANNOT_CHECK,
  POSTURE_CATALOG,
  SCOPE_WORDS,
  SEVERITY_WORDS,
  SOURCE_STATE_WORDS,
  postureKey,
  postureLocation,
  uncheckedSources,
  type PostureAudit,
  type PostureChanges,
  type PostureFinding,
  type PostureSeverity,
} from '@/lib/posture';

const TONE: Readonly<Record<PostureSeverity, 'red' | 'orange' | 'muted'>> = {
  critical: 'red',
  high: 'orange',
  medium: 'muted',
  info: 'muted',
};

export function Finding({ finding, isNew }: { finding: PostureFinding; isNew: boolean }) {
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

const SERIOUS: readonly PostureSeverity[] = ['critical', 'high'];

/** The findings of one agent, and the words for none: this is where a setting that weakens it is read. */
export function AgentSettings({
  agent,
  audit,
  changes,
  state,
}: {
  agent: PostureFinding['agent'];
  audit: PostureAudit | null;
  changes: PostureChanges | null;
  state: PostureState;
}) {
  if (audit === null)
    return (
      <p className="control-meta" role="status">
        {state === 'error'
          ? 'The settings check could not be read, so nothing is said about this agent’s settings.'
          : 'Reading this agent’s settings files…'}
      </p>
    );
  const findings = audit.findings.filter((finding) => finding.agent === agent);
  const read = audit.sources.filter((source) => source.agent === agent && source.state === 'read');
  const unchecked = uncheckedSources(audit).filter((source) => source.agent === agent);
  const serious = findings.some((finding) =>
    SERIOUS.includes(POSTURE_CATALOG[finding.id].severity),
  );
  return (
    <details className="agent-row-settings" open={serious || undefined}>
      <summary>
        Settings that weaken it
        <Badge tone={serious ? 'orange' : 'muted'}>
          {findings.length === 0
            ? read.length === 0
              ? 'No settings file read'
              : 'None found'
            : `${findings.length} to look at`}
        </Badge>
      </summary>
      {findings.length > 0 ? (
        <ul className="posture-list" aria-label={`Settings that weaken ${AGENT_NAMES[agent]}`}>
          {findings.map((finding) => (
            <Finding
              key={postureKey(finding)}
              finding={finding}
              isNew={changes?.added.has(postureKey(finding)) ?? false}
            />
          ))}
        </ul>
      ) : (
        <p className="control-meta">
          {read.length === 0
            ? 'None of this agent’s settings files exist, or none could be read, so nothing was checked.'
            : `None of the checked settings were found in the ${read.length} ${read.length === 1 ? 'file' : 'files'} read.`}
        </p>
      )}
      {unchecked.length > 0 ? (
        <p className="control-meta">
          {unchecked.length} {unchecked.length === 1 ? 'file' : 'files'} could not be checked; look
          at {unchecked.length === 1 ? 'it' : 'them'} yourself.
        </p>
      ) : null}
    </details>
  );
}

/**
 * The settings check as a whole, under the agents: the verdict, what changed since the last look,
 * the findings of agents that have no row above (Windsurf, whose settings are read and whose hooks
 * the console does not set up), the files that could not be checked, the files read and what the
 * check cannot see. Stroq changes nothing here.
 */
export function SettingsCheck({
  audit,
  changes,
  state,
  error,
  shownAgents,
  onReload,
}: {
  audit: PostureAudit | null;
  changes: PostureChanges | null;
  state: PostureState;
  error: string | null;
  shownAgents: readonly string[];
  onReload: () => void;
}) {
  const others = audit?.findings.filter((finding) => !shownAgents.includes(finding.agent)) ?? [];
  return (
    <section id="settings" className="settings-check" aria-labelledby="settings-check-title">
      <div className="settings-check-head">
        <h2 id="settings-check-title">Settings check</h2>
        <button className="button small" onClick={onReload} disabled={state === 'loading'}>
          <RefreshCw
            size={15}
            className={state === 'loading' ? 'spin' : undefined}
            aria-hidden="true"
          />
          Check again
        </button>
      </div>
      <p className="control-meta">
        Settings that weaken an agent’s own checks, read from the settings files of Claude Code,
        Codex, Cursor and Windsurf in your home folder and in this workspace. It shows the setting,
        never its value.
      </p>
      {error ? (
        <p className="control-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {audit === null ? (
        state === 'loading' ? (
          <p className="control-meta" role="status">
            Reading settings files. Nothing is changed.
          </p>
        ) : null
      ) : (
        <>
          <Summary audit={audit} changes={changes} />
          {others.length > 0 ? (
            <ul className="posture-list" aria-label="Settings of other agents that weaken them">
              {others.map((finding) => (
                <Finding
                  key={postureKey(finding)}
                  finding={finding}
                  isNew={changes?.added.has(postureKey(finding)) ?? false}
                />
              ))}
            </ul>
          ) : null}
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
    </section>
  );
}
