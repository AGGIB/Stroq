'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { KeyRound, LoaderCircle, X } from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateSecretScanJob,
  validateSecretScanPreview,
  type SecretScanJob,
  type SecretScanPreview,
} from '@/lib/secret-scan';

export function SecretScanDialog({
  disabled,
  onStarted,
  onRefresh,
}: {
  disabled: boolean;
  onStarted: (job: SecretScanJob) => void;
  onRefresh: () => void;
}) {
  const { requestLocal } = usePlatform();
  const [open, setOpen] = useState(false),
    [scope, setScope] = useState<'project' | 'last'>('project');
  const [preview, setPreview] = useState<SecretScanPreview | null>(null),
    [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const checkboxId = useId();
  useEffect(() => () => active.current?.abort(), []);
  const request = async (path: string, body: unknown) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await requestLocal(path, body, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };
  const prepare = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setAck(false);
    try {
      const value = await request('/api/secrets/preview', { scope });
      if (!validateSecretScanPreview(value) || value.scope !== scope)
        throw new Error('Unsupported credential scan preview.');
      setPreview(value);
    } catch (e) {
      setError(
        e instanceof Error && e.name !== 'AbortError' ? e.message : 'Scan preview timed out.',
      );
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!preview?.canStart || !ack) return;
    setBusy(true);
    setError(null);
    try {
      const value = await request('/api/secrets/start', {
        previewId: preview.id,
        acknowledgeCredentialRead: true,
      });
      if (!validateSecretScanJob(value) || value.scope !== preview.scope)
        throw new Error('Unsupported credential scan response.');
      onStarted(value);
      setOpen(false);
    } catch (e) {
      setPreview(null);
      setAck(false);
      onRefresh();
      setError(
        e instanceof Error && e.name !== 'AbortError'
          ? e.message
          : 'Scan response timed out. Refresh to check whether it started.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        setOpen(value);
        if (value) {
          setScope('project');
          setPreview(null);
          setAck(false);
          setError(null);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button className="button primary" disabled={disabled}>
          <KeyRound size={17} />
          Scan credentials
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content secret-scan-dialog">
          <div className="dialog-header">
            <div>
              <Dialog.Title>Check recorded exposure</Dialog.Title>
              <Dialog.Description>
                Compare available credentials with saved agent sessions.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="icon-button dialog-close"
              disabled={busy}
              aria-label="Close scan setup"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          {error && (
            <p className="control-error" role="alert">
              {error}
            </p>
          )}
          <label className="secret-scope-label">
            Sessions
            <select
              className="select-field"
              value={scope}
              disabled={busy}
              onChange={(e) => {
                setScope(e.target.value as 'project' | 'last');
                setPreview(null);
                setAck(false);
              }}
            >
              <option value="project">Related workspace sessions</option>
              <option value="last">Most recent related session</option>
            </select>
          </label>
          {preview && (
            <div className="secret-consent">
              <p>
                <strong>What this scan reads</strong>
              </p>
              <p>
                Known home credential files, environment variables, and .env files in this
                workspace, recorded session folders and their project ancestors. Credential symlinks
                and registered canary paths may resolve elsewhere.
              </p>
              <p>
                It also reads saved Claude Code, Codex and Cursor sessions, referenced saved
                outputs, and local MCP and Git metadata. Cursor discovery reads its session store
                before filtering by workspace.
              </p>
              <div className="control-meta">
                No provider requests. Credential values stay out of reports. Takes up to 2 minutes.
              </div>
              {!preview.canStart ? (
                <p className="control-error">Build the local engine before starting a scan.</p>
              ) : (
                <label className="secret-consent-check" htmlFor={checkboxId}>
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={ack}
                    disabled={busy}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  <span>
                    Allow this scan to read local credential values and session files as described
                    above.
                  </span>
                </label>
              )}
            </div>
          )}
          <div className="dialog-footer">
            <Dialog.Close asChild>
              <button className="button" disabled={busy}>
                Cancel
              </button>
            </Dialog.Close>
            {preview ? (
              <button
                className="button primary"
                disabled={busy || !ack || !preview.canStart}
                onClick={() => void start()}
              >
                {busy && <LoaderCircle className="spin" size={16} />}Start scan
              </button>
            ) : (
              <button className="button primary" disabled={busy} onClick={() => void prepare()}>
                {busy && <LoaderCircle className="spin" size={16} />}Review access
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
