'use client';
import Link from 'next/link';
import { Badge } from '@/components/platform-ui';
import { CopyCommand } from '@/components/copy-command';
import { ACTION_LABELS } from '@/lib/incident-comparison';
import { JOURNAL_TOOL_TITLE, describeRow, type JournalRow } from '@/lib/journal-view';
import { chainCommands, hasEvidence, readBefore } from '@/lib/live-feed';
import { rulesReferenceHref } from '@/lib/rules-navigation';
import { IncidentComparisonPanel } from './incident-comparison';
import { IncidentRecordedEvidencePanel } from './incident-recorded-evidence';
import { useIncidentEvidence } from './use-incidents';
import { useIncidentRecordedEvidence } from './use-incident-recorded-evidence';

const when = (at: string): string => new Date(at).toLocaleString('en-GB');

/** The recorded evidence for a finding, read once when the row is opened. */
function Evidence({ row }: { row: JournalRow }) {
  const { state, busy, error, comparisons, compare } = useIncidentEvidence();
  const incident = state?.incidents.find((item) => item.evidenceSha === row.evidenceSha) ?? null;
  const evidence = useIncidentRecordedEvidence(incident);
  if (incident !== null)
    return (
      <>
        <IncidentRecordedEvidencePanel action={evidence} disabled={false} />
        {incident.kind !== 'content-flag' ? (
          <IncidentComparisonPanel
            report={comparisons.find((item) => item.incidentId === incident.id) ?? null}
            busy={busy !== null}
            comparing={busy === 'compare'}
            onCompare={() => void compare(incident)}
          />
        ) : null}
      </>
    );
  if (state === null && error === null)
    return (
      <p className="control-meta" role="status">
        {busy === 'load' ? 'Reading recorded evidence…' : 'Recorded evidence is not loaded.'}
      </p>
    );
  return (
    <p className="control-meta">
      {error ??
        'No recorded evidence for this row was found in the part of the journal that was read.'}
    </p>
  );
}

/**
 * What the agent read, what it did, what Stroq decided and which rule decided: the chain of one
 * recorded action, from the journal's own fields, with the commands that show more in a terminal.
 * The command, path or URL is not here: the journal projection keeps none of them.
 */
export function EventChain({
  row,
  rows,
  onOpen,
}: {
  row: JournalRow;
  rows: readonly JournalRow[];
  onOpen: (row: JournalRow) => void;
}) {
  const words = describeRow(row);
  const before = readBefore(rows, row);
  const commands = chainCommands(row);
  const flagged = row.phase === 'post';
  return (
    <div className="live-chain">
      <ol aria-label="What happened, in order">
        <li>
          <h4>What the agent read</h4>
          {flagged ? (
            <p>
              This result, from {JOURNAL_TOOL_TITLE[row.tool].toLowerCase()}, looked like an
              instruction to the agent.
            </p>
          ) : before.total > 0 ? (
            <>
              <p>
                Earlier in this session{' '}
                {before.total === 1 ? 'one result' : `${before.total} results`} looked like
                instructions to the agent. The journal shows the order; it does not say one caused
                the other.
              </p>
              <ul>
                {before.rows.map((earlier) => (
                  <li key={earlier.seq}>
                    <button className="inline-link" onClick={() => onOpen(earlier)}>
                      {when(earlier.at)} · {JOURNAL_TOOL_TITLE[earlier.tool]}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              No result that looked like an instruction was recorded before this one, in the rows on
              screen.
            </p>
          )}
        </li>
        <li>
          <h4>What it did</h4>
          <p>
            {words.title}.
            {row.classes.length > 0
              ? ` ${row.classes.map((value) => ACTION_LABELS[value]).join(', ')}.`
              : ' No risky kind of action was recorded.'}
          </p>
          <p className="muted">
            The command, path or address stays in the journal; <code>stroq why</code> prints it.
          </p>
        </li>
        <li>
          <h4>Decision</h4>
          <p>
            <Badge tone={words.tone}>{words.verdict}</Badge>{' '}
            <time dateTime={row.at}>{when(row.at)}</time>
          </p>
          <p className="muted">
            {flagged
              ? 'The result was scanned after the tool ran; this is not a decision.'
              : 'Recorded by Stroq’s rules. What the agent’s own program then did is not recorded here.'}
          </p>
        </li>
        <li>
          <h4>Rule</h4>
          <p>
            {row.ruleId === null ? (
              'Your own policy, or a built-in default: no bundled rule id was recorded.'
            ) : (
              <>
                Rule{' '}
                <Link className="inline-link" href={rulesReferenceHref(row.ruleId)}>
                  {row.ruleId}
                </Link>
              </>
            )}
          </p>
        </li>
      </ol>
      {hasEvidence(row) ? <Evidence row={row} /> : null}
      <section className="live-chain-commands" aria-label="In a terminal">
        <h4>In a terminal</h4>
        <CopyCommand command={commands.why} />
        <CopyCommand command={commands.untaint} />
        <p className="muted">
          <code>stroq why</code> prints what was run, what the session read and the exact
          <code> stroq untaint</code> line with the real session id. Clear a session only after a
          wrong call, outside the agent.
        </p>
      </section>
    </div>
  );
}
