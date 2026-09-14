import type { AttackReport } from '../attack/run.js';
import type { Finding } from './findings.js';
import type { AgentSurface } from './surface.js';

export interface Reach {
  readonly total: number;
  /** How many recorded scenarios actually reach this user, given what is enforced here. */
  readonly passedPolicy: number;
  readonly anyAgentProtected: boolean;
}

/**
 * `runAttack` answers what the user's POLICY would do. A policy is only enforced on
 * agents that carry a Stroq hook, so on a machine with none, every scenario reaches
 * the user regardless of how good the policy is. Reporting the policy's own
 * `totals.passed` there would put a reassuring zero on a machine enforcing nothing.
 */
export function reachFrom(report: AttackReport, surfaces: readonly AgentSurface[]): Reach {
  const total = report.totals.blocked + report.totals.asked + report.totals.passed;
  const anyAgentProtected = surfaces.some((s) => s.detected && s.protected);
  return {
    total,
    passedPolicy: anyAgentProtected ? report.totals.passed : total,
    anyAgentProtected,
  };
}

export function reachFindings(reach: Reach): readonly Finding[] {
  if (!reach.anyAgentProtected)
    return [
      {
        class: 'incident-reaches-you',
        severity: 'critical',
        detail: `all ${reach.total} recorded incidents reach you: Stroq is not installed for any agent on this machine, so no policy is enforced`,
        fix: 'stroq init',
      },
    ];
  if (reach.passedPolicy > 0)
    return [
      {
        class: 'incident-reaches-you',
        severity: 'high',
        detail: `${reach.passedPolicy} of ${reach.total} recorded incidents pass through your policy; run "stroq attack" to see which`,
        fix: 'stroq attack',
      },
    ];
  return [];
}
