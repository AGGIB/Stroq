'use client';
import { useEffect, useRef } from 'react';
import { LoaderCircle, Pause, Play, RefreshCw, Shield } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import {
  callControlApplyInput,
  callControlCanPrepare,
  callControlRecheckConfirmed,
  type McpCallControlTarget,
  type CallControlAck,
  type CallControlSetupRecovery,
} from '@/lib/mcp-call-control-binding';
import { useMcpCallControl } from './use-mcp-call-control';
type Controls = ReturnType<typeof useMcpCallControl>;
const titles = {
  setup: 'Configure paused',
  pause: 'Pause calls',
  resume: 'Resume calls',
  'rebind-paused': 'Hold new binding paused',
};
const reasonLabels = {
  'unsupported-wrapper': 'This registration cannot use call control.',
  'context-unavailable': 'The selected context could not be verified.',
  'source-unavailable': 'A configuration source could not be read.',
  'source-limit': 'The configuration source limit was reached.',
  'duplicate-control': 'This control appears in more than one registration.',
  'storage-unavailable': 'The native authority could not be verified.',
  'runtime-unavailable': 'The installed proxy runtime could not be verified.',
  'invocation-drift': 'The invocation differs from its retained control binding.',
};
const modeLabel = (mode: string | null | undefined) =>
  mode === 'enabled' ? 'Enabled' : mode === 'paused' ? 'Paused' : 'Unavailable';
export function McpCallControl({
  target,
  setupRecovery = null,
  enabled = true,
  disabled = false,
  onBusyChange,
  onChanged,
}: {
  target: McpCallControlTarget | null;
  setupRecovery?: CallControlSetupRecovery | null;
  enabled?: boolean;
  disabled?: boolean;
  onBusyChange?: (value: boolean) => void;
  onChanged?: () => void;
}) {
  const action = useMcpCallControl(target, enabled, setupRecovery);
  useEffect(() => {
    onBusyChange?.(action.busy === 'apply');
    return () => onBusyChange?.(false);
  }, [action.busy, onBusyChange]);
  if (!action.localAccess) return null;
  return (
    <McpCallControlPanel
      action={action}
      disabled={disabled}
      retained={target?.kind === 'retained'}
      onApply={async () => {
        const receipt = await action.apply();
        if (receipt) {
          onChanged?.();
          if (receipt.action !== 'setup') void action.refresh();
        }
      }}
      onRecheck={async (id) => {
        const value = await action.recheck(id);
        if (value && callControlRecheckConfirmed(value)) onChanged?.();
      }}
    />
  );
}
export function McpCallControlPanel({
  action,
  disabled = false,
  retained = false,
  onApply,
  onRecheck,
}: {
  action: Controls;
  disabled?: boolean;
  retained?: boolean;
  onApply: () => void | Promise<void>;
  onRecheck?: (id: string) => void | Promise<void>;
}) {
  const { view, preview, busy, pending, receipt, rechecked } = action;
  const consent = useRef<HTMLInputElement | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null),
    returnFocus = useRef(false);
  useEffect(() => {
    if (preview) consent.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [preview?.id]);
  const locked = disabled || busy !== null;
  const allowed = (name: keyof typeof titles) =>
    !action.needsRecheck && !action.capacityReached && callControlCanPrepare(view, name, retained);
  const check = (name: keyof CallControlAck, label: string, first = false) => (
    <label className="control-ack">
      <input
        ref={first ? consent : undefined}
        type="checkbox"
        checked={action.ack[name]}
        disabled={locked}
        onChange={(e) => action.acknowledge(name, e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
  const observation = view?.observation;
  return (
    <section className="mcp-containment-action" aria-label="MCP call control">
      <div className="inventory-signal-heading">
        <h3>Call control</h3>
        <Badge
          tone={
            view?.capability === 'drifted' ||
            view?.capability === 'ambiguous' ||
            view?.capability === 'unavailable'
              ? 'orange'
              : 'muted'
          }
        >
          {view?.current
            ? view.current.mode === 'paused'
              ? 'Desired: paused'
              : 'Desired: enabled'
            : view?.capability === 'setup-required'
              ? 'Not configured'
              : view?.capability === 'unsupported'
                ? 'Unsupported'
                : view
                  ? 'Unavailable'
                  : 'Awaiting refresh'}
        </Badge>
      </div>
      <p className="control-meta">New tools/call dispatch through this Stroq wrapper.</p>
      {view?.reason && <p className="control-meta">{reasonLabels[view.reason]}</p>}
      {observation && (
        <p className="control-meta">
          {observation.status === 'observed' ? (
            <>
              Last matching refusal · {observation.reason} ·{' '}
              {new Date(observation.at!).toLocaleString('en-GB')}
            </>
          ) : observation.status === 'unavailable' ? (
            'Recorded refusal evidence unavailable'
          ) : (
            'No matching refusal recorded'
          )}
        </p>
      )}
      {busy && (
        <p className="control-meta" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          {busy === 'apply'
            ? 'Recording this decision…'
            : busy === 'preview'
              ? 'Preparing preview…'
              : busy === 'recheck'
                ? 'Rechecking this operation…'
                : 'Reading control…'}
        </p>
      )}
      {preview ? (
        <div className="mcp-operation-notice">
          <h4>{titles[preview.action]}</h4>
          {preview.requiresReconnect && (
            <p className="control-meta">
              Adds call control to this registration. Reconnect the client to adopt it.
            </p>
          )}
          {preview.action === 'setup' && action.inspection?.modes.toolApproval && (
            <p className="control-meta">
              Tool approval remains required. Reconnect and review tools for the new launch context.
            </p>
          )}
          {preview.action === 'rebind-paused' && (
            <p className="control-meta">
              The changed invocation stays paused. Reconnect any older proxy connection.
            </p>
          )}
          {preview.proxyWorkspaceId !== preview.workspaceId && (
            <>
              <p className="control-meta">Existing fixed workspace context</p>
              <code className="inventory-digest">{preview.proxyWorkspaceId}</code>
            </>
          )}
          <div className="mcp-acknowledgements">
            {check(
              'scope',
              'Only new tools/call dispatch is controlled. Already dispatched calls and other MCP methods continue.',
              true,
            )}
            {preview.action === 'resume' &&
              check('weakening', 'Allow new calls again through this binding.')}
            {preview.sharedUserScope &&
              check('shared', 'Apply to this user registration across workspaces.')}
            {preview.changesConfiguration &&
              check(
                'storage',
                'Retain unencrypted original and edited configuration locally, including embedded values. No automatic expiry · 32 records / 17 MiB.',
              )}
          </div>
          <div className="mcp-action-buttons">
            <button
              className="button primary"
              disabled={locked || !callControlApplyInput(preview, action.ack)}
              onClick={() => void onApply()}
            >
              {preview.action === 'resume' ? (
                <Play size={16} />
              ) : preview.action === 'setup' ? (
                <Shield size={16} />
              ) : (
                <Pause size={16} />
              )}{' '}
              {titles[preview.action]}
            </button>
            <button
              className="button"
              disabled={busy !== null}
              onClick={() => {
                returnFocus.current = true;
                action.cancel();
              }}
            >
              Cancel preview
            </button>
          </div>
        </div>
      ) : (
        <div className="mcp-action-buttons">
          {(['setup', 'pause', 'resume', 'rebind-paused'] as const).filter(allowed).map((name) => (
            <button
              ref={trigger}
              key={name}
              className={name === 'pause' ? 'button primary' : 'button'}
              disabled={locked}
              onClick={() => void action.prepare(name)}
            >
              {name === 'resume' ? (
                <Play size={16} />
              ) : name === 'setup' ? (
                <Shield size={16} />
              ) : (
                <Pause size={16} />
              )}{' '}
              {name === 'setup' ? 'Set up call control' : titles[name]}
            </button>
          ))}
          {!action.needsRecheck && action.canRefresh !== false && (
            <button className="button" disabled={locked} onClick={() => void action.refresh()}>
              <RefreshCw size={16} /> Refresh control
            </button>
          )}
        </div>
      )}
      {pending.map((write) => (
        <div className="mcp-history-outcome" key={write.preview.operationId} role="status">
          <strong>Completion unknown</strong>
          <p className="control-meta">
            {titles[write.preview.action]} · {new Date(write.startedAt).toLocaleString('en-GB')}
          </p>
          {view && write.preview.contextId !== view.contextId && (
            <p className="control-meta">
              Reconnect the original local profile to recheck this operation.
            </p>
          )}
          <button
            className="button"
            disabled={locked}
            onClick={() => void (onRecheck ?? action.recheck)(write.preview.operationId)}
          >
            <RefreshCw size={16} /> Recheck operation
          </button>
        </div>
      ))}
      {(action.foreignPending ?? []).map((write) => (
        <details
          className="artifact-section"
          key={write.preview.contextId + ':' + write.preview.operationId}
        >
          <summary>Other local profile · completion unknown</summary>
          <p className="control-meta">
            {titles[write.preview.action]} · {new Date(write.startedAt).toLocaleString('en-GB')}.
            Reconnect the original local profile to recheck.
          </p>
          <code className="inventory-digest">{write.preview.contextId}</code>
        </details>
      ))}
      {(action.unscopedPending ?? []).map((write) => (
        <details
          className="artifact-section"
          key={write.preview.contextId + ':' + write.preview.operationId}
        >
          <summary>Profile not verified · retained operation</summary>
          <p className="control-meta">
            Refresh controls to verify the local profile before rechecking this operation.
          </p>
          <code className="inventory-digest">{write.preview.contextId}</code>
        </details>
      ))}
      {action.setupRecovery &&
        action.setupRecovery.contextId === action.contextId &&
        !pending.some(
          (w) => w.preview.operationId === action.setupRecovery!.candidate.operationId,
        ) &&
        !(
          rechecked?.operationId === action.setupRecovery.candidate.operationId &&
          callControlRecheckConfirmed(rechecked)
        ) && (
          <div className="mcp-history-outcome">
            <strong>Retained setup</strong>
            <p className="control-meta">
              Recheck the original setup operation and its configuration.
            </p>
            <button
              className="button"
              disabled={locked}
              onClick={() =>
                void (onRecheck ?? action.recheck)(action.setupRecovery!.candidate.operationId)
              }
            >
              <RefreshCw size={16} /> Recheck setup
            </button>
          </div>
        )}
      {receipt && (
        <div className="mcp-history-outcome" role="status">
          <strong>
            {receipt.authority !== 'confirmed'
              ? 'Decision unconfirmed'
              : receipt.action === 'setup'
                ? receipt.configuration === 'confirmed'
                  ? 'Configured paused'
                  : 'Paused authority recorded; configuration unconfirmed'
                : receipt.action === 'resume'
                  ? 'Resume recorded'
                  : receipt.action === 'pause'
                    ? 'Pause recorded'
                    : 'New binding recorded paused'}
          </strong>
          <p className="control-meta">
            {receipt.requiresReconnect
              ? 'Reconnect the client to adopt this configuration.'
              : 'Native decision recorded; live client adoption is not established.'}
          </p>
        </div>
      )}
      {rechecked && (
        <div className="mcp-history-outcome" role="status">
          <strong>
            {rechecked.authority === 'recorded'
              ? 'Operation recorded'
              : rechecked.authority === 'absent'
                ? 'No matching event at recheck'
                : 'Operation unavailable'}
          </strong>
          {rechecked.currentEventId && (
            <p className="control-meta">
              Latest desired state: {modeLabel(rechecked.currentMode)}
              {rechecked.currentEventId !== rechecked.operationId ? ' · Later decision' : ''}
            </p>
          )}
          {rechecked.action === 'setup' && (
            <p className="control-meta">
              Configuration {rechecked.configuration}.{' '}
              {rechecked.configuration === 'confirmed'
                ? 'Reconnect the client.'
                : 'Recovery still needs attention.'}
            </p>
          )}
        </div>
      )}
      {action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {action.capacityReached && !action.needsRecheck && (
        <p className="control-meta">Recheck outstanding operations before another change.</p>
      )}
      {view && (
        <details className="artifact-section">
          <summary>Scope & binding</summary>
          <p className="control-meta">
            Desired state is separate from recorded refusal evidence. Other clients, processes and
            MCP methods remain outside this control.
          </p>
          <p className="control-meta">
            {view.proxyWorkspaceId === view.workspaceId
              ? 'This workspace'
              : 'Existing fixed workspace context'}
          </p>
          <code className="inventory-digest">{view.proxyWorkspaceId ?? 'Unavailable'}</code>
          <p className="control-meta">Selected local profile</p>
          <code className="inventory-digest">{view.contextId}</code>
          {view.controlId && (
            <>
              <p className="control-meta">Control</p>
              <code className="inventory-digest">{view.controlId}</code>
            </>
          )}
        </details>
      )}
    </section>
  );
}
