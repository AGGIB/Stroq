'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import {
  validateCredentialFilterPreview,
  validateCredentialFilterReceipt,
  type CredentialFilterAction,
  type CredentialFilterPreview,
  type CredentialFilterReceipt,
  type CredentialFilterRow,
} from '@/lib/credential-filters';
import {
  credentialFilterApplyInput,
  credentialFilterPreviewMatches,
  credentialFilterReceiptMatches,
  emptyCredentialFilterAcknowledgements,
  type CredentialFilterAcknowledgements,
} from '@/lib/credential-filter-binding';

export function useCredentialFilterAction({
  open,
  contextKey,
  workspaceId,
  row,
  onCompleted,
  onUnverified,
}: {
  open: boolean;
  contextKey: string | null;
  workspaceId: string | null;
  row: CredentialFilterRow | null;
  onCompleted: (receipt: CredentialFilterReceipt) => void;
  onUnverified: (selection: { workspaceId: string; target: CredentialFilterRow['id'] }) => void;
}) {
  const { requestLocal } = usePlatform();
  const key = open && contextKey && row ? `${contextKey}:${row.location}:${row.context}` : null;
  const current = useRef(key);
  current.current = key;
  const active = useRef<AbortController | null>(null);
  const pendingApply = useRef<{ workspaceId: string; target: CredentialFilterRow['id'] } | null>(
    null,
  );
  const reportUnverified = useRef(onUnverified);
  reportUnverified.current = onUnverified;
  const [captured, setCaptured] = useState<{ key: string; value: CredentialFilterPreview } | null>(
    null,
  );
  const [progress, setProgress] = useState<{ key: string; operation: 'preview' | 'apply' } | null>(
    null,
  );
  const [failure, setFailure] = useState<{ key: string; message: string; recheck: boolean } | null>(
    null,
  );
  const [consent, setConsent] = useState<{
    previewId: string;
    values: CredentialFilterAcknowledgements;
  } | null>(null);
  const preview = key && captured?.key === key ? captured.value : null;
  const busy = key && progress?.key === key ? progress.operation : null;
  const error = key && failure?.key === key ? failure : null;
  const acknowledged =
    preview && consent?.previewId === preview.id
      ? consent.values
      : emptyCredentialFilterAcknowledgements();
  useEffect(() => {
    setCaptured(null);
    setProgress(null);
    setFailure(null);
    setConsent(null);
    return () => {
      if (pendingApply.current) reportUnverified.current(pendingApply.current);
      pendingApply.current = null;
      active.current?.abort();
      active.current = null;
    };
  }, [key, requestLocal]);
  const dismissPreview = () => {
    if (active.current) return;
    setCaptured(null);
    setConsent(null);
  };
  const acknowledge = (flag: keyof CredentialFilterAcknowledgements, value: boolean) => {
    if (!preview || busy === 'apply') return;
    setConsent({ previewId: preview.id, values: { ...acknowledged, [flag]: value } });
  };
  async function run(action: CredentialFilterAction, apply: boolean) {
    if (!key || !row || !workspaceId || active.current || error?.recheck) return;
    const selected = {
      workspaceId,
      target: row.id,
      action,
      location: row.location,
      context: row.context,
    };
    const input = apply && preview ? credentialFilterApplyInput(preview, acknowledged) : null;
    if (apply && (!preview || !input || !credentialFilterPreviewMatches(preview, selected))) return;
    if (apply && preview && Date.now() >= Date.parse(preview.expiresAt)) {
      setCaptured(null);
      setConsent(null);
      setFailure({
        key,
        message: 'This preview expired. Prepare a fresh preview.',
        recheck: false,
      });
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    if (apply) pendingApply.current = { workspaceId, target: row.id };
    const timer = setTimeout(() => controller.abort(), 35_000);
    const accepts = () => current.current === key && active.current === controller;
    setProgress({ key, operation: apply ? 'apply' : 'preview' });
    setFailure(null);
    if (!apply) {
      setCaptured(null);
      setConsent(null);
    }
    try {
      const value = await requestLocal(
        apply ? '/api/credential-filters/apply' : '/api/credential-filters/preview',
        apply ? input : { action, target: row.id },
        controller.signal,
      );
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (apply && preview) {
        if (
          !validateCredentialFilterReceipt(value) ||
          !credentialFilterReceiptMatches(value, preview)
        )
          throw new Error('Completion could not be bound to this preview.');
        if (accepts()) {
          pendingApply.current = null;
          setCaptured(null);
          setConsent(null);
          onCompleted(value);
        }
      } else {
        if (
          !validateCredentialFilterPreview(value) ||
          !credentialFilterPreviewMatches(value, selected) ||
          Date.now() >= Date.parse(value.expiresAt)
        )
          throw new Error('The preview does not match this selection or has expired.');
        if (accepts() && !controller.signal.aborted) setCaptured({ key, value });
      }
    } catch (cause) {
      if (accepts()) {
        if (apply && pendingApply.current) reportUnverified.current(pendingApply.current);
        pendingApply.current = null;
        setCaptured(null);
        setConsent(null);
        setFailure({
          key,
          recheck: apply,
          message: apply
            ? 'Completion is unknown. Configuration may have changed. Recheck before another action.'
            : cause instanceof Error && cause.name !== 'AbortError'
              ? cause.message
              : 'Preview timed out. No apply request was sent.',
        });
      }
    } finally {
      clearTimeout(timer);
      if (accepts()) {
        active.current = null;
        setProgress(null);
      }
    }
  }
  return {
    preview,
    busy,
    error: error?.message ?? null,
    needsRecheck: error?.recheck ?? false,
    acknowledged,
    acknowledge,
    dismissPreview,
    prepare: (action: CredentialFilterAction) => run(action, false),
    apply: () => (preview ? run(preview.action, true) : Promise.resolve()),
  };
}
