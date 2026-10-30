'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LoaderCircle, RotateCcw, Shield, Unplug } from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import { McpContainmentPreviewDetails } from './mcp-containment-preview';
import {
  mcpContainmentApplyInput,
  mcpContainmentPreviewMatches,
  type McpContainmentAcknowledgements,
  mcpContainmentReceiptMatches,
  type McpContainmentTarget,
} from '@/lib/mcp-containment-binding';
import {
  validateMcpContainmentPreview,
  validateMcpContainmentReceipt,
  type McpContainmentPreview,
  type McpContainmentReceipt,
  type McpProxyConfiguration,
} from '@/lib/mcp-containment';

export function McpContainmentAction({
  action,
  artifact,
  workspaceId,
  recordId,
  recordProxy = null,
  toolApproval = false,
  disabled = false,
  onCompleted,
  onBusyChange,
  onNeedsRecheck,
}: {
  action: McpContainmentPreview['action'];
  artifact: McpContainmentTarget;
  workspaceId: string;
  recordId?: string;
  recordProxy?: McpProxyConfiguration | null;
  toolApproval?: boolean;
  disabled?: boolean;
  onCompleted: (receipt: McpContainmentReceipt) => void;
  onBusyChange?: (busy: boolean) => void;
  onNeedsRecheck?: () => void;
}) {
  const { requestLocal, localContext } = usePlatform();
  const [preview, setPreview] = useState<McpContainmentPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emptyAcknowledgements = (): McpContainmentAcknowledgements => ({
    session: false,
    retention: false,
    proxy: false,
    sharedPolicy: false,
    toolContracts: false,
  });
  const [acknowledgements, setAcknowledgements] = useState(emptyAcknowledgements);
  const [applyFailed, setApplyFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null),
    acknowledge = useRef<HTMLInputElement | null>(null),
    historyLink = useRef<HTMLAnchorElement | null>(null);
  const returnToTrigger = useRef(false);
  const binding = [
    action,
    workspaceId,
    artifact.id,
    artifact.sha256,
    artifact.agent,
    artifact.scope,
    recordId,
    recordProxy?.mode,
    recordProxy?.policyWorkspaceId,
    recordProxy?.toolApproval,
    toolApproval,
  ].join(':');
  const current = useRef<string | null>(binding);
  current.current = binding;
  useEffect(() => {
    current.current = binding;
    setPreview(null);
    setError(null);
    setBusy(null);
    setAcknowledgements(emptyAcknowledgements());
    setApplyFailed(false);
    return () => {
      active.current?.abort();
      active.current = null;
      current.current = null;
    };
  }, [binding]);
  useEffect(() => {
    onBusyChange?.(busy === 'apply');
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (preview) acknowledge.current?.focus();
    else if (returnToTrigger.current) {
      returnToTrigger.current = false;
      (trigger.current ?? historyLink.current)?.focus();
    }
  }, [preview]);

  const run = async (operation: 'preview' | 'apply') => {
    if (
      disabled ||
      active.current ||
      applyFailed ||
      (operation === 'apply' && (!preview || !mcpContainmentApplyInput(preview, acknowledgements)))
    )
      return;
    if (
      operation === 'apply' &&
      preview &&
      !mcpContainmentPreviewMatches(
        preview,
        action,
        artifact,
        workspaceId,
        recordId,
        recordProxy,
        toolApproval,
      )
    ) {
      returnToTrigger.current = true;
      setPreview(null);
      setAcknowledgements(emptyAcknowledgements());
      setError('The selected registration changed. Prepare a new preview.');
      return;
    }
    if (operation === 'apply' && preview && Date.now() >= Date.parse(preview.expiresAt)) {
      returnToTrigger.current = true;
      setPreview(null);
      setError('This preview expired. Prepare a new preview.');
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 35_000);
    const accepted = () => current.current === binding && active.current === controller;
    setBusy(operation);
    setError(null);
    try {
      if (operation === 'preview') {
        setPreview(null);
        setAcknowledgements(emptyAcknowledgements());
        const input =
          action !== 'restore-registration'
            ? {
                action,
                id: artifact.id,
                expectedSha256: artifact.sha256,
                ...(action === 'protect-registration' && toolApproval
                  ? { toolApproval: true }
                  : {}),
              }
            : { action, recordId };
        const value = await requestLocal('/api/mcp-containment/preview', input, controller.signal);
        if (
          !validateMcpContainmentPreview(value) ||
          !mcpContainmentPreviewMatches(
            value,
            action,
            artifact,
            workspaceId,
            recordId,
            recordProxy,
            toolApproval,
          )
        )
          throw new Error('The preview does not match this registration and workspace.');
        if (accepted()) setPreview(value);
      } else if (preview) {
        const value = await requestLocal(
          '/api/mcp-containment/apply',
          mcpContainmentApplyInput(preview, acknowledgements),
          controller.signal,
        );
        if (!validateMcpContainmentReceipt(value) || !mcpContainmentReceiptMatches(value, preview))
          throw new Error('Completion could not be verified.');
        if (accepted()) {
          setPreview(null);
          setAcknowledgements(emptyAcknowledgements());
          onCompleted(value);
        }
      }
    } catch (failure) {
      if (accepted()) {
        setError(
          (failure instanceof Error && failure.name !== 'AbortError'
            ? failure.message
            : 'The operation timed out.') +
            (operation === 'apply'
              ? ' Configuration may have changed. Recheck registration history before another action.'
              : ''),
        );
        if (operation === 'apply') {
          setApplyFailed(true);
          returnToTrigger.current = true;
          setPreview(null);
          onNeedsRecheck?.();
        }
      }
    } finally {
      clearTimeout(timer);
      if (accepted()) {
        active.current = null;
        setBusy(null);
      }
    }
  };
  const restoring = action === 'restore-registration';
  const protecting = action === 'protect-registration';
  const removingProxy = restoring && recordProxy !== null;
  const title = protecting
    ? toolApproval
      ? 'Protect & review tools'
      : 'Route through Stroq'
    : removingProxy
      ? 'Remove proxy'
      : restoring
        ? 'Restore this registration'
        : 'Remove this registration';
  const Icon = protecting ? Shield : restoring ? RotateCcw : Unplug;
  const proxyWorkspaceId = preview?.proxy?.policyWorkspaceId ?? recordProxy?.policyWorkspaceId;
  const policyWorkspaceLabel =
    localContext && proxyWorkspaceId === localContext.workspace.id
      ? localContext.workspace.label
      : (proxyWorkspaceId ?? 'Selected workspace');
  return (
    <section className="mcp-containment-action" aria-label={title}>
      <h3>{title}</h3>
      <p className="control-meta">
        {protecting
          ? toolApproval
            ? 'Require approval for advertised tool versions through the strict proxy.'
            : 'Route this stdio registration through the strict Stroq proxy.'
          : removingProxy
            ? 'Restore the original command while the installed wrapper still matches.'
            : restoring
              ? 'Restore the retained entry only if its original slot is free.'
              : 'Remove one entry and retain a private recovery copy.'}
      </p>
      {busy && (
        <p className="control-meta" role="status">
          {busy === 'preview'
            ? 'Preparing a read-only preview…'
            : 'Applying this exact configuration change…'}
        </p>
      )}
      {preview ? (
        <>
          <McpContainmentPreviewDetails
            preview={preview}
            acknowledgements={acknowledgements}
            onAcknowledge={(key, value) =>
              setAcknowledgements((before) => ({ ...before, [key]: value }))
            }
            acknowledgeRef={acknowledge}
            disabled={busy === 'apply'}
            policyWorkspaceLabel={policyWorkspaceLabel}
          />
          <div className="mcp-action-buttons">
            <button
              className="button primary"
              disabled={
                disabled || busy !== null || !mcpContainmentApplyInput(preview, acknowledgements)
              }
              onClick={() => void run('apply')}
            >
              {busy === 'apply' ? <LoaderCircle size={16} className="spin" /> : <Icon size={16} />}
              {busy === 'apply' ? 'Applying…' : title}
            </button>
            <button
              className="button"
              disabled={busy !== null}
              onClick={() => {
                returnToTrigger.current = true;
                setPreview(null);
                setAcknowledgements(emptyAcknowledgements());
              }}
            >
              Cancel preview
            </button>
          </div>
        </>
      ) : (
        !applyFailed && (
          <button
            ref={trigger}
            className="button"
            disabled={disabled || busy !== null}
            onClick={() => void run('preview')}
          >
            {busy === 'preview' ? <LoaderCircle size={16} className="spin" /> : <Icon size={16} />}
            {busy === 'preview'
              ? 'Preparing…'
              : protecting
                ? toolApproval
                  ? 'Preview tool review'
                  : 'Preview proxy'
                : removingProxy
                  ? 'Preview proxy removal'
                  : restoring
                    ? 'Preview restore'
                    : 'Preview removal'}
          </button>
        )
      )}
      {error && (
        <p className="control-error" role="alert">
          {error}
        </p>
      )}
      <p className="control-meta">
        <Link
          ref={historyLink}
          className="inline-link"
          href="/skills/mcp/"
          aria-disabled={busy === 'apply'}
          tabIndex={busy === 'apply' ? -1 : undefined}
          onClick={(event) => {
            if (busy === 'apply') event.preventDefault();
          }}
        >
          {applyFailed ? 'Recheck registration history' : 'Registration history & recovery'}
        </Link>
      </p>
    </section>
  );
}
