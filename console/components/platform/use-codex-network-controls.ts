'use client';
import { useEffect, useRef } from 'react';
import { useCodexNetworkSession } from './use-codex-network-session';
import { useCodexNetworkGuard } from './use-codex-network-guard';
import { useCodexNetworkChecks } from './use-codex-network-checks';
/** Passive history reads share one slot; capture and every mutation remain explicit. */
export function useCodexNetworkControls(open: boolean) {
  const session = useCodexNetworkSession(open),
    guard = useCodexNetworkGuard(session),
    checks = useCodexNetworkChecks(session, guard);
  const actions = useRef({ guard, checks });
  actions.current = { guard, checks };
  useEffect(() => {
    if (session.key)
      void (async () => {
        await actions.current.guard.refresh();
        if (session.isCurrent()) await actions.current.checks.refresh();
      })();
  }, [session.key]);
  const refreshHistory = async () => {
    await guard.refresh();
    if (session.isCurrent()) await checks.refresh(true);
  };
  return {
    guard,
    checks,
    workspaceId: session.workspaceId,
    busy: session.busy,
    error: session.error,
    connected: session.key !== null,
    refreshHistory,
    close: () => {
      guard.clearPreview();
      checks.clearPreview();
      session.cancel();
    },
  };
}
export type CodexNetworkControls = ReturnType<typeof useCodexNetworkControls>;
