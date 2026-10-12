import type { Policy } from '@stroq/core';
import type { Finding, Severity } from './findings.js';
import { droppedProtections } from './lint-dropped.js';
import { highThreshold, looseDefault } from './lint-settings.js';
import { shadowedRules } from './lint-shadowed.js';

/** Errors first, then warnings, then notes; within a severity, the order the checks found them in. */
const ORDER: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

/**
 * Everything wrong with, or worth knowing about, a policy that loaded. Pure: it reads the policy
 * and the built-in default one, runs no command and touches neither the disk nor the network.
 */
export function lintPolicy(policy: Policy): readonly Finding[] {
  const all: Finding[] = [
    ...droppedProtections(policy),
    ...shadowedRules(policy),
    ...highThreshold(policy),
    ...looseDefault(policy),
  ];
  return all
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => ORDER[a.finding.severity] - ORDER[b.finding.severity] || a.index - b.index)
    .map(({ finding }) => finding);
}

/** True when a finding is an error or a warning: what makes `stroq policy check` exit 1. */
export function needsAttention(findings: readonly Pick<Finding, 'severity'>[]): boolean {
  return findings.some((finding) => finding.severity !== 'info');
}
