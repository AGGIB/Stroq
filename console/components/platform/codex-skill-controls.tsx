'use client';
import { useEffect, useRef } from 'react';
import { LoaderCircle, RotateCcw, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import type { CodexSkillSourceItem, CodexSkillSourcesReport } from '@/lib/codex-skill-sources';
import type { CodexSkillControlRecord } from '@/lib/codex-skill-controls';
import {
  codexSkillDisableSelection,
  codexSkillControlUnfinished,
  CODEX_SKILL_CONTROL_ERROR_MESSAGES,
} from '@/lib/codex-skill-controls-client';
import type { CodexSkillControlAction } from './use-codex-skill-controls';
export function CodexSkillDisable({
  report,
  item,
  historical,
  action,
}: {
  report: CodexSkillSourcesReport;
  item: CodexSkillSourceItem;
  historical: boolean;
  action: CodexSkillControlAction;
}) {
  const eligible =
    !historical &&
    !!codexSkillDisableSelection(report, item) &&
    report.context.controlContextId === action.state?.controlContextId;
  if (item.declaredState === 'disabled') return null;
  return (
    <div className="codex-skill-control-entry">
      <button
        className="button"
        disabled={
          !eligible ||
          !action.available ||
          !!action.busy ||
          action.pending.length > 0 ||
          action.state?.records.some(codexSkillControlUnfinished)
        }
        onClick={() => void action.prepareDisable(report, item, historical)}
      >
        <ShieldOff size={15} aria-hidden="true" />
        Disable this path
      </button>
      {(!report.context.controlContextId || historical) && (
        <span className="control-meta">Inspect again to change this declaration.</span>
      )}
    </div>
  );
}
export function CodexSkillControlPanel({ action }: { action: CodexSkillControlAction }) {
  const p = action.preview,
    heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (p) heading.current?.focus();
  }, [p?.id]);
  return (
    <>
      {action.state?.error && (
        <p className="control-error" role="alert">
          {CODEX_SKILL_CONTROL_ERROR_MESSAGES[action.state.error]}
        </p>
      )}
      {action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {action.completion?.writeConfirmed && (
        <p className="control-meta" role="status">
          {action.completion.record.operationStatus === 'restored'
            ? 'Previous declaration restored.'
            : 'Path disable written and read back.'}{' '}
          Native session adoption unverified.
        </p>
      )}
      {p && (
        <section
          className="codex-skill-control-preview"
          aria-label="Review Codex configuration change"
        >
          <div className="codex-skill-control-heading">
            <h3 ref={heading} tabIndex={-1}>
              {p.operation === 'disable'
                ? 'Disable this skill path'
                : 'Restore previous declaration'}
            </h3>
            <Badge tone="orange">User config</Badge>
          </div>
          <strong>{p.name}</strong>
          {(p.location.redacted || p.location.label !== p.name) && (
            <code>
              {p.location.label}
              {p.location.redacted ? ' · location withheld' : ''}
            </code>
          )}
          <p className="control-meta">
            {p.operation === 'disable'
              ? 'Disable this SKILL.md path, including future versions.'
              : 'Removes Stroq’s owned change and preserves later unrelated settings.'}
          </p>
          <p className="control-meta">
            Base user config; named profiles and session overrides may differ. Start a new chat or
            restart Codex. Already loaded instructions remain.
          </p>
          {p.operation === 'disable' && p.sameNameCopies > 0 && (
            <p className="control-meta">
              {p.sameNameCopies} other captured {p.sameNameCopies === 1 ? 'copy' : 'copies'} with
              this name {p.sameNameCopies === 1 ? 'stays' : 'stay'} unchanged.
            </p>
          )}
          <div className="codex-skill-control-consent">
            <label>
              <input
                type="checkbox"
                checked={action.ack.shared}
                disabled={!!action.busy}
                onChange={(e) => action.acknowledge('shared', e.target.checked)}
              />
              <span>Change this Codex user configuration across workspaces.</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={action.ack.retention}
                disabled={!!action.busy}
                onChange={(e) => action.acknowledge('retention', e.target.checked)}
              />
              <span>
                Retain private, unencrypted configuration copies, including unrelated settings or
                credentials, without automatic expiry.
              </span>
            </label>
            {p.operation === 'restore' && (
              <label>
                <input
                  type="checkbox"
                  checked={action.ack.weakening}
                  disabled={!!action.busy}
                  onChange={(e) => action.acknowledge('weakening', e.target.checked)}
                />
                <span>
                  Remove this disable rule. The prior declaration may allow this path again.
                </span>
              </label>
            )}
          </div>
          <div className="codex-skill-control-actions">
            <button
              className="button primary"
              disabled={!action.canApply || !!action.busy}
              onClick={() => void action.apply()}
            >
              {action.busy === 'apply' && (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              )}
              {p.operation === 'disable' ? 'Apply disable' : 'Restore declaration'}
            </button>
            <button className="button" disabled={!!action.busy} onClick={action.clearPreview}>
              Cancel preview
            </button>
          </div>
          <details className="artifact-section">
            <summary>Configuration fingerprints</summary>
            <span className="control-meta">Before</span>
            <code className="inventory-digest">{p.beforeSha256 ?? 'File absent'}</code>
            <span className="control-meta">After</span>
            <code className="inventory-digest">{p.afterSha256 ?? 'File absent'}</code>
            <span className="control-meta">
              Preview expires{' '}
              <time dateTime={p.expiresAt}>
                {new Date(p.expiresAt).toLocaleTimeString('en-GB')}
              </time>{' '}
              · formatting preserved
            </span>
          </details>
        </section>
      )}
    </>
  );
}
const STATUS: Record<CodexSkillControlRecord['operationStatus'], string> = {
  prepared: 'Write prepared',
  disabled: 'Disable recorded',
  restoring: 'Restore prepared',
  restored: 'Restore recorded',
  unknown: 'Completion unknown',
};
const STANDING: Record<CodexSkillControlRecord['standing'], string> = {
  disabled: 'Current base declaration: disabled',
  'enabled-or-unspecified': 'Current base declaration: enabled or unspecified',
  changed: 'Current configuration changed',
  unavailable: 'Current declaration unavailable',
};
export function CodexSkillSavedChanges({
  action,
  selectedId = null,
}: {
  action: CodexSkillControlAction;
  selectedId?: string | null;
}) {
  const records = action.state?.records ?? [],
    selected = selectedId ? records.find((r) => r.id === selectedId) : null;
  const pending = [...action.pending, ...action.unscopedPending];
  const unresolved = pending.filter(
    (write) =>
      !records.some(
        (r) => r.id === write.preview.recordId && r.operationId === write.preview.operationId,
      ),
  );
  return (
    <section className="codex-skill-saved-changes" aria-label="Saved Codex changes">
      <div className="codex-skill-control-heading">
        <h3>Saved changes</h3>
        <button
          className="button"
          disabled={!!action.busy || !action.connected}
          onClick={() => void action.refresh()}
        >
          {action.busy === 'load' ? 'Loading…' : 'Reload saved changes'}
        </button>
      </div>
      {action.busy === 'load' && !action.state && (
        <p className="control-meta" role="status">
          Reading saved declarations…
        </p>
      )}
      {action.state?.history === 'unavailable' && (
        <p className="control-error" role="alert">
          Saved change storage is unavailable. Recovery was not attempted.
        </p>
      )}
      {selectedId && !selected && action.state && (
        <p className="control-meta" role="status">
          The linked change is absent from this read. Earlier completion remains unverified.
        </p>
      )}
      {unresolved.map((write) => (
        <div
          className="codex-skill-control-unresolved"
          key={write.preview.operationId}
          role="status"
        >
          <strong>{write.preview.name}</strong>
          <Badge tone="orange">Completion unknown</Badge>
          <p className="control-meta">
            The exact operation is not available for recheck in this read. Reload saved changes; its
            absence does not establish that no write occurred.
          </p>
          <code>{write.preview.recordId}</code>
        </div>
      ))}
      {action.foreignPending.length > 0 && (
        <p className="control-meta" role="status">
          {action.foreignPending.length} unresolved{' '}
          {action.foreignPending.length === 1 ? 'change belongs' : 'changes belong'} to another
          Codex data directory. Reconnect that context to recheck.
        </p>
      )}
      {action.state &&
        !records.length &&
        action.state.history !== 'unavailable' &&
        action.busy !== 'load' && (
          <p className="control-meta">No saved declarations in this Codex data directory.</p>
        )}
      <div className="codex-skill-control-records">
        {[...(selected ? [selected] : []), ...records.filter((r) => r.id !== selected?.id)].map(
          (record) => {
            const unknown = pending.some(
              (w) =>
                w.preview.recordId === record.id && w.preview.operationId === record.operationId,
            );
            return (
              <article
                key={record.id}
                className="codex-skill-control-record"
                data-control-record={record.id}
                data-selected={record.id === selectedId || undefined}
              >
                <div className="codex-skill-control-heading">
                  <strong>{record.name}</strong>
                  <Badge tone={codexSkillControlUnfinished(record) || unknown ? 'orange' : 'muted'}>
                    {unknown ? 'Completion unknown' : STATUS[record.operationStatus]}
                  </Badge>
                </div>
                <code>
                  {record.location.label}
                  {record.location.redacted ? ' · location withheld' : ''}
                </code>
                <span className="control-meta">{STANDING[record.standing]}</span>
                <span className="control-meta">
                  User configuration · native session adoption unverified
                </span>
                <div className="codex-skill-control-actions">
                  {record.canRestore && !unknown && (
                    <button
                      className="button"
                      disabled={!!action.busy || !action.available}
                      onClick={() => void action.prepareRestore(record)}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      Preview restore
                    </button>
                  )}
                  {(unknown || codexSkillControlUnfinished(record)) && (
                    <button
                      className="button"
                      disabled={!!action.busy}
                      onClick={() => void action.recheck(record)}
                    >
                      Recheck exact change
                    </button>
                  )}
                </div>
                <details className="artifact-section">
                  <summary>Recorded evidence</summary>
                  <code>{record.id}</code>
                  <span className="control-meta">
                    Updated{' '}
                    <time dateTime={record.updatedAt}>
                      {new Date(record.updatedAt).toLocaleString('en-GB')}
                    </time>{' '}
                    · recorded status and current declaration are separate
                  </span>
                </details>
              </article>
            );
          },
        )}
      </div>
    </section>
  );
}
