'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/components/platform-provider';
import { validateInventory, type InventoryState } from '@/lib/inventory';
import { validateIncidents, type IncidentsState } from '@/lib/incidents';
import { validateAgentStatus, type AgentStatusState } from '@/lib/agent-status';
import { validateSkillQuarantine, type SkillQuarantineState } from '@/lib/skill-quarantine';
import { validateLiveState, type LiveState } from '@/lib/live-proof';
import { validateSecretScanState, type SecretScanState } from '@/lib/secret-scan';
import { validateMcpContainment, type McpContainmentState } from '@/lib/mcp-containment';
import {
  validateMcpCallControlOverview,
  type McpCallControlOverview,
} from '@/lib/mcp-call-control-overview';
import { validateCredentialFilters, type CredentialFiltersState } from '@/lib/credential-filters';
import { validatePolicyCases, type PolicyCasesState } from '@/lib/policy-cases';
import { validateTaskLockState, type TaskLockState } from '@/lib/task-locks';
import { validateWorkspaceReviewState, type WorkspaceReviewState } from '@/lib/workspace-review';
import { validateHookCheckState, type HookCheckState } from '@/lib/hook-checks';
import { validateWorkspaceMonitorState, type WorkspaceMonitorState } from '@/lib/workspace-monitor';
import { validateWorkspaceTaskState, type WorkspaceTaskState } from '@/lib/workspace-task-controls';
import {
  validateIncidentAssessmentState,
  type IncidentAssessmentState,
} from '@/lib/incident-assessments';
import { incidentAssessmentPendingWrites } from '@/lib/incident-assessment-client-state';
import { callControlPending } from '@/lib/mcp-call-control-binding';
import {
  validateCodexSkillControlState,
  type CodexSkillControlState,
} from '@/lib/codex-skill-controls';
import {
  codexSkillControlPendingWrites,
  subscribeCodexSkillControlPending,
} from '@/lib/codex-skill-controls-client';
import type { InventoryFreshness } from '@/lib/inventory-attention-queue';
import {
  validateCodexNetworkGuardState,
  type CodexNetworkGuardState,
} from '@/lib/codex-network-guard';
import {
  validateCodexNetworkCheckState,
  type CodexNetworkCheckState,
} from '@/lib/codex-network-check';
import {
  codexNetworkGuardPending,
  codexNetworkCheckPending,
  subscribeCodexNetworkPending,
} from '@/lib/codex-network-client';
import { validateCodexPathGuardState, type CodexPathGuardState } from '@/lib/codex-path-guard';
import {
  codexPathGuardPending,
  subscribeCodexPathGuardPending,
} from '@/lib/codex-path-guard-client';
import { validateMcpGovernanceState, type McpGovernanceState } from '@/lib/mcp-governance';
import { mcpGovernancePending, subscribeMcpGovernancePending } from '@/lib/mcp-governance-client';
import {
  mergeMcpGovernanceUnknowns,
  type McpGovernanceUnknownLedger,
} from '@/lib/mcp-governance-attention';

interface QueueSnapshot {
  key: string;
  workspaceId: string;
  inventory: InventoryState | null;
  inventoryCurrent: boolean;
  incidents: IncidentsState | null;
  assessments: IncidentAssessmentState | null;
  agents: AgentStatusState | null;
  quarantine: SkillQuarantineState | null;
  live: LiveState | null;
  secrets: SecretScanState | null;
  mcp: McpContainmentState | null;
  mcpCallControls: McpCallControlOverview | null;
  mcpGovernance: McpGovernanceState | null;
  mcpGovernanceUnresolved: McpGovernanceUnknownLedger;
  codexSkillControls: CodexSkillControlState | null;
  codexNetworkGuard: CodexNetworkGuardState | null;
  codexNetworkChecks: CodexNetworkCheckState | null;
  codexPathGuard: CodexPathGuardState | null;
  filters: CredentialFiltersState | null;
  policyCases: PolicyCasesState | null;
  taskLocks: TaskLockState | null;
  workspaceReview: WorkspaceReviewState | null;
  workspaceTasks: WorkspaceTaskState | null;
  workspaceMonitor: WorkspaceMonitorState | null;
  hookChecks: HookCheckState | null;
  refreshedAt: string;
  refreshRevision: number;
}
interface QueueProgress {
  key: string;
  workspaceId: string;
  loading: boolean;
  polling: boolean;
  failures: number;
  refreshError: string | null;
  pollError: string | null;
}
const POLL_WARNING =
  'Background check updates could not be refreshed. Earlier reports remain historical.';
const emptySnapshot = (key: string, workspaceId: string): QueueSnapshot => ({
  key,
  workspaceId,
  inventory: null,
  inventoryCurrent: false,
  incidents: null,
  assessments: null,
  agents: null,
  quarantine: null,
  live: null,
  secrets: null,
  mcp: null,
  mcpCallControls: null,
  mcpGovernance: null,
  mcpGovernanceUnresolved: { records: [], limited: false },
  codexSkillControls: null,
  codexNetworkGuard: null,
  codexNetworkChecks: null,
  codexPathGuard: null,
  filters: null,
  policyCases: null,
  taskLocks: null,
  workspaceReview: null,
  workspaceTasks: null,
  workspaceMonitor: null,
  hookChecks: null,
  refreshedAt: new Date().toISOString(),
  refreshRevision: 0,
});

/** Reads follow saved jobs and an explicitly enabled watch; they never start a check. */
export function useProtectionQueue(refreshKey?: string) {
  const { localAccess, localContext, requestLocal } = usePlatform();
  const workspaceId = localAccess ? (localContext?.workspace.id ?? null) : null;
  const identity = useRef({ workspaceId, context: localContext, requestLocal, generation: 0 });
  if (
    identity.current.workspaceId !== workspaceId ||
    identity.current.context !== localContext ||
    identity.current.requestLocal !== requestLocal
  )
    identity.current = {
      workspaceId,
      context: localContext,
      requestLocal,
      generation: identity.current.generation + 1,
    };
  const key = workspaceId ? `${workspaceId}:${identity.current.generation}` : null;
  const currentKey = useRef(key),
    mounted = useRef(false);
  currentKey.current = key;
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  const [, setPendingRevision] = useState(0);
  useEffect(
    () => subscribeCodexSkillControlPending(requestLocal, () => setPendingRevision((n) => n + 1)),
    [requestLocal],
  );
  useEffect(
    () => subscribeCodexNetworkPending(requestLocal, () => setPendingRevision((n) => n + 1)),
    [requestLocal],
  );
  useEffect(
    () => subscribeCodexPathGuardPending(requestLocal, () => setPendingRevision((n) => n + 1)),
    [requestLocal],
  );
  useEffect(
    () => subscribeMcpGovernancePending(requestLocal, () => setPendingRevision((n) => n + 1)),
    [requestLocal],
  );
  const [inventoryFailure, setInventoryFailure] = useState<{ key: string; message: string } | null>(
    null,
  );
  const active = useRef<AbortController | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evidence = key && snapshot?.key === key ? snapshot : null;
  const current = key && progress?.key === key ? progress : null;

  const stopPending = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    active.current?.abort();
    active.current = null;
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current || !key || currentKey.current !== key || !localAccess || !workspaceId)
      return;
    stopPending();
    setInventoryFailure(null);
    const controller = new AbortController();
    active.current = controller;
    // Inventory and quarantine workers have 25-second bounds; allow them to finish.
    const timer = setTimeout(() => {
      if (!mounted.current || currentKey.current !== key || active.current !== controller) return;
      controller.abort();
      active.current = null;
      setProgress({
        key,
        workspaceId,
        loading: false,
        polling: false,
        failures: 0,
        refreshError:
          'Protection evidence could not be refreshed before the deadline. Earlier observations remain historical.',
        pollError: null,
      });
    }, 45_000);
    setProgress({
      key,
      workspaceId,
      loading: true,
      polling: false,
      failures: 0,
      refreshError: null,
      pollError: null,
    });
    setSnapshot((previous) =>
      previous?.key === key
        ? {
            ...previous,
            inventoryCurrent: false,
            agents: null,
            assessments: null,
            quarantine: null,
            live: null,
            secrets: null,
            mcp: null,
            mcpCallControls: null,
            mcpGovernance: null,
            codexSkillControls: null,
            codexNetworkGuard: null,
            codexNetworkChecks: null,
            codexPathGuard: null,
            filters: null,
            policyCases: null,
            taskLocks: null,
            workspaceReview: null,
            workspaceTasks: null,
            workspaceMonitor: null,
            hookChecks: null,
          }
        : null,
    );
    try {
      const results = await Promise.allSettled([
        requestLocal('/api/inventory', undefined, controller.signal),
        requestLocal('/api/incidents', undefined, controller.signal),
        requestLocal('/api/agents', undefined, controller.signal),
        requestLocal('/api/quarantine', undefined, controller.signal),
        requestLocal('/api/live', undefined, controller.signal),
        requestLocal('/api/secrets', undefined, controller.signal),
        requestLocal('/api/mcp-containment', undefined, controller.signal),
        requestLocal('/api/credential-filters', undefined, controller.signal),
        requestLocal('/api/policy/cases', undefined, controller.signal),
        requestLocal('/api/task-locks', undefined, controller.signal),
        requestLocal('/api/workspace-review', undefined, controller.signal),
        requestLocal('/api/hook-checks', undefined, controller.signal),
        requestLocal('/api/workspace-monitor', undefined, controller.signal),
        requestLocal('/api/workspace-task-controls', undefined, controller.signal),
        requestLocal('/api/incident-assessments', undefined, controller.signal),
        requestLocal('/api/mcp-call-controls', undefined, controller.signal),
        requestLocal('/api/mcp-governance', undefined, controller.signal),
      ]);
      if (!mounted.current || currentKey.current !== key || active.current !== controller) return;
      if (controller.signal.aborted) throw new Error('deadline-exceeded');
      // Inventory and Codex history share a bounded worker slot; finish the first read before the second.
      const codexValue = await requestLocal(
        '/api/inventory/codex-controls',
        undefined,
        controller.signal,
      ).catch(() => null);
      if (
        !mounted.current ||
        currentKey.current !== key ||
        active.current !== controller ||
        controller.signal.aborted
      )
        return;
      const codexSkillControls = validateCodexSkillControlState(codexValue) ? codexValue : null;
      const guardValue = await requestLocal(
        '/api/codex-network-guard',
        undefined,
        controller.signal,
      ).catch(() => null);
      if (
        !mounted.current ||
        currentKey.current !== key ||
        active.current !== controller ||
        controller.signal.aborted
      )
        return;
      const codexNetworkGuard = validateCodexNetworkGuardState(guardValue) ? guardValue : null;
      const checkValue = await requestLocal(
        '/api/codex-network-checks',
        undefined,
        controller.signal,
      ).catch(() => null);
      if (
        !mounted.current ||
        currentKey.current !== key ||
        active.current !== controller ||
        controller.signal.aborted
      )
        return;
      const codexNetworkChecks =
        validateCodexNetworkCheckState(checkValue) &&
        checkValue.workspaceId === workspaceId &&
        (!codexNetworkGuard?.controlContextId ||
          checkValue.controlContextId === codexNetworkGuard.controlContextId)
          ? checkValue
          : null;
      const pathValue = await requestLocal(
        '/api/codex-path-guard',
        undefined,
        controller.signal,
      ).catch(() => null);
      if (
        !mounted.current ||
        currentKey.current !== key ||
        active.current !== controller ||
        controller.signal.aborted
      )
        return;
      const codexPathGuard =
        validateCodexPathGuardState(pathValue) &&
        (!codexNetworkGuard?.controlContextId ||
          pathValue.controlContextId === codexNetworkGuard.controlContextId)
          ? pathValue
          : null;
      const [
        inv,
        inc,
        agent,
        retained,
        liveResult,
        secretResult,
        mcpResult,
        filterResult,
        caseResult,
        taskResult,
        workspaceResult,
        hookResult,
        monitorResult,
        taskControlsResult,
        assessmentResult,
        callControlResult,
        governanceResult,
      ] = results;
      const inventory =
        inv.status === 'fulfilled' &&
        validateInventory(inv.value) &&
        inv.value.workspace.id === workspaceId
          ? inv.value
          : null;
      const incidents =
        inc.status === 'fulfilled' && validateIncidents(inc.value) ? inc.value : null;
      const agents =
        agent.status === 'fulfilled' && validateAgentStatus(agent.value) ? agent.value : null;
      const quarantine =
        retained.status === 'fulfilled' &&
        validateSkillQuarantine(retained.value) &&
        retained.value.workspaceId === workspaceId
          ? retained.value
          : null;
      const live =
        liveResult.status === 'fulfilled' && validateLiveState(liveResult.value)
          ? liveResult.value
          : null;
      const secrets =
        secretResult.status === 'fulfilled' && validateSecretScanState(secretResult.value)
          ? secretResult.value
          : null;
      const filters =
        filterResult.status === 'fulfilled' &&
        validateCredentialFilters(filterResult.value) &&
        filterResult.value.workspaceId === workspaceId
          ? filterResult.value
          : null;
      const policyCases =
        caseResult.status === 'fulfilled' &&
        validatePolicyCases(caseResult.value) &&
        caseResult.value.workspaceId === workspaceId
          ? caseResult.value
          : null;
      const workspaceReview =
        workspaceResult?.status === 'fulfilled' &&
        validateWorkspaceReviewState(workspaceResult.value) &&
        workspaceResult.value.workspaceId === workspaceId
          ? workspaceResult.value
          : null;
      const workspaceMonitor =
        monitorResult?.status === 'fulfilled' &&
        validateWorkspaceMonitorState(monitorResult.value) &&
        monitorResult.value.workspaceId === workspaceId
          ? monitorResult.value
          : null;
      const mcpCallControls =
        callControlResult.status === 'fulfilled' &&
        validateMcpCallControlOverview(callControlResult.value) &&
        callControlResult.value.workspaceId === workspaceId
          ? callControlResult.value
          : null;
      const mcpGovernance =
        governanceResult?.status === 'fulfilled' &&
        validateMcpGovernanceState(governanceResult.value) &&
        governanceResult.value.workspaceId === workspaceId
          ? governanceResult.value
          : null;
      const messages = [
        !mcpGovernance && 'MCP governance could not be refreshed.',
        !codexNetworkGuard && 'Codex network settings could not be refreshed.',
        !codexNetworkChecks && 'Codex copied-policy history could not be refreshed.',
        !codexPathGuard && 'Codex credential path history could not be refreshed.',
        !codexSkillControls && 'Codex skill settings could not be refreshed.',
        !mcpCallControls && 'MCP call-control authority could not be refreshed.',
        !(
          assessmentResult.status === 'fulfilled' &&
          validateIncidentAssessmentState(assessmentResult.value)
        ) && 'Operator assessments could not be refreshed.',
        !inventory && 'Inventory could not be refreshed.',
        !incidents && 'Recorded investigations could not be refreshed.',
        !agents && 'Current agent configuration could not be read.',
        !quarantine && 'Quarantine folders could not be rechecked.',
        !live && 'Blocking-check history could not be refreshed.',
        !secrets && 'Credential report history could not be refreshed.',
        !filters && 'File filters could not be rechecked.',
        !policyCases && 'Saved policy checks could not be rechecked.',
        !workspaceReview && 'Workspace check history could not be refreshed.',
        !(
          taskControlsResult.status === 'fulfilled' &&
          validateWorkspaceTaskState(taskControlsResult.value) &&
          taskControlsResult.value.workspaceId === workspaceId
        ) && 'Task change history could not be refreshed.',
        !workspaceMonitor && 'Change watch state could not be refreshed.',
        !(
          hookResult.status === 'fulfilled' &&
          validateHookCheckState(hookResult.value) &&
          hookResult.value.workspaceId === workspaceId
        ) && 'Stroq hook history could not be refreshed.',
        !(
          taskResult.status === 'fulfilled' &&
          validateTaskLockState(taskResult.value) &&
          taskResult.value.workspaceId === workspaceId
        ) && 'Task permissions could not be read.',
        !(
          mcpResult.status === 'fulfilled' &&
          validateMcpContainment(mcpResult.value) &&
          mcpResult.value.workspaceId === workspaceId
        ) && 'MCP recovery could not be rechecked.',
      ].filter(Boolean);
      setSnapshot((previous) => ({
        key,
        workspaceId,
        inventory: inventory ?? (previous?.key === key ? previous.inventory : null),
        inventoryCurrent: inventory !== null,
        incidents: incidents ?? (previous?.key === key ? previous.incidents : null),
        assessments:
          assessmentResult.status === 'fulfilled' &&
          validateIncidentAssessmentState(assessmentResult.value)
            ? assessmentResult.value
            : null,
        agents,
        mcpCallControls,
        mcpGovernance,
        mcpGovernanceUnresolved: mergeMcpGovernanceUnknowns(
          previous?.key === key
            ? previous.mcpGovernanceUnresolved
            : { records: [], limited: false },
          mcpGovernance,
          workspaceId,
        ),
        codexSkillControls,
        codexNetworkGuard,
        codexNetworkChecks,
        codexPathGuard,
        quarantine,
        live,
        secrets,
        mcp:
          mcpResult.status === 'fulfilled' &&
          validateMcpContainment(mcpResult.value) &&
          mcpResult.value.workspaceId === workspaceId
            ? mcpResult.value
            : null,
        filters,
        policyCases,
        taskLocks:
          taskResult.status === 'fulfilled' &&
          validateTaskLockState(taskResult.value) &&
          taskResult.value.workspaceId === workspaceId
            ? taskResult.value
            : null,
        workspaceReview,
        workspaceTasks:
          taskControlsResult.status === 'fulfilled' &&
          validateWorkspaceTaskState(taskControlsResult.value) &&
          taskControlsResult.value.workspaceId === workspaceId
            ? taskControlsResult.value
            : null,
        workspaceMonitor,
        hookChecks:
          hookResult.status === 'fulfilled' &&
          validateHookCheckState(hookResult.value) &&
          hookResult.value.workspaceId === workspaceId
            ? hookResult.value
            : null,
        // Polling job sources must not imply that every source was refreshed.
        refreshedAt: new Date().toISOString(),
        refreshRevision: (previous?.key === key ? previous.refreshRevision : 0) + 1,
      }));
      setProgress({
        key,
        workspaceId,
        loading: false,
        polling: false,
        failures: 0,
        refreshError: messages.length ? messages.join(' ') : null,
        pollError: null,
      });
    } catch {
      if (mounted.current && currentKey.current === key && active.current === controller)
        setProgress({
          key,
          workspaceId,
          loading: false,
          polling: false,
          failures: 0,
          refreshError:
            'Protection evidence could not be refreshed. Earlier observations remain historical.',
          pollError: null,
        });
    } finally {
      clearTimeout(timer);
      if (active.current === controller) active.current = null;
    }
  }, [localAccess, workspaceId, requestLocal, stopPending, key]);

  // A watch observes source metadata on the server. Only a newly accepted check
  // asks this view for fresh inventory; saved history never supplies current review.
  const refreshInventory = useCallback(() => {
    if (
      !mounted.current ||
      !key ||
      currentKey.current !== key ||
      !localAccess ||
      !workspaceId ||
      active.current
    )
      return false;
    const controller = new AbortController();
    active.current = controller;
    const accepts = () =>
      mounted.current && currentKey.current === key && active.current === controller;
    const failed = () => {
      setInventoryFailure({
        key,
        message:
          'Inventory could not be refreshed after the recorded source check. Earlier observations remain historical.',
      });
      setProgress((previous) =>
        previous?.key === key ? { ...previous, loading: false } : previous,
      );
    };
    const timer = setTimeout(() => {
      if (!accepts()) return;
      controller.abort();
      active.current = null;
      failed();
    }, 45_000);
    setInventoryFailure(null);
    setSnapshot((previous) =>
      previous?.key === key ? { ...previous, inventoryCurrent: false } : previous,
    );
    setProgress((previous) => (previous?.key === key ? { ...previous, loading: true } : previous));
    void (async () => {
      try {
        const value = await requestLocal('/api/inventory', undefined, controller.signal);
        if (!accepts() || controller.signal.aborted) return;
        if (!validateInventory(value) || value.workspace.id !== workspaceId) throw new Error();
        setSnapshot((previous) => ({
          ...((previous?.key === key ? previous : null) ?? emptySnapshot(key, workspaceId)),
          inventory: value,
          inventoryCurrent: true,
        }));
        setProgress((previous) =>
          previous?.key === key ? { ...previous, loading: false } : previous,
        );
      } catch {
        if (accepts()) failed();
      } finally {
        clearTimeout(timer);
        if (active.current === controller) active.current = null;
      }
    })();
    return true;
  }, [key, localAccess, workspaceId, requestLocal]);

  const poll = useCallback(
    async (jobs: boolean) => {
      if (
        !mounted.current ||
        !key ||
        currentKey.current !== key ||
        !localAccess ||
        !workspaceId ||
        active.current
      )
        return;
      const controller = new AbortController();
      active.current = controller;
      const timer = setTimeout(() => {
        if (!mounted.current || currentKey.current !== key || active.current !== controller) return;
        controller.abort();
        active.current = null;
        setProgress((previous) =>
          previous?.key === key
            ? {
                ...previous,
                polling: false,
                failures: previous.failures + 1,
                pollError: POLL_WARNING,
              }
            : previous,
        );
      }, 15_000);
      setProgress((previous) =>
        previous?.key === key ? { ...previous, polling: true } : previous,
      );
      try {
        const paths = jobs
          ? [
              '/api/workspace-review',
              '/api/workspace-monitor',
              '/api/live',
              '/api/secrets',
              '/api/hook-checks',
              '/api/mcp-governance',
            ]
          : ['/api/workspace-review', '/api/workspace-monitor', '/api/mcp-governance'];
        const results = await Promise.allSettled(
          paths.map((path) => requestLocal(path, undefined, controller.signal)),
        );
        if (!mounted.current || currentKey.current !== key || active.current !== controller) return;
        if (controller.signal.aborted) throw new Error('deadline-exceeded');
        const [workspaceResult, monitorResult, liveResult, secretResult, hookResult] = results;
        const governanceResult = results.at(-1);
        const mcpGovernance =
          governanceResult?.status === 'fulfilled' &&
          validateMcpGovernanceState(governanceResult.value) &&
          governanceResult.value.workspaceId === workspaceId
            ? governanceResult.value
            : null;
        const workspaceReview =
          workspaceResult?.status === 'fulfilled' &&
          validateWorkspaceReviewState(workspaceResult.value) &&
          workspaceResult.value.workspaceId === workspaceId
            ? workspaceResult.value
            : null;
        const workspaceMonitor =
          monitorResult?.status === 'fulfilled' &&
          validateWorkspaceMonitorState(monitorResult.value) &&
          monitorResult.value.workspaceId === workspaceId
            ? monitorResult.value
            : null;
        const live =
          liveResult?.status === 'fulfilled' && validateLiveState(liveResult.value)
            ? liveResult.value
            : null;
        const secrets =
          secretResult?.status === 'fulfilled' && validateSecretScanState(secretResult.value)
            ? secretResult.value
            : null;
        const hookChecks =
          hookResult?.status === 'fulfilled' &&
          validateHookCheckState(hookResult.value) &&
          hookResult.value.workspaceId === workspaceId
            ? hookResult.value
            : null;
        const valid =
          workspaceReview &&
          workspaceMonitor &&
          mcpGovernance &&
          (!jobs || (live && secrets && hookChecks));
        setSnapshot((previous) =>
          previous?.key === key
            ? {
                ...previous,
                workspaceReview: workspaceReview ?? previous.workspaceReview,
                workspaceMonitor: workspaceMonitor ?? previous.workspaceMonitor,
                mcpGovernance,
                mcpGovernanceUnresolved: mergeMcpGovernanceUnknowns(
                  previous.mcpGovernanceUnresolved,
                  mcpGovernance,
                  workspaceId,
                ),
                ...(jobs
                  ? {
                      live: live ?? previous.live,
                      secrets: secrets ?? previous.secrets,
                      hookChecks: hookChecks ?? previous.hookChecks,
                    }
                  : {}),
              }
            : previous,
        );
        setProgress((previous) =>
          previous?.key === key
            ? {
                ...previous,
                polling: false,
                failures: valid ? 0 : previous.failures + 1,
                pollError: valid ? null : POLL_WARNING,
              }
            : previous,
        );
      } catch {
        if (mounted.current && currentKey.current === key && active.current === controller)
          setProgress((previous) =>
            previous?.key === key
              ? {
                  ...previous,
                  polling: false,
                  failures: previous.failures + 1,
                  pollError: POLL_WARNING,
                }
              : previous,
          );
      } finally {
        clearTimeout(timer);
        if (active.current === controller) active.current = null;
      }
    },
    [localAccess, workspaceId, requestLocal, key],
  );

  useEffect(() => {
    mounted.current = true;
    if (!localAccess || !workspaceId) {
      setSnapshot(null);
      setProgress(null);
    } else void refresh();
    return () => {
      mounted.current = false;
      stopPending();
    };
  }, [refresh, localAccess, workspaceId, refreshKey, stopPending]);

  const watching = evidence?.workspaceMonitor?.status === 'enabled';
  const running =
    evidence?.live?.jobs.some((job) => job.status === 'running') ||
    evidence?.secrets?.jobs.some((job) => job.status === 'running') ||
    evidence?.workspaceReview?.runs.some((run) => run.status === 'running') ||
    evidence?.hookChecks?.jobs.some((job) => job.status === 'running');
  useEffect(() => {
    if (
      !localAccess ||
      !workspaceId ||
      (!running && !watching) ||
      current?.loading ||
      current?.polling ||
      (current?.failures ?? 0) >= 3
    )
      return;
    pollTimer.current = setTimeout(
      () => {
        pollTimer.current = null;
        void poll(Boolean(running));
      },
      running ? 1500 * ((current?.failures ?? 0) + 1) : 10_000,
    );
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
  }, [
    localAccess,
    workspaceId,
    running,
    watching,
    current?.loading,
    current?.polling,
    current?.failures,
    evidence?.refreshRevision,
    poll,
  ]);

  const messages = [
    current?.refreshError,
    current?.pollError,
    inventoryFailure?.key === key ? inventoryFailure.message : null,
  ].filter(Boolean);
  if ((current?.failures ?? 0) >= 3)
    messages.push('Automatic updates paused. Use refresh to reconnect.');
  return {
    inventory: evidence?.inventory ?? null,
    inventoryFreshness: (!evidence?.inventory
      ? 'unavailable'
      : evidence.inventoryCurrent
        ? 'current'
        : 'historical') as InventoryFreshness,
    incidents: evidence?.incidents ?? null,
    assessments: evidence?.assessments ?? null,
    unconfirmedAssessments: new Set(
      [...incidentAssessmentPendingWrites(requestLocal).values()].map(
        (write) => write.preview.incident.id,
      ),
    ),
    agents: evidence?.agents ?? null,
    quarantine: evidence?.quarantine ?? null,
    live: evidence?.live ?? null,
    secrets: evidence?.secrets ?? null,
    mcp: evidence?.mcp ?? null,
    mcpCallControls: evidence?.mcpCallControls ?? null,
    mcpGovernance: evidence?.mcpGovernance ?? null,
    mcpGovernanceUnresolved: evidence?.mcpGovernanceUnresolved ?? { records: [], limited: false },
    unconfirmedMcpGovernance: [...mcpGovernancePending(requestLocal).values()].filter(
      (write) => write.preview.binding.workspaceId === workspaceId,
    ),
    codexSkillControls: evidence?.codexSkillControls ?? null,
    codexNetworkGuard: evidence?.codexNetworkGuard ?? null,
    codexNetworkChecks: evidence?.codexNetworkChecks ?? null,
    codexPathGuard: evidence?.codexPathGuard ?? null,
    unconfirmedCodexPaths: [...codexPathGuardPending(requestLocal).values()],
    unconfirmedNetworkGuard: [...codexNetworkGuardPending(requestLocal).values()],
    unconfirmedNetworkChecks: [...codexNetworkCheckPending(requestLocal).values()],
    unconfirmedCodexSkillControls: [...codexSkillControlPendingWrites(requestLocal).values()],
    unconfirmedMcpCallControls: [...callControlPending(requestLocal).values()].filter(
      (write) => write.preview.workspaceId === workspaceId,
    ),
    filters: evidence?.filters ?? null,
    policyCases: evidence?.policyCases ?? null,
    taskLocks: evidence?.taskLocks ?? null,
    workspaceReview: evidence?.workspaceReview ?? null,
    workspaceTasks: evidence?.workspaceTasks ?? null,
    workspaceMonitor: evidence?.workspaceMonitor ?? null,
    hookChecks: evidence?.hookChecks ?? null,
    loading: current?.loading ?? false,
    polling: current?.polling ?? false,
    error: messages.length ? messages.join(' ') : null,
    refreshedAt: evidence?.refreshedAt ?? null,
    refresh,
    refreshInventory,
  };
}
