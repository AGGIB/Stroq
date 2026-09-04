import type { ProvenanceEvidence, ProvenanceHit } from '../types.js';

export function ageLabel(fromIso: string, now: Date): string {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 'unknown time';
  const seconds = Math.max(0, Math.round((now.getTime() - from) / 1000));
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

export function toEvidence(hit: ProvenanceHit): ProvenanceEvidence {
  const { kind, excerpt, tool, source, at, suspect } = hit.record;
  return { kind, excerpt, tool, source, at, suspect };
}

/** One English sentence a user can act on, used in hook reasons and `stroq why`. */
export function describeEvidence(evidence: ProvenanceEvidence, now: Date): string {
  const flagged = evidence.suspect
    ? 'Stroq flagged that content as suspicious.'
    : 'that content was not flagged, but tool output is data, not instructions.';
  return `"${evidence.excerpt}" appeared in the output of ${evidence.tool} (${evidence.source}) ${ageLabel(evidence.at, now)} ago; ${flagged}`;
}
