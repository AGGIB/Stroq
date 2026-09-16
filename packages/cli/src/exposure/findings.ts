/** Every kind of exposure `stroq exposure` can report. */
export type FindingClass =
  | 'agent-unprotected'
  | 'mcp-unwrapped'
  | 'mcp-http-unreachable'
  | 'mcp-tool-description-flagged'
  | 'context-flagged'
  | 'hook-foreign'
  | 'privilege-widened'
  | 'repo-exec-surface'
  | 'incident-reaches-you';

export type FindingSeverity = 'critical' | 'high' | 'medium';

export interface Finding {
  readonly class: FindingClass;
  readonly severity: FindingSeverity;
  /**
   * Human-readable, and free to name paths, servers and files. It is NEVER used to
   * build `--share` output: the shareable record is constructed field-by-field from
   * typed data, so a detail string can never leak into it.
   */
  readonly detail: string;
  /** A command the user can run to fix this, or null when there is no one-liner. */
  readonly fix: string | null;
}

export const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
};

/** Most severe first; ties keep insertion order, so discovery order is the tiebreak. */
export function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
