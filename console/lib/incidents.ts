import { closed, count, hash, member, stamp, text } from './local-guards';
export interface Incident {
  id: string;
  evidenceSha: string;
  recordedAt: string;
  sequence: number;
  kind: 'policy-deny' | 'policy-ask' | 'content-flag';
  severity: 'high' | 'medium';
  title: string;
  categories: string[];
  relatedIds: string[];
  secretReferences: number;
  status: 'open' | 'reviewed';
  reviewedAt: string | null;
}
export interface IncidentsState {
  schema: 'stroq-incidents/1';
  source: 'local';
  generatedAt: string;
  window: { kind: 'missing' | 'available' | 'refused'; truncated: boolean; omitted: number };
  incidents: Incident[];
  limitations: string[];
}
export interface JournalVerification {
  schema: 'stroq-journal-verification/1';
  source: 'local';
  status: 'consistent' | 'broken' | 'missing' | 'refused' | 'limit' | 'engine-unavailable';
  verifiedAt: string;
  journalSha: string | null;
  count: number | null;
  brokenAt: number | null;
  limitations: string[];
}
export const INCIDENT_KINDS = {
  'policy-deny': 'Policy deny',
  'policy-ask': 'Approval',
  'content-flag': 'Content finding',
};
const titles: Record<Incident['kind'], string> = {
  'policy-deny': 'Policy denied a tool call',
  'policy-ask': 'Policy requested approval',
  'content-flag': 'Content scan raised a finding',
};
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^incident-[a-f0-9]{64}$/.test(v);
const strings = (v: unknown) => Array.isArray(v) && v.length <= 32 && v.every((s) => text(s, 600));
export function validateIncident(v: unknown): v is Incident {
  return (
    closed(v, [
      'id',
      'evidenceSha',
      'recordedAt',
      'sequence',
      'kind',
      'severity',
      'title',
      'categories',
      'relatedIds',
      'secretReferences',
      'status',
      'reviewedAt',
    ]) &&
    identifier(v.id) &&
    hash(v.evidenceSha) &&
    stamp(v.recordedAt) &&
    count(v.sequence, Number.MAX_SAFE_INTEGER) &&
    member(v.kind, Object.keys(titles)) &&
    v.title === titles[v.kind as Incident['kind']] &&
    member(v.severity, ['high', 'medium']) &&
    Array.isArray(v.categories) &&
    v.categories.length <= 7 &&
    v.categories.every((c) =>
      member(c, [
        'network',
        'execution',
        'credentials',
        'filesystem',
        'configuration',
        'external-tool',
        'unclassified',
      ]),
    ) &&
    Array.isArray(v.relatedIds) &&
    v.relatedIds.length <= 32 &&
    v.relatedIds.every(identifier) &&
    count(v.secretReferences) &&
    member(v.status, ['open', 'reviewed']) &&
    (v.status === 'reviewed' ? stamp(v.reviewedAt) : v.reviewedAt === null)
  );
}
export function validateIncidents(v: unknown): v is IncidentsState {
  return (
    closed(v, ['schema', 'source', 'generatedAt', 'window', 'incidents', 'limitations']) &&
    v.schema === 'stroq-incidents/1' &&
    v.source === 'local' &&
    stamp(v.generatedAt) &&
    closed(v.window, ['kind', 'truncated', 'omitted']) &&
    member(v.window.kind, ['missing', 'available', 'refused']) &&
    typeof v.window.truncated === 'boolean' &&
    count(v.window.omitted) &&
    Array.isArray(v.incidents) &&
    v.incidents.length <= 500 &&
    v.incidents.every(validateIncident) &&
    new Set(v.incidents.map((i) => i.id)).size === v.incidents.length &&
    strings(v.limitations)
  );
}
export function validateJournalVerification(v: unknown): v is JournalVerification {
  if (
    !closed(v, [
      'schema',
      'source',
      'status',
      'verifiedAt',
      'journalSha',
      'count',
      'brokenAt',
      'limitations',
    ]) ||
    v.schema !== 'stroq-journal-verification/1' ||
    v.source !== 'local' ||
    !member(v.status, [
      'consistent',
      'broken',
      'missing',
      'refused',
      'limit',
      'engine-unavailable',
    ]) ||
    !stamp(v.verifiedAt) ||
    !(v.journalSha === null || hash(v.journalSha)) ||
    !(v.count === null || count(v.count, Number.MAX_SAFE_INTEGER)) ||
    !(v.brokenAt === null || count(v.brokenAt, Number.MAX_SAFE_INTEGER)) ||
    !strings(v.limitations)
  )
    return false;
  if (v.status === 'consistent')
    return hash(v.journalSha) && count(v.count, Number.MAX_SAFE_INTEGER) && v.brokenAt === null;
  if (v.status === 'broken')
    return hash(v.journalSha) && count(v.brokenAt, Number.MAX_SAFE_INTEGER);
  return true;
}
