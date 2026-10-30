'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AGENTS, KEYS, TODAY, type Agent, type ToolCall, type KeyFinding } from '@/lib/data';
import { DEMO_CALLS } from '@/lib/platform';
import { validateSnapshot } from '@/lib/snapshot';
import { validateLocalContext, type LocalContext } from '@/lib/local-context';
import { isLocalOperation } from '@/lib/local-operations';
import { TASK_ACCESS_ERROR_MESSAGES } from '@/lib/task-access';
import { WORKSPACE_REVIEW_ERROR_MESSAGES } from '@/lib/workspace-review-errors';
import { WORKSPACE_MONITOR_ERROR_MESSAGES } from '@/lib/workspace-monitor-errors';
import { WORKSPACE_TASK_ERROR_MESSAGES } from '@/lib/workspace-task-controls';
import { SESSION_TAINT_ERROR_MESSAGES } from '@/lib/session-taint';
import { INCIDENT_ASSESSMENT_ERROR_MESSAGES } from '@/lib/incident-assessments';
import { createSessionTaintRefusal } from '@/lib/session-taint-error';
import { POLICY_HISTORY_ERROR_MESSAGES } from '@/lib/policy-history-errors';
import { TRY_ERROR_MESSAGES } from '@/lib/try-action';
import { JOURNAL_ERROR_MESSAGES } from '@/lib/journal-view';
import { POSTURE_ERROR_MESSAGES } from '@/lib/posture';
import { TASK_LOCK_PAGE_ERROR_MESSAGES } from '@/lib/task-lock-page';
import { MCP_TOOL_CONTRACT_ERROR_MESSAGES } from '@/lib/mcp-tool-contracts';
import { MCP_CALL_CONTROL_ERROR_MESSAGES } from '@/lib/mcp-call-controls';
import { CODEX_SKILL_CONTROL_ERROR_MESSAGES } from '@/lib/codex-skill-controls-client';
import {
  CODEX_NETWORK_ERROR_MESSAGES,
  createCodexNetworkCheckStartRefusal,
} from '@/lib/codex-network-client';
import { CODEX_PATH_GUARD_MESSAGES } from '@/lib/codex-path-guard-client';
import { MCP_GOVERNANCE_ERROR_MESSAGES } from '@/lib/mcp-governance-client';

interface Snapshot {
  source: 'demo' | 'local';
  generatedAt: string;
  calls: readonly ToolCall[];
  agents: readonly Agent[];
  keys: readonly KeyFinding[];
  limitations: readonly string[];
}
interface Platform extends Snapshot {
  loading: boolean;
  error: string | null;
  connectLocal: () => Promise<void>;
  useDemo: () => void;
  refresh: () => Promise<void>;
  localAccess: boolean;
  localContext: LocalContext | null;
  requestLocal: (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
}
const DEMO: Snapshot = {
  source: 'demo',
  generatedAt: `${TODAY}T14:30:00Z`,
  calls: DEMO_CALLS,
  agents: AGENTS,
  keys: KEYS,
  limitations: [
    'Example workspace with synthetic events. These are not results from your machine.',
  ],
};
const Context = createContext<Platform | null>(null);

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(DEMO);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localAccess, setLocalAccess] = useState(false);
  const [localContext, setLocalContext] = useState<LocalContext | null>(null);
  const token = useRef('');
  const active = useRef<AbortController | null>(null);
  const requestLocal = useCallback(
    async (path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> => {
      if (!isLocalOperation(path)) throw new Error('Unsupported local operation.');
      if (!token.current)
        throw new Error('Open the private link printed by the local server to connect.');
      const res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token.current}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal,
      });
      if (!res.ok) {
        const report: unknown = await res.json().catch(() => null);
        const code =
          report &&
          typeof report === 'object' &&
          'error' in report &&
          typeof report.error === 'string'
            ? report.error
            : '';
        const errors: Record<string, string> = {
          'operation-unavailable':
            'Complete current evidence is unavailable. No result was accepted.',
          'task-unavailable': 'This exact task permission is no longer available. Recheck tasks.',
          'task-page-stale': 'The task catalog changed. Refresh the first page before continuing.',
          'task-page-expired': 'This page link expired. Refresh the first page to continue.',
          'task-lookup-limit':
            "The task catalog limit was reached. The requested permission's absence is not established.",
          'task-lock-busy': 'Another task permission change is running. Wait, then recheck.',
          'task-lock-failed':
            'Task permission state could not be verified. Recheck before another change.',
          'write-unconfirmed':
            'The write may have completed. Recheck current state before preparing another change.',
          'unsafe-source': 'A source or its file identity could not be verified. Recheck first.',
          'context-unavailable': 'The selected workspace could not be verified. Reconnect locally.',
          'invalid-report': 'The local report could not be verified. No result was accepted.',
          'runtime-unavailable': 'The local runtime could not be verified. Rebuild and reconnect.',
          'mcp-containment-busy':
            'Another MCP configuration operation is running. Wait, then recheck.',
          'mcp-containment-conflict':
            'The registration, configuration or recovery files changed. Recheck before preparing another action.',
          'mcp-containment-unsupported':
            'This source, transport, entry or JSON format is outside the supported action. Existing wrappers and control environment settings require separate review.',
          'mcp-containment-full':
            'The private recovery store is full. Existing recovery files were preserved.',
          'mcp-containment-preview-missing':
            'This preview was used or is no longer available. Recheck and prepare a new preview.',
          'mcp-containment-preview-expired': 'This preview expired. Prepare a new preview.',
          'mcp-containment-preview-stale':
            'Configuration, source identity or runtime changed after this preview. Prepare a new preview.',
          'mcp-containment-recovery-required':
            'The configuration operation needs recovery. Inspect MCP recovery before retrying.',
          'mcp-containment-unavailable':
            'MCP configuration evidence could not be verified. Recheck the registration and recovery history.',
          'quarantine-busy': 'Another quarantine operation is running. Wait, then recheck.',
          'quarantine-conflict':
            'The captured version or original location changed. Recheck before preparing another action.',
          'quarantine-unsupported':
            'This folder is outside the supported complete skill capture. No preview is available.',
          'quarantine-full': 'The retained-file limit is reached. Existing backups were preserved.',
          'quarantine-preview-missing':
            'This preview was used or is no longer available. Recheck before preparing another.',
          'quarantine-preview-expired': 'This preview expired. Prepare it again.',
          'quarantine-preview-stale':
            'Files or runtime changed after this preview. Recheck and prepare it again.',
          'quarantine-recovery-required':
            'The operation needs recovery. Retained files were preserved; inspect quarantine history.',
          'quarantine-unavailable':
            'Quarantine state could not be read safely. No verified result is available.',
          'scan-busy': 'A credential scan is already running. Wait for it to finish or cancel it.',
          'scan-failed': 'The credential comparison could not complete. No report was accepted.',
          'unsupported-evidence':
            'This record does not contain supported policy-comparison inputs.',
          'stale-evidence':
            'The journal evidence changed or left the captured window. Refresh before reviewing it.',
          'review-unavailable': 'The review store could not be read or updated safely.',
          'live-check-busy':
            'A live check is already running. Reopen the test dialog to inspect it.',
          'subscription-ack-required':
            'Confirm the request budget and subscription usage before starting.',
          'agent-status-unavailable': 'Current agent configuration could not be read safely.',
          'server-stopped': 'The local server is stopping. Reconnect after it restarts.',
          'custom-home-unsupported':
            'Hook setup requires the default Stroq data directory for this user.',
          'platform-unsupported': 'Hook setup is not supported on this operating system.',
          'runtime-path-unsupported':
            'The runtime path cannot be represented safely in hook configuration.',
          'unsafe-config':
            'The target configuration is linked, shared or otherwise unsafe to update.',
          'invalid-config':
            'The agent configuration could not be parsed safely. It was left unchanged.',
          'hooks-disabled':
            'Hooks are disabled in the existing agent configuration. Review that setting first.',
          'invalid-install-record': 'The existing installation record could not be verified.',
          'preview-stale':
            'Configuration or engine files changed since the preview. Prepare it again.',
          'preview-missing': 'This installation preview is no longer available. Prepare it again.',
          'setup-busy': 'Another installation operation is in progress.',
          'agent-configuration-busy':
            'Another hook or file-filter change is running. Recheck before trying again.',
          'agent-configuration-unavailable': 'The shared configuration lock could not be verified.',
          'agent-disconnect-busy': 'Another hook removal is running. Wait, then recheck.',
          'agent-disconnect-preview-missing':
            'This removal preview is no longer available. Recheck settings.',
          'agent-disconnect-preview-expired': 'This removal preview expired. Prepare it again.',
          'agent-disconnect-preview-stale':
            'Settings, directories or runtime changed. Recheck before removal.',
          'agent-disconnect-no-changes': 'No exact hooks for this Stroq runtime were selected.',
          'agent-disconnect-unsafe-config':
            'These settings cannot be updated safely. Recheck their location and permissions.',
          'agent-disconnect-invalid-config':
            'The hook settings could not be parsed safely. Recheck the current file.',
          'agent-disconnect-config-too-large': 'These settings exceed the bounded removal limit.',
          'agent-disconnect-backup-full':
            'The hook recovery limit is reached. Existing copies were preserved.',
          'agent-disconnect-backup-unavailable':
            'The private recovery copy could not be verified. Recheck before retrying.',
          'agent-disconnect-write-failed':
            'No verified removal receipt was received. Recheck settings before another change.',
          'agent-disconnect-engine-unavailable':
            'The hook removal engine is unavailable. Reconnect after the local build completes.',
          'agent-disconnect-server-stopped':
            'The local server stopped. Reconnect and recheck current settings.',
          'engine-timeout': 'The engine preview timed out. No installation was applied.',
          'engine-preview-failed': 'The engine could not prepare this installation.',
          'rollback-incomplete':
            'A concurrent edit prevented automatic recovery. Preserve the backup and inspect configuration before retrying.',
          busy: 'Another local operation is running. Wait for it to finish.',
          'inspect-conflict':
            'This artifact changed or cannot be captured safely. Refresh the inventory before opening the current version.',
          'review-conflict': 'This item changed since inspection. Refresh before reviewing it.',
          'review-incomplete': 'Inspection is incomplete. This version cannot be marked reviewed.',
          'baseline-invalid': 'The reviewed baseline could not be read. It was left unchanged.',
          'inventory-unavailable':
            'Inventory could not be read. Check the local engine and refresh.',
          'deadline-exceeded':
            'This operation reached its time limit. Refresh to check its status.',
          'policy-unavailable': 'The policy file could not be read.',
          'policy-invalid': 'The current policy is invalid. Inspect it before applying changes.',
          'weakening-not-allowed': 'This change would reduce an existing protection.',
          'no-changes': 'No policy changes were selected.',
          'stale-policy': 'The policy changed after this preview. Load it again before applying.',
          'preview-expired': 'This preview expired. Prepare a fresh preview.',
          'preview-mismatch':
            'The preview no longer matches this request. Prepare a fresh preview.',
          'checks-failed': 'The candidate did not pass the required checks.',
          'interruption-ack-required':
            'Review and acknowledge the new interruptions before applying.',
          'action-scope-ack-required':
            'Confirm that these action rules apply to every agent using this Stroq data directory.',
          'policy-cases-stale': 'The saved checks changed. Recheck and prepare a new preview.',
          'policy-cases-unavailable':
            'Saved policy checks could not be read safely. No empty or passing result is available.',
          'policy-cases-invalid':
            'The saved-check store could not be verified. Its contents were preserved.',
          'policy-cases-busy':
            'Another policy or saved-check change is running. Wait, then recheck.',
          'policy-cases-full': 'The saved-check limit is reached. Existing checks were preserved.',
          'policy-case-conflict':
            'These action categories already have different expected decisions. Review the existing check.',
          'policy-case-missing': 'The selected saved check is no longer present. Recheck the list.',
          'backup-unavailable': 'A backup could not be created. No change was applied.',
          'write-failed':
            'The configuration could not be written. Recheck its state before retrying.',
        };
        const accessErrors: Readonly<Record<string, string>> = TASK_ACCESS_ERROR_MESSAGES;
        const workspaceErrors: Readonly<Record<string, string>> = WORKSPACE_REVIEW_ERROR_MESSAGES;
        const workspaceTaskErrors: Readonly<Record<string, string>> = WORKSPACE_TASK_ERROR_MESSAGES;
        const policyHistoryErrors: Readonly<Record<string, string>> = POLICY_HISTORY_ERROR_MESSAGES;
        if (
          path.startsWith('/api/session-taint/') &&
          report !== null &&
          typeof report === 'object' &&
          !Array.isArray(report) &&
          Object.keys(report).length === 1 &&
          Object.hasOwn(report, 'error')
        ) {
          const refusal = createSessionTaintRefusal(code, res.status);
          if (refusal) throw refusal;
        }
        if (
          path === '/api/codex-network-checks/start' &&
          res.status === 409 &&
          report !== null &&
          typeof report === 'object' &&
          !Array.isArray(report) &&
          Object.keys(report).length === 1 &&
          Object.hasOwn(report, 'error')
        ) {
          const refusal = createCodexNetworkCheckStartRefusal(code, res.status);
          if (refusal) throw refusal;
        }
        throw new Error(
          (path === '/api/policy/try' ? TRY_ERROR_MESSAGES[code] : undefined) ??
            (path.startsWith('/api/journal/') ? JOURNAL_ERROR_MESSAGES[code] : undefined) ??
            (path === '/api/posture' ? POSTURE_ERROR_MESSAGES[code] : undefined) ??
            (path === '/api/incident-assessments' || path.startsWith('/api/incident-assessments/')
              ? INCIDENT_ASSESSMENT_ERROR_MESSAGES[
                  code as keyof typeof INCIDENT_ASSESSMENT_ERROR_MESSAGES
                ]
              : undefined) ??
            (path === '/api/session-taint' || path.startsWith('/api/session-taint/')
              ? SESSION_TAINT_ERROR_MESSAGES[code as keyof typeof SESSION_TAINT_ERROR_MESSAGES]
              : undefined) ??
            (path.startsWith('/api/task-locks/access/') ? accessErrors[code] : undefined) ??
            (path.startsWith('/api/mcp-tool-contracts')
              ? MCP_TOOL_CONTRACT_ERROR_MESSAGES[code]
              : undefined) ??
            (path === '/api/mcp-call-controls' || path.startsWith('/api/mcp-call-controls/')
              ? MCP_CALL_CONTROL_ERROR_MESSAGES[code]
              : undefined) ??
            (path === '/api/mcp-governance' || path.startsWith('/api/mcp-governance/')
              ? MCP_GOVERNANCE_ERROR_MESSAGES[code as keyof typeof MCP_GOVERNANCE_ERROR_MESSAGES]
              : undefined) ??
            (path === '/api/inventory/codex-controls' ||
            /^\/api\/inventory\/codex-control-(?:preview|apply|recheck)$/.test(path)
              ? CODEX_SKILL_CONTROL_ERROR_MESSAGES[
                  code as keyof typeof CODEX_SKILL_CONTROL_ERROR_MESSAGES
                ]
              : undefined) ??
            (/^\/api\/codex-network-(?:guard|checks)(?:\/|$)/.test(path)
              ? CODEX_NETWORK_ERROR_MESSAGES[code]
              : undefined) ??
            (/^\/api\/codex-path-guard(?:\/|$)/.test(path)
              ? CODEX_PATH_GUARD_MESSAGES[code as keyof typeof CODEX_PATH_GUARD_MESSAGES]
              : undefined) ??
            (path === '/api/task-locks/page' ? TASK_LOCK_PAGE_ERROR_MESSAGES[code] : undefined) ??
            (path === '/api/policy/history' || path.startsWith('/api/policy/restore/')
              ? policyHistoryErrors[code]
              : undefined) ??
            (path === '/api/workspace-review' || path.startsWith('/api/workspace-review/')
              ? workspaceErrors[code]
              : undefined) ??
            (path === '/api/workspace-task-controls' ||
            path.startsWith('/api/workspace-task-controls/')
              ? workspaceTaskErrors[code]
              : undefined) ??
            (path === '/api/workspace-monitor' || path.startsWith('/api/workspace-monitor/')
              ? WORKSPACE_MONITOR_ERROR_MESSAGES[code]
              : undefined) ??
            errors[code] ??
            (res.status === 401
              ? 'Your local connection expired. Open the private server link again.'
              : res.status === 409
                ? 'Another check is running. Wait for its result.'
                : res.status === 503
                  ? 'The local engine is unavailable. Build Stroq and restart the server.'
                  : res.status === 400 || res.status === 413
                    ? 'The request was rejected. Check the input and its size.'
                    : 'The local server could not complete this request. Refresh to check its status.'),
        );
      }
      const data: unknown = await res.json();
      return data;
    },
    [],
  );
  const connectLocal = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/snapshot', {
        headers: { Authorization: `Bearer ${token.current}` },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok)
        throw new Error(
          res.status === 401
            ? 'Open the private link printed by the local server to authenticate this browser.'
            : 'Start the local server and open its private link to read your Stroq journal.',
        );
      const data: unknown = await res.json();
      if (!validateSnapshot(data))
        throw new Error('The local server returned an unsupported snapshot. No data was loaded.');
      if (active.current !== controller) return;
      setSnapshot(data);
      try {
        sessionStorage.setItem('stroq-console-source', 'local');
      } catch {
        /* Browsing remains available without storage. */
      }
    } catch (e) {
      if (active.current === controller)
        setError(
          e instanceof Error && e.name !== 'AbortError'
            ? e.message
            : 'Connection timed out. Check that the local server is running.',
        );
    } finally {
      clearTimeout(timeout);
      if (active.current === controller) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!localAccess) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    void requestLocal('/api/context', undefined, controller.signal)
      .then((value) => {
        if (active && validateLocalContext(value)) setLocalContext(value);
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [localAccess, requestLocal]);
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const incoming = hash.get('token');
    let preferredSource: string | null = null;
    try {
      token.current = incoming ?? sessionStorage.getItem('stroq-console-token') ?? '';
      preferredSource = sessionStorage.getItem('stroq-console-source');
      if (incoming) sessionStorage.setItem('stroq-console-token', incoming);
    } catch {
      token.current = incoming ?? '';
    }
    if (incoming) history.replaceState(null, '', location.pathname + location.search);
    setLocalAccess(Boolean(token.current));
    if (token.current && (incoming || preferredSource !== 'demo')) void connectLocal();
    return () => active.current?.abort();
  }, [connectLocal]);
  const useDemo = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setSnapshot(DEMO);
    try {
      sessionStorage.setItem('stroq-console-source', 'demo');
    } catch {
      /* Optional browser preference. */
    }
    setError(null);
    setLoading(false);
  }, []);
  return (
    <Context.Provider
      value={{
        ...snapshot,
        loading,
        error,
        connectLocal,
        useDemo,
        refresh: connectLocal,
        localAccess,
        localContext,
        requestLocal,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function usePlatform() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('PlatformProvider is required');
  return ctx;
}
