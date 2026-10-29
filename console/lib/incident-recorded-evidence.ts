import { ACTION_LABELS, type RecordedActionClass } from './incident-comparison';
import { closed, count, hash, member, stamp } from './local-guards';

export const RECORDED_ORIGIN_KINDS = [
  'url',
  'host',
  'pkg',
  'pipe_shell',
  'encoded',
  'digest',
] as const;
export type RecordedOriginKind = (typeof RECORDED_ORIGIN_KINDS)[number];
export const RECORDED_SCOPE_KINDS = [
  'void',
  'hard',
  'scope',
  'ask',
  'policy',
  'escalated',
  'in-scope',
] as const;
export type RecordedScopeKind = (typeof RECORDED_SCOPE_KINDS)[number];
export type EvidenceCollectionStatus = 'recorded' | 'partial' | 'not-recorded' | 'unavailable';
export const EVIDENCE_LIMITATIONS = [
  'Only fields recorded in this exact journal entry are projected; missing fields are not inferred.',
  'Original session taint and policy version were not recorded. Current state and current-policy comparison are separate.',
  'Recorded origin matches and earlier same-session events do not establish why the model chose an action.',
  'Commands, content, rule identifiers and reasons, session identifiers, source paths, excerpts and secret labels are withheld.',
  'The captured journal window is bounded and may omit earlier events; a scan score is not an attack probability.',
  'This read does not verify the journal hash chain or establish authenticated evidence, host execution, blocking or remediation.',
  'Task-scope labels describe recorded evidence, not current permission, a valid signature or host enforcement.',
] as const;

export interface RecordedEvidenceBinding {
  id: string;
  evidenceSha: string;
  sequence: number;
  recordedAt: string;
  kind: 'policy-deny' | 'policy-ask' | 'content-flag';
}
export interface RecordedEvidenceCollection<T> {
  status: EvidenceCollectionStatus;
  values: T[];
  omitted: number;
}
export interface RecordedOriginCount {
  kind: RecordedOriginKind;
  count: number;
  suspect: number;
}
export interface RecordedOriginGapCount {
  kind: RecordedOriginKind;
  count: number;
}
export interface IncidentRecordedEvidence {
  schema: 'stroq-incident-recorded-evidence/1';
  source: 'local';
  capturedAt: string;
  binding: RecordedEvidenceBinding;
  effect: 'deny' | 'ask' | null;
  window: { truncated: boolean; omitted: number };
  classes: RecordedEvidenceCollection<RecordedActionClass>;
  scope: { status: 'recorded' | 'not-recorded' | 'unavailable'; kind: RecordedScopeKind | null };
  provenance: RecordedEvidenceCollection<RecordedOriginCount>;
  provenanceIncomplete: RecordedEvidenceCollection<RecordedOriginGapCount>;
  scan: null | {
    status: 'recorded' | 'unavailable';
    score: number | null;
    trusted: boolean | null;
  };
  limitations: string[];
}

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  closed(value, keys) && Reflect.ownKeys(value).length === keys.length;
const dense = (value: unknown, max: number): value is unknown[] =>
  Array.isArray(value) &&
  value.length <= max &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
const finiteCount = (value: unknown) => count(value, 1_000_000);
const ordered = (values: unknown[], allowed: readonly string[], key: (item: any) => string) =>
  values.every(
    (value, index) =>
      index === 0 || allowed.indexOf(key(values[index - 1])) < allowed.indexOf(key(value)),
  );
function collection(
  value: unknown,
  max: number,
  validate: (item: unknown) => boolean,
  key: (item: any) => string,
): value is RecordedEvidenceCollection<unknown> {
  if (
    !exact(value, ['status', 'values', 'omitted']) ||
    !member(value.status, ['recorded', 'partial', 'not-recorded', 'unavailable']) ||
    !dense(value.values, max) ||
    !value.values.every(validate) ||
    !finiteCount(value.omitted)
  )
    return false;
  if (new Set(value.values.map(key)).size !== value.values.length) return false;
  if (value.status === 'recorded') return value.omitted === 0;
  if (value.status === 'partial') return (value.omitted as number) > 0;
  return value.values.length === 0 && value.omitted === 0;
}
function origins(value: unknown, suspect: boolean) {
  if (
    !collection(
      value,
      6,
      (item) =>
        exact(item, suspect ? ['kind', 'count', 'suspect'] : ['kind', 'count']) &&
        member(item.kind, RECORDED_ORIGIN_KINDS) &&
        count(item.count, 128) &&
        (item.count as number) > 0 &&
        (!suspect || count(item.suspect, item.count as number)),
      (item) => item.kind,
    )
  )
    return false;
  return (
    ordered(value.values, RECORDED_ORIGIN_KINDS, (item) => item.kind) &&
    (value.values as RecordedOriginGapCount[]).reduce((sum, row) => sum + row.count, 0) <= 128
  );
}
function scope(value: unknown) {
  return (
    exact(value, ['status', 'kind']) &&
    (value.status === 'recorded'
      ? member(value.kind, RECORDED_SCOPE_KINDS)
      : member(value.status, ['not-recorded', 'unavailable']) && value.kind === null)
  );
}
function scan(value: unknown, content: boolean) {
  if (!content) return value === null;
  if (!exact(value, ['status', 'score', 'trusted'])) return false;
  if (value.status === 'unavailable') return value.score === null && value.trusted === null;
  return (
    value.status === 'recorded' &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 1 &&
    (value.trusted === null || typeof value.trusted === 'boolean')
  );
}
export function validateIncidentRecordedEvidence(
  value: unknown,
): value is IncidentRecordedEvidence {
  if (
    !exact(value, [
      'schema',
      'source',
      'capturedAt',
      'binding',
      'effect',
      'window',
      'classes',
      'scope',
      'provenance',
      'provenanceIncomplete',
      'scan',
      'limitations',
    ]) ||
    value.schema !== 'stroq-incident-recorded-evidence/1' ||
    value.source !== 'local' ||
    !stamp(value.capturedAt) ||
    !exact(value.binding, ['id', 'evidenceSha', 'sequence', 'recordedAt', 'kind']) ||
    !hash(value.binding.evidenceSha) ||
    value.binding.id !== `incident-${value.binding.evidenceSha}` ||
    !count(value.binding.sequence, Number.MAX_SAFE_INTEGER) ||
    (value.binding.sequence as number) < 1 ||
    !stamp(value.binding.recordedAt) ||
    !member(value.binding.kind, ['policy-deny', 'policy-ask', 'content-flag']) ||
    !exact(value.window, ['truncated', 'omitted']) ||
    typeof value.window.truncated !== 'boolean' ||
    !finiteCount(value.window.omitted) ||
    !collection(
      value.classes,
      20,
      (item) => member(item, Object.keys(ACTION_LABELS)),
      (item) => item,
    ) ||
    !ordered(value.classes.values, Object.keys(ACTION_LABELS), (item) => item) ||
    !scope(value.scope) ||
    !origins(value.provenance, true) ||
    !origins(value.provenanceIncomplete, false) ||
    !scan(value.scan, value.binding.kind === 'content-flag') ||
    !dense(value.limitations, EVIDENCE_LIMITATIONS.length) ||
    value.limitations.length !== EVIDENCE_LIMITATIONS.length ||
    value.limitations.some((item, index) => item !== EVIDENCE_LIMITATIONS[index])
  )
    return false;
  return (
    value.effect ===
    (value.binding.kind === 'policy-deny'
      ? 'deny'
      : value.binding.kind === 'policy-ask'
        ? 'ask'
        : null)
  );
}
