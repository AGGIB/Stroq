'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Archive, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import type { SkillQuarantineArtifact, SkillQuarantineReceipt } from '@/lib/skill-quarantine';
import { InventorySource } from './inventory-source';
import { useQuarantineAction } from './use-quarantine-action';

export function QuarantineAction({
  action,
  artifact,
  workspaceId,
  recordId,
  disabled = false,
  onCompleted,
  onBusyChange,
  onRechecked,
}: {
  action: 'quarantine' | 'restore';
  artifact: SkillQuarantineArtifact;
  workspaceId: string;
  recordId?: string;
  disabled?: boolean;
  onCompleted: (receipt: SkillQuarantineReceipt) => void;
  onBusyChange?: (busy: boolean) => void;
  onRechecked?: () => void;
}) {
  const control = useQuarantineAction({
    action,
    artifact,
    workspaceId,
    recordId,
    disabled,
    onCompleted,
    onRechecked,
  });
  const { preview, busy, acknowledged, needsRecheck, error } = control;
  const trigger = useRef<HTMLButtonElement | null>(null),
    acknowledge = useRef<HTMLInputElement | null>(null),
    recheck = useRef<HTMLButtonElement | null>(null),
    returnToTrigger = useRef(false);
  useEffect(() => {
    onBusyChange?.(busy === 'apply');
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (preview) acknowledge.current?.focus();
    else if (needsRecheck) recheck.current?.focus();
    else if (returnToTrigger.current) {
      returnToTrigger.current = false;
      trigger.current?.focus();
    }
  }, [preview, needsRecheck]);
  const restoring = action === 'restore';
  return (
    <section
      className="quarantine-action"
      aria-label={restoring ? 'Restore retained skill' : 'Quarantine this skill version'}
    >
      <h3>{restoring ? 'Restore this version' : 'Quarantine this version'}</h3>
      <p className="control-meta">
        {restoring
          ? 'Restore retained files when the original location is free.'
          : 'Move this folder out of its source. Keep its files for restoration.'}
      </p>
      {preview ? (
        <>
          <div className="quarantine-source" aria-label="Selected source folder">
            <InventorySource item={{ ...preview.artifact, kind: 'skill' }} />
          </div>
          <dl className="property-list">
            <div>
              <dt>Scope</dt>
              <dd>
                {preview.affectsAllWorkspaces ? 'User · all workspaces' : 'This workspace'}
                {preview.artifact.skillSource === 'agents-skills' && (
                  <small className="control-meta"> · shared source</small>
                )}
              </dd>
            </div>
            <div>
              <dt>Retained version</dt>
              <dd>
                {preview.files} files · {preview.bytes.toLocaleString()} bytes
              </dd>
            </div>
          </dl>
          <code className="inventory-digest">{preview.artifact.sha256}</code>
          <div className="quarantine-session-note">
            <Badge tone="orange">New session required</Badge>
            <p>
              Loaded instructions and other copies remain available.
              {preview.artifact.skillSource === 'agents-skills' &&
                ' This shared source can be read by more than one agent.'}
            </p>
          </div>
          <label className="consent-line">
            <input
              ref={acknowledge}
              type="checkbox"
              checked={acknowledged}
              disabled={busy === 'apply'}
              onChange={(event) => control.acknowledge(event.target.checked)}
            />
            <span>I understand the limits for existing sessions and other copies.</span>
          </label>
          <details className="artifact-section">
            <summary>Scope & retention</summary>
            {preview.limitations.map((limit) => (
              <p className="control-meta" key={limit}>
                {limit}
              </p>
            ))}
            <p className="control-meta">
              Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
            </p>
          </details>
          <div className="quarantine-buttons">
            <button
              className="button primary"
              disabled={disabled || busy !== null || !acknowledged || needsRecheck}
              onClick={() => void control.apply()}
            >
              {busy === 'apply' ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : restoring ? (
                <RotateCcw size={16} aria-hidden="true" />
              ) : (
                <Archive size={16} aria-hidden="true" />
              )}
              {busy === 'apply' ? 'Applying…' : restoring ? 'Restore files' : 'Quarantine version'}
            </button>
            <button
              className="button"
              disabled={busy !== null}
              onClick={() => {
                returnToTrigger.current = true;
                control.cancel();
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : needsRecheck ? (
        <button
          className="button"
          ref={recheck}
          disabled={disabled || busy !== null}
          onClick={() => void control.recheck()}
        >
          {busy === 'recheck' ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={16} aria-hidden="true" />
          )}
          {busy === 'recheck' ? 'Rechecking…' : 'Recheck retained folders'}
        </button>
      ) : (
        <button
          className="button"
          ref={trigger}
          disabled={disabled || busy !== null}
          onClick={() => void control.prepare()}
        >
          {busy === 'preview' ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : restoring ? (
            <RotateCcw size={16} aria-hidden="true" />
          ) : (
            <Archive size={16} aria-hidden="true" />
          )}
          {busy === 'preview' ? 'Preparing…' : restoring ? 'Preview restore' : 'Preview quarantine'}
        </button>
      )}
      {needsRecheck && (
        <Link className="inline-link" href="/skills/quarantine/">
          Open quarantine history
        </Link>
      )}
      {error && (
        <p className="control-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
