import { closed, hash, stamp } from './local-guards';
import { skillSourceOf } from './skill-sources';
import {
  validateInventoryEvidence,
  type InventoryEvidence,
  type InventoryEvidenceMatch,
} from './inventory-evidence';

export const INVENTORY_COMPARISON_LIMITATIONS = [
  'Changes compare the explicitly reviewed capture with the selected current capture. Refresh does not accept a new baseline.',
  'Only derived file fingerprints, static capability counts and rule signals are retained. Previous content, commands and environment values are unavailable.',
  'Missing file details or incomplete captures cannot establish that an unlisted file was added or removed.',
  'Analysis comparisons require matching recorded engine profiles and complete relevant evidence. Profile equality does not establish identical runtime code.',
  'MCP changes describe the selected JSON entry and its source file. Other entries can change the source file without changing this entry; server code and tool descriptions remain uninspected.',
  'These are non-atomic captured revisions and static signals, not behavior, trust, remediation or host blocking evidence.',
] as const;

type File = InventoryEvidence['files'][number];
type Capability = InventoryEvidence['capabilities'][number]['kind'];
export interface InventoryChanges {
  artifactChanged: boolean;
  engineChanged: boolean;
  files: {
    completeBefore: boolean;
    completeAfter: boolean;
    unchanged: number;
    rows: {
      id: string;
      label: string;
      labelHidden: boolean;
      beforeSha256: string | null;
      afterSha256: string | null;
      beforeBytes: number | null;
      afterBytes: number | null;
      state: 'added' | 'modified' | 'removed' | 'unobserved-before' | 'unobserved-current';
    }[];
  };
  capabilities: {
    comparable: boolean;
    rows: { kind: Capability; before: number; after: number }[];
  };
  signals: {
    comparable: boolean;
    added: InventoryEvidenceMatch[];
    removed: InventoryEvidenceMatch[];
    unchanged: number;
  };
  mcp: null | {
    entryChanged: boolean;
    sourceChanged: boolean;
    transport: { before: 'stdio' | 'http'; after: 'stdio' | 'http' };
    wrapper: { before: 'configured' | 'not-configured'; after: 'configured' | 'not-configured' };
    strict: { before: boolean; after: boolean };
  };
}
export interface InventoryComparison {
  schema: 'stroq-inventory-comparison/1';
  source: 'local';
  generatedAt: string;
  workspaceId: string;
  current: InventoryEvidence;
  baseline: {
    status: 'missing' | 'legacy' | 'available' | 'invalid';
    reviewedAt: string | null;
    sha256: string | null;
    evidence: InventoryEvidence | null;
  };
  changes: InventoryChanges | null;
  limitations: string[];
}
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameJson(v, b[i]))
    );
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a),
    other = Object.keys(b);
  return (
    keys.length === other.length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
function sameArtifact(a: InventoryEvidence, b: InventoryEvidence): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    (a.artifact.kind !== 'skill' || skillSourceOf(a.artifact) !== null) &&
    skillSourceOf(a.artifact) === skillSourceOf(b.artifact) &&
    ['id', 'kind', 'agent', 'scope', 'digestFormat'].every(
      (key) =>
        a.artifact[key as keyof typeof a.artifact] === b.artifact[key as keyof typeof b.artifact],
    )
  );
}
const filesComplete = (v: InventoryEvidence) =>
  v.coverage.omittedFileDetails === 0 && !v.coverage.gaps.includes('capture-omissions');
const staticComplete = (v: InventoryEvidence) =>
  filesComplete(v) &&
  v.coverage.gaps.every((gap) =>
    ['executable-bit-unavailable', 'prose-capabilities-uninspected'].includes(gap),
  );
const signalsComplete = (v: InventoryEvidence) =>
  filesComplete(v) &&
  v.coverage.omittedMatchDetails === 0 &&
  !v.scan.timedOut &&
  v.scan.status !== 'incomplete' &&
  v.coverage.scannedMarkdownFiles === v.coverage.markdownFiles;
const matchKey = (v: InventoryEvidenceMatch) => `${v.fileId}\0${v.ruleId}\0${v.variant}`;
const fileRow = (
  before: File | undefined,
  after: File | undefined,
  state: InventoryChanges['files']['rows'][number]['state'],
) => {
  const label = after ?? before!;
  return {
    id: label.id,
    label: label.label,
    labelHidden: label.labelHidden,
    beforeSha256: before?.sha256 ?? null,
    afterSha256: after?.sha256 ?? null,
    beforeBytes: before?.bytes ?? null,
    afterBytes: after?.bytes ?? null,
    state,
  };
};

/** Compare validated captures; absence and analysis-profile changes never become a clean diff. */
export function deriveInventoryChanges(
  current: InventoryEvidence,
  before: InventoryEvidence,
): InventoryChanges {
  if (!sameArtifact(current, before)) throw new Error('comparison-mismatch');
  const completeBefore = filesComplete(before),
    completeAfter = filesComplete(current);
  const oldFiles = new Map(before.files.map((file) => [file.id, file]));
  const newFiles = new Map(current.files.map((file) => [file.id, file]));
  const rows: InventoryChanges['files']['rows'] = [];
  let unchanged = 0;
  for (const id of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const old = oldFiles.get(id),
      next = newFiles.get(id);
    if (old && next) {
      if (old.sha256 === next.sha256 && old.bytes === next.bytes) unchanged++;
      else rows.push(fileRow(old, next, 'modified'));
    } else if (next)
      rows.push(fileRow(undefined, next, completeBefore ? 'added' : 'unobserved-before'));
    else rows.push(fileRow(old, undefined, completeAfter ? 'removed' : 'unobserved-current'));
  }
  const engineChanged = !sameJson(current.engine, before.engine);
  const capsComparable =
    current.artifact.kind === 'skill' &&
    !engineChanged &&
    staticComplete(before) &&
    staticComplete(current);
  const oldCaps = new Map(before.capabilities.map((cap) => [cap.kind, cap.count]));
  const newCaps = new Map(current.capabilities.map((cap) => [cap.kind, cap.count]));
  const capabilityRows = capsComparable
    ? [...new Set([...oldCaps.keys(), ...newCaps.keys()])].sort().flatMap((kind) => {
        const a = oldCaps.get(kind) ?? 0,
          b = newCaps.get(kind) ?? 0;
        return a === b ? [] : [{ kind, before: a, after: b }];
      })
    : [];
  const comparable =
    current.artifact.kind === 'skill' &&
    !engineChanged &&
    signalsComplete(before) &&
    signalsComplete(current);
  const oldMatches = new Map(before.matches.map((match) => [matchKey(match), match]));
  const newMatches = new Map(current.matches.map((match) => [matchKey(match), match]));
  return {
    artifactChanged: current.artifact.sha256 !== before.artifact.sha256,
    engineChanged,
    files: { completeBefore, completeAfter, unchanged, rows },
    capabilities: { comparable: capsComparable, rows: capabilityRows },
    signals: {
      comparable,
      added: comparable ? current.matches.filter((match) => !oldMatches.has(matchKey(match))) : [],
      removed: comparable ? before.matches.filter((match) => !newMatches.has(matchKey(match))) : [],
      unchanged: comparable
        ? current.matches.filter((match) => oldMatches.has(matchKey(match))).length
        : 0,
    },
    mcp:
      current.mcp && before.mcp
        ? {
            entryChanged: current.artifact.sha256 !== before.artifact.sha256,
            sourceChanged: current.files[0]!.sha256 !== before.files[0]!.sha256,
            transport: { before: before.mcp.transport, after: current.mcp.transport },
            wrapper: { before: before.mcp.wrapper, after: current.mcp.wrapper },
            strict: { before: before.mcp.strict, after: current.mcp.strict },
          }
        : null,
  };
}

/** Recompute every derived change from two separately validated, identity-bound captures. */
export function validateInventoryComparison(v: unknown): v is InventoryComparison {
  if (
    !exact(v, [
      'schema',
      'source',
      'generatedAt',
      'workspaceId',
      'current',
      'baseline',
      'changes',
      'limitations',
    ]) ||
    v.schema !== 'stroq-inventory-comparison/1' ||
    v.source !== 'local' ||
    !stamp(v.generatedAt) ||
    !validateInventoryEvidence(v.current) ||
    v.workspaceId !== v.current.workspaceId ||
    v.generatedAt < v.current.capture.completedAt ||
    !exact(v.baseline, ['status', 'reviewedAt', 'sha256', 'evidence']) ||
    !sameJson(v.limitations, [...INVENTORY_COMPARISON_LIMITATIONS])
  )
    return false;
  const baseline = v.baseline;
  if (baseline.status === 'available') {
    if (
      !stamp(baseline.reviewedAt) ||
      !hash(baseline.sha256) ||
      !validateInventoryEvidence(baseline.evidence) ||
      !sameArtifact(v.current, baseline.evidence) ||
      baseline.sha256 !== baseline.evidence.artifact.sha256 ||
      baseline.reviewedAt < baseline.evidence.capture.completedAt ||
      baseline.reviewedAt > v.generatedAt
    )
      return false;
    return sameJson(v.changes, deriveInventoryChanges(v.current, baseline.evidence));
  }
  return (
    baseline.evidence === null &&
    baseline.reviewedAt === null &&
    v.changes === null &&
    (baseline.status === 'legacy'
      ? hash(baseline.sha256)
      : ['missing', 'invalid'].includes(String(baseline.status)) && baseline.sha256 === null)
  );
}
