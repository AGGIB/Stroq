import type { ControlRun, DoctorResult, GuardTestResult, PolicyCheckResult } from './control';
import type {
  ProtectionCheckStep,
  SavedProtectionResult,
  WorkspaceProtectionResult,
} from './protection-check';
import { doctorInstallationRows, doctorSetupMissing } from './doctor-presentation';
type Outcome = { label: string; tone: 'green' | 'orange' | 'red' | 'muted' };
export function protectionStageSummary(step: ProtectionCheckStep): string | null {
  if (step.status !== 'completed' || !step.result) return null;
  if (step.id === 'doctor') {
    const result = step.result as DoctorResult;
    const review =
      doctorInstallationRows(result).filter((row) => row.attention).length +
      (doctorSetupMissing(result) ? 1 : 0);
    return `${result.total} diagnostics · ${review} to review`;
  }
  if (step.id === 'policy-check') {
    const result = step.result as PolicyCheckResult;
    const findings = result.findings
      .filter((f) => f.severity !== 'info')
      .reduce((sum, f) => sum + f.count, 0);
    return `${result.faults} faults · ${findings} findings to review`;
  }
  if (step.id === 'guard-test') {
    const r = step.result as GuardTestResult;
    return `${r.attacksPassing} attack scenarios allowed · ${r.newInterruptions} new interruptions · ${r.notJudged} unjudged${r.violations ? ` · ${r.violations} unmet expectations` : ''}`;
  }
  if (step.id === 'saved-policy-checks') {
    const r = step.result as SavedProtectionResult;
    return r.total === 0 ? 'No saved checks' : `${r.failed} of ${r.total} expectations unmatched`;
  }
  const r = step.result as WorkspaceProtectionResult;
  return `${r.errors} errors · ${r.warnings} warnings · ${r.complete ? 'complete' : 'partial'}${r.coverage.gaps ? ` · ${r.coverage.gaps} gaps` : ''}`;
}
export function protectionStageOutcome(step: ProtectionCheckStep): Outcome {
  if (step.status !== 'completed' || !step.result)
    return {
      label: {
        queued: 'Waiting',
        running: 'Running…',
        failed: 'Could not complete',
        skipped: 'Not run',
        completed: 'Incomplete',
      }[step.status],
      tone: step.status === 'failed' ? 'orange' : 'muted',
    };
  if (step.id === 'doctor') {
    const result = step.result as DoctorResult;
    return {
      label: result.ok ? 'Diagnostics recorded' : 'Needs attention',
      tone: result.ok ? 'muted' : 'orange',
    };
  }
  if (step.id === 'policy-check') {
    const result = step.result as PolicyCheckResult;
    return {
      label: result.ok ? 'Validated' : 'Needs attention',
      tone: result.ok ? 'muted' : 'orange',
    };
  }
  if (step.id === 'guard-test') {
    const result = step.result as GuardTestResult;
    if (result.notJudged > 0) return { label: 'Incomplete', tone: 'orange' };
    if (!result.ok || result.attacksPassing > 0 || result.violations > 0)
      return { label: 'Needs attention', tone: 'orange' };
    return {
      label: result.newInterruptions > 0 ? 'Passed with changes' : 'Scenarios matched',
      tone: result.newInterruptions > 0 ? 'orange' : 'muted',
    };
  }
  if (step.id === 'saved-policy-checks') {
    const result = step.result as SavedProtectionResult;
    return {
      label:
        result.failed > 0
          ? 'Needs attention'
          : result.total === 0
            ? 'No saved checks'
            : 'Expectations matched',
      tone: result.failed > 0 ? 'orange' : 'muted',
    };
  }
  const result = step.result as WorkspaceProtectionResult;
  return {
    label: !result.complete
      ? 'Partial capture'
      : result.errors || result.warnings
        ? 'Needs attention'
        : 'Capture recorded',
    tone: !result.complete || result.errors || result.warnings ? 'orange' : 'muted',
  };
}
export function protectionCheckOutcome(run: ControlRun): Outcome {
  if (run.status === 'running') return { label: 'Checking…', tone: 'muted' };
  if (run.status === 'cancelled') return { label: 'Cancelled', tone: 'muted' };
  if (run.status === 'failed') return { label: 'Incomplete', tone: 'orange' };
  return run.progress?.steps.some((step) => protectionStageOutcome(step).tone !== 'muted')
    ? { label: 'Needs attention', tone: 'orange' }
    : { label: 'Checks recorded', tone: 'muted' };
}
