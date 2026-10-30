'use client';
import Link from 'next/link';
import { ArrowRight, FileCode2, Folder, RefreshCw } from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import { useControl } from '@/components/control-provider';
import { Badge, Panel } from '@/components/platform-ui';
import { protectionEvidenceRows, type ProtectionEvidenceRow } from '@/lib/protection-evidence';
import { mcpContainmentRows } from '@/lib/mcp-containment-queue';
import { credentialFilterRows } from '@/lib/credential-filter-queue';
import { policyCaseRows } from '@/lib/policy-cases-queue';
import { taskLockRows } from '@/lib/task-lock-queue';
import { workspaceReviewRows } from '@/lib/workspace-review-queue';
import { workspaceTaskRows } from '@/lib/workspace-task-queue';
import { workspaceMonitorRows } from '@/lib/workspace-monitor-queue';
import { hookCheckRows } from '@/lib/hook-check-queue';
import { inventoryAttentionRows } from '@/lib/inventory-attention-queue';
import { incidentAssessmentRows } from '@/lib/incident-assessment-queue';
import { codexSkillControlRows } from '@/lib/codex-skill-control-queue';
import { codexNetworkRows } from '@/lib/codex-network-queue';
import { codexPathGuardRows } from '@/lib/codex-path-guard-queue';
import {
  mcpGovernanceAttentionRows,
  sortProtectionAttention,
} from '@/lib/mcp-governance-attention';
import {
  protectionCheckRows,
  protectionEvidenceHref,
  mcpCallControlRows,
  mcpCallControlPendingRows,
} from '@/lib/protection-check-queue';
import { useProtectionQueue } from './use-protection-queue';
import { InventoryMonitor } from './inventory-monitor';
import {
  latestContextRun,
  type DoctorResult,
  type GuardTestResult,
  type PolicyCheckResult,
} from '@/lib/control';

export function ProtectionQueue({ refreshKey }: { refreshKey?: string }) {
  const { localContext } = usePlatform();
  const { runs, control } = useControl();
  const workspaceId = localContext?.workspace.id ?? null;
  const {
    inventory,
    inventoryFreshness,
    incidents,
    assessments,
    unconfirmedAssessments,
    agents,
    quarantine,
    live,
    secrets,
    mcp,
    mcpCallControls,
    unconfirmedMcpCallControls,
    mcpGovernance,
    mcpGovernanceUnresolved,
    unconfirmedMcpGovernance,
    codexSkillControls,
    unconfirmedCodexSkillControls,
    codexNetworkGuard,
    codexNetworkChecks,
    unconfirmedNetworkGuard,
    unconfirmedNetworkChecks,
    codexPathGuard,
    unconfirmedCodexPaths,
    filters,
    policyCases,
    taskLocks,
    workspaceReview,
    workspaceTasks,
    workspaceMonitor,
    hookChecks,
    loading,
    polling,
    error,
    refresh,
    refreshInventory,
  } = useProtectionQueue(refreshKey);
  const doctor = latestContextRun(runs, 'doctor', control?.context),
    policy = latestContextRun(runs, 'policy-check', control?.context),
    simulation = latestContextRun(runs, 'guard-test', control?.context);
  const policyResult =
    policy?.status === 'completed' ? (policy.result as PolicyCheckResult) : undefined;
  const simulated =
    simulation?.status === 'completed' ? (simulation.result as GuardTestResult) : undefined;
  const installation = doctor?.status === 'completed' ? (doctor.result as DoctorResult) : undefined;
  const rows: ProtectionEvidenceRow[] = protectionEvidenceRows({
    live,
    secrets,
    agents,
    workspaceId,
    loading,
  });
  rows.push(...protectionCheckRows(runs, workspaceId));
  rows.push(
    ...mcpGovernanceAttentionRows({
      state: mcpGovernance,
      workspaceId,
      pending: unconfirmedMcpGovernance,
      retained: mcpGovernanceUnresolved,
      loading,
    }),
  );
  if (!loading || mcp) rows.push(...mcpContainmentRows(mcp, workspaceId));
  rows.push(...mcpCallControlPendingRows(unconfirmedMcpCallControls, mcpCallControls, workspaceId));
  if (!loading || mcpCallControls) rows.push(...mcpCallControlRows(mcpCallControls, workspaceId));
  if (!loading || codexSkillControls || unconfirmedCodexSkillControls?.length)
    rows.push(...codexSkillControlRows(codexSkillControls, unconfirmedCodexSkillControls));
  rows.push(
    ...codexNetworkRows({
      workspaceId,
      guard: codexNetworkGuard,
      checks: codexNetworkChecks,
      guardPending: unconfirmedNetworkGuard,
      checkPending: unconfirmedNetworkChecks,
      loading,
    }),
  );
  rows.push(
    ...codexPathGuardRows({
      state: codexPathGuard,
      pending: unconfirmedCodexPaths,
      loading,
    }),
  );
  if (!loading || filters) rows.push(...credentialFilterRows(filters, workspaceId));
  if (!loading || policyCases) rows.push(...policyCaseRows(policyCases, workspaceId));
  if (!loading || taskLocks) rows.push(...taskLockRows(taskLocks, workspaceId));
  if (!loading || workspaceReview) rows.push(...workspaceReviewRows(workspaceReview, workspaceId));
  if (!loading || workspaceTasks) rows.push(...workspaceTaskRows(workspaceTasks, workspaceId));
  if (!loading || workspaceMonitor)
    rows.push(...workspaceMonitorRows(workspaceMonitor, workspaceId));
  if (!loading || hookChecks) rows.push(...hookCheckRows(hookChecks, agents, workspaceId));
  if (!loading || inventory)
    rows.push(...inventoryAttentionRows(inventory, workspaceId, inventoryFreshness));
  const retainedIssues =
    quarantine?.records.filter((record) => !['quarantined', 'restored'].includes(record.status))
      .length ?? 0;
  if (retainedIssues || quarantine?.gaps.length)
    rows.push({
      key: 'quarantine',
      title: retainedIssues
        ? retainedIssues + ' retained skill versions need attention'
        : 'Quarantine storage could not be verified',
      detail: 'A folder reappeared, retained files changed or an operation needs recovery.',
      href: '/skills/quarantine/?view=attention',
      action: 'Recheck folders',
      tone: 'orange',
    });
  if (!loading || assessments)
    rows.push(...incidentAssessmentRows(incidents, assessments, unconfirmedAssessments));
  if (incidents?.window.kind === 'refused')
    rows.push({
      key: 'journal-gap',
      title: 'Journal evidence could not be read',
      detail: 'Investigate this coverage gap before relying on the recorded queue.',
      href: '/incidents/',
      action: 'Inspect journal',
      tone: 'orange',
    });
  const setupIssues =
    agents?.agents.filter((agent) =>
      agent.scopes.some((scope) => ['changed', 'invalid', 'unknown'].includes(scope.state)),
    ).length ?? 0;
  const configured =
    agents?.agents.filter((agent) => agent.scopes.some((scope) => scope.state === 'present'))
      .length ?? 0;
  // While the first snapshots load, the panel says "Checking"; a missing one is a gap only after.
  if (!agents && !loading)
    rows.push({
      key: 'configuration-gap',
      title: 'Current agent configuration unavailable',
      detail: 'Historical diagnostics cannot establish the current hook setup.',
      href: '/agents/',
      action: 'Inspect agents',
      tone: 'orange',
    });
  else if (setupIssues)
    rows.push({
      key: 'configuration-gap',
      title: `${setupIssues} agent ${setupIssues === 1 ? 'configuration needs' : 'configurations need'} attention`,
      detail: 'Current hook configuration is changed, invalid or unreadable.',
      href: '/agents/',
      action: 'Review agents',
      tone: 'orange',
    });
  else if (agents && configured === 0)
    rows.push({
      key: 'install',
      title: 'Connect the agent you use',
      detail: 'Stroq judges only what a connected agent asks it about.',
      href: '/agents/',
      action: 'Connect agent',
      tone: 'muted',
    });
  if (
    agents?.agents.some((agent) =>
      agent.scopes.some((scope) => scope.state === 'present' && scope.approval !== 'not-required'),
    )
  )
    rows.push({
      key: 'hook-approval',
      title: 'Hook approval needs review',
      detail: 'Configured hooks have a required or unverified host approval.',
      href: '/agents/',
      action: 'Review approval',
      tone: 'orange',
    });
  if (doctor?.status === 'failed' || (installation && installation.passed < installation.total))
    rows.push({
      key: 'installation-diagnostic',
      title: installation
        ? `Last installation check recorded ${installation.total - installation.passed} issues`
        : 'Last installation check did not finish',
      detail: `Recorded ${doctor?.finishedAt ?? doctor?.startedAt}. Run again to reread installation settings.`,
      href: protectionEvidenceHref(doctor, runs, workspaceId, 'doctor'),
      action: 'Inspect result',
      tone: 'orange',
    });
  if (policy?.status === 'failed' || policyResult?.ok === false)
    rows.push({
      key: 'policy',
      title: 'Review the active policy',
      detail: 'Policy validation needs attention before changing settings.',
      href: '/policies/',
      action: 'Open policy',
      tone: 'orange',
    });
  else if (!policy && runs.some((run) => run.kind === 'policy-check'))
    rows.push({
      key: 'policy-context',
      title: 'Policy validation needs a fresh check',
      detail: 'Recorded checks do not match the current workspace, policy or engine.',
      href: '#protection-policy-check',
      action: 'Validate policy',
      tone: 'orange',
    });
  if (
    simulated &&
    (simulated.attacksPassing > 0 || simulated.notJudged > 0 || simulated.violations > 0)
  )
    rows.push({
      key: 'scenarios',
      title: 'Policy scenarios need review',
      detail: `${simulated.attacksPassing} allowed attacks · ${simulated.notJudged} unjudged · ${simulated.violations} unmet expectations`,
      href: protectionEvidenceHref(simulation, runs, workspaceId, 'guard-test'),
      action: 'Inspect result',
      tone: simulated.attacksPassing ? 'red' : 'orange',
    });
  else if (
    simulation?.status === 'failed' ||
    (!simulation && runs.some((run) => run.kind === 'guard-test'))
  )
    rows.push({
      key: 'scenarios-context',
      title: simulation ? 'Policy scenarios did not finish' : 'Policy scenarios need a fresh check',
      detail: simulation
        ? 'The latest matching test did not produce a result.'
        : 'Historical simulations do not establish the current policy outcome.',
      href: protectionEvidenceHref(simulation, runs, workspaceId, 'guard-test'),
      action: 'Inspect policy test',
      tone: 'orange',
    });
  const orderedRows = sortProtectionAttention(rows);
  return (
    <>
      <Panel
        title="Needs your attention"
        actions={
          <button
            className="icon-button"
            aria-label="Refresh protection inventory"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} className={loading ? 'spin' : undefined} />
          </button>
        }
        className="protection-queue"
      >
        <div className="protection-queue-context">
          <Folder size={14} aria-hidden="true" />
          <span>{inventory?.workspace.label ?? 'Local workspace'}</span>
          <span>
            {inventory
              ? `${inventoryFreshness === 'current' ? 'Inventory captured' : 'Earlier inventory'} ${new Date(inventory.generatedAt).toLocaleString('en-GB')}`
              : loading
                ? 'Inspecting inventory…'
                : 'Inventory not checked'}
          </span>
        </div>
        {error && (
          <p className="control-error" role="alert">
            {error}
            {inventory && inventoryFreshness === 'historical'
              ? ' Earlier inventory remains visible.'
              : ''}
          </p>
        )}
        <div>
          {orderedRows.map((row) => (
            <div key={row.key} className="protection-queue-row">
              <FileCode2 size={19} aria-hidden="true" className={`queue-icon ${row.tone}`} />
              <div>
                <strong>{row.title}</strong>
                {row.context && <small className="queue-source">{row.context}</small>}
                <details className="queue-evidence">
                  <summary>Evidence & scope</summary>
                  <p>{row.detail}</p>
                </details>
              </div>
              <Link className="button subtle small" href={row.href}>
                {row.action}
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          ))}
        </div>
        {rows.length === 0 && (
          <div className="protection-queue-row">
            <Badge tone="muted">{loading ? 'Checking' : 'No queued findings'}</Badge>
            <p>
              {!inventory
                ? 'Inventory evidence is not available yet.'
                : 'No attention items in the available reports. Coverage remains limited to recorded checks.'}
            </p>
          </div>
        )}
      </Panel>
      <InventoryMonitor canRefresh={!loading && !polling} onCheck={refreshInventory} />
    </>
  );
}
