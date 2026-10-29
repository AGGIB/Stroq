'use client';
import { useState } from 'react';
import {
  CODEX_PATH_GUARD_PRESETS,
  type CodexPathGuardPresetId,
  type CodexPathGuardPreset,
} from '@/lib/codex-path-guard';
import { CODEX_PATH_GUARD_LABELS, CODEX_PATH_GUARD_MESSAGES } from '@/lib/codex-path-guard-client';
import type { CodexPathGuardAction } from './use-codex-path-guard';
function presetStatus(row: CodexPathGuardPreset) {
  if (row.declaration === 'deny') return { text: 'Denied', label: 'Declared denied' };
  if (row.target === 'unsafe') return { text: 'Unsafe', label: 'Unsafe path metadata' };
  if (row.target === 'unavailable') return { text: 'Unverified', label: 'Metadata unavailable' };
  if (row.target === 'absent') return { text: 'Absent', label: 'Absent · future path' };
  if (row.declaration === 'unknown') return { text: 'Unverified', label: 'Declaration unverified' };
  return row.declaration === 'write'
    ? { text: 'Write', label: 'Declared write access' }
    : { text: 'Read', label: 'Declared read access' };
}
export function CodexPathGuardDefault({ action }: { action: CodexPathGuardAction }) {
  const c = action.capture,
    [selection, setSelection] = useState<{ hash: string; id: CodexPathGuardPresetId } | null>(null);
  const selected = selection?.hash === c?.binding?.captureSha256 ? selection?.id : null;
  const canPreview =
    action.canPrepare &&
    !!selected &&
    !!c?.presets.some((p) => p.id === selected && p.canGuard) &&
    !action.busy &&
    !action.pending.length &&
    !action.state?.records.some((r) => r.operationStatus === 'unknown');
  return (
    <section className="codex-path-default" aria-label="Codex credential path settings">
      <div className="codex-path-heading">
        <h3>Paths</h3>
        <button
          className={c ? 'inline-link' : 'button primary'}
          disabled={!action.connected || !!action.busy}
          onClick={() => void action.inspect()}
        >
          {action.busy === 'capture' ? 'Inspecting…' : c ? 'Inspect again' : 'Inspect settings'}
        </button>
      </div>
      <p className="control-meta">
        Inspect permission settings and path metadata. Credential contents stay unread.
      </p>
      {c?.reason && (
        <p className="control-error" role="alert">
          {CODEX_PATH_GUARD_MESSAGES[c.reason]}
        </p>
      )}
      <fieldset className="codex-path-presets">
        <legend className="sr-only">Select one credential path</legend>
        {CODEX_PATH_GUARD_PRESETS.map((id) => {
          const label = CODEX_PATH_GUARD_LABELS[id],
            row = c?.presets.find((p) => p.id === id),
            status = row ? presetStatus(row) : null;
          return (
            <label
              key={id}
              className="codex-path-preset"
              data-selected={selected === id || undefined}
            >
              <input
                type="radio"
                name="codex-credential-path"
                value={id}
                checked={selected === id}
                disabled={!row?.canGuard || !!action.busy}
                onChange={() => {
                  if (c?.binding && row?.canGuard)
                    setSelection({ hash: c.binding.captureSha256, id });
                }}
              />
              <span>
                <strong>{label.name}</strong>
                <span className="codex-path-preset-meta">
                  <code>{label.path}</code>
                  {status && (
                    <span
                      className="codex-path-preset-status"
                      aria-label={status.label}
                      title={status.label}
                    >
                      {status.text}
                    </span>
                  )}
                </span>
                {row?.reason &&
                  row.reason !== c?.reason &&
                  row.reason !== 'codex-path-guard-already-denied' && (
                    <span className="control-meta">{CODEX_PATH_GUARD_MESSAGES[row.reason]}</span>
                  )}
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="codex-path-actions">
        <button
          className="button primary"
          disabled={!canPreview}
          onClick={() => {
            if (selected) void action.prepare(selected);
          }}
        >
          Preview deny
        </button>
      </div>
      <p className="control-meta">
        Codex sandbox commands · this path only. Existing chats may not adopt a new setting.
      </p>
      <details className="codex-path-evidence">
        <summary>Scope & evidence</summary>
        <p>
          A deny blocks reads and writes at the selected path. Aliases, hardlinks and other copies
          need separate controls. Other profiles, trusted projects, session overrides and CLI
          options can differ. File tools and other client surfaces remain unverified; data already
          read is not revoked.
        </p>
        {c && (
          <>
            <dl className="property-list codex-path-facts">
              <div>
                <dt>Codex build</dt>
                <dd>{c.compatibility.version ?? 'Unverified'}</dd>
              </div>
              <div>
                <dt>Compatibility</dt>
                <dd>{c.compatibility.status}</dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd>
                  <time dateTime={c.capturedAt}>
                    {new Date(c.capturedAt).toLocaleTimeString('en-GB')}
                  </time>
                </dd>
              </div>
            </dl>
            {c.binding && (
              <>
                <span>Captured metadata SHA-256</span>
                <code>{c.binding.targetMetadataSha256}</code>
                <span>Captured settings SHA-256</span>
                <code>{c.binding.captureSha256}</code>
              </>
            )}
          </>
        )}
      </details>
    </section>
  );
}
