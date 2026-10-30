import {
  isSkillSourceId,
  skillSourceOf,
  type SkillAgent,
  type SkillSourceId,
} from './skill-sources';
import { validateSkillLocation, type SkillLocation } from './skill-location';
import { closed, count, hash, list, member, stamp } from './local-guards';

export const SKILL_QUARANTINE_LIMITATIONS = Object.freeze([
  'This action moves one captured folder in one fixed local skill source; it does not establish that a client loaded it.',
  'Already loaded instructions and running processes are not revoked; start a fresh agent session.',
  'Other scopes or copies can still provide a skill with the same name; synced and plugin skills are outside this control.',
  'Any client reading this source can be affected; user-scoped sources are shared across workspaces.',
  'Original files, including any secrets they contain, are retained locally in an unencrypted private folder.',
  'The retained folder is not an execution sandbox or protection against another process running as your OS user.',
  'Review baselines and Stroq installation pins are not changed by this operation.',
] as const);

type Scope = 'project' | 'user';
type Action = 'quarantine' | 'restore';
type Effect = 'remove-discovery-path' | 'restore-discovery-path';
type Original = 'absent' | 'same' | 'different' | 'unverifiable';
type Payload = 'match' | 'changed' | 'missing' | 'unverifiable';
type Status =
  | 'quarantined'
  | 'reappeared'
  | 'restored'
  | 'payload-changed'
  | 'payload-missing'
  | 'recovery-required'
  | 'unverifiable';
type Reason =
  'platform-unsupported' | 'context-unavailable' | 'engine-unavailable' | 'vault-unavailable';
type Gap = 'vault-unavailable' | 'vault-limit' | 'record-invalid';

export interface SkillQuarantineArtifact {
  id: string;
  name: string;
  agent: SkillAgent;
  skillSource: SkillSourceId;
  location: SkillLocation;
  scope: Scope;
  sha256: string;
}
export interface SkillQuarantineRecord {
  id: string;
  artifact: SkillQuarantineArtifact;
  createdAt: string;
  restoredAt: string | null;
  checkedAt: string;
  files: number;
  bytes: number;
  status: Status;
  original: Original;
  payload: Payload;
  restoreBlock?: 'overlapping-skill' | 'managed-source';
}
export interface SkillQuarantineState {
  schema: 'stroq-skill-quarantine/2';
  source: 'local';
  generatedAt: string;
  workspaceId: string;
  available: boolean;
  reason: Reason | null;
  records: SkillQuarantineRecord[];
  gaps: { scope: Scope; code: Gap }[];
  limitations: string[];
}
export interface SkillQuarantinePreview {
  schema: 'stroq-skill-quarantine-preview/2';
  id: string;
  source: 'local';
  workspaceId: string;
  expiresAt: string;
  action: Action;
  recordId: string;
  artifact: SkillQuarantineArtifact;
  files: number;
  bytes: number;
  effect: Effect;
  requiresNewSession: true;
  affectsAllWorkspaces: boolean;
  limitations: string[];
}
export interface SkillQuarantineReceipt {
  schema: 'stroq-skill-quarantine-receipt/2';
  source: 'local';
  workspaceId: string;
  id: string;
  recordId: string;
  action: Action;
  artifact: SkillQuarantineArtifact;
  completedAt: string;
  status: 'quarantined' | 'restored';
  effect: Effect;
  evidence: 'discovery-path';
  requiresNewSession: true;
  reviewBaselineChanged: false;
  hostEnforcement: false;
}
export type SkillQuarantinePreviewRequest =
  | { action: 'quarantine'; id: string; expectedSha256: string }
  | { action: 'restore'; recordId: string };
export interface SkillQuarantineApplyRequest {
  previewId: string;
  confirm: true;
  acknowledgeSessionLimits: true;
}

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  closed(value, keys) && Object.keys(value).length === keys.length;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const id = (value: unknown, prefix: 'workspace' | 'item') =>
  typeof value === 'string' && new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(value);
const dense = (value: readonly unknown[]) => {
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
  return true;
};
const limitations = (value: unknown) =>
  Array.isArray(value) &&
  value.length === SKILL_QUARANTINE_LIMITATIONS.length &&
  dense(value) &&
  value.every((line, index) => line === SKILL_QUARANTINE_LIMITATIONS[index]);
const amount = (value: Record<string, unknown>) =>
  count(value.files, 128) && value.files > 0 && count(value.bytes, 524_288);
const effectOf = (action: Action): Effect =>
  action === 'quarantine' ? 'remove-discovery-path' : 'restore-discovery-path';
const sensitiveName = (value: string) =>
  /(?:^|\/)\.env|(?:^|[ \/_.-])(?:env|secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ \/_.-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
    value,
  ) || /(?:^|[\/ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[\/ .-])/.test(value);

function artifact(value: unknown): value is SkillQuarantineArtifact {
  return (
    exact(value, ['id', 'name', 'agent', 'skillSource', 'location', 'scope', 'sha256']) &&
    id(value.id, 'item') &&
    typeof value.name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(value.name) &&
    !sensitiveName(value.name) &&
    typeof value.agent === 'string' &&
    isSkillSourceId(value.skillSource) &&
    skillSourceOf({ kind: 'skill', agent: value.agent, skillSource: value.skillSource }) ===
      value.skillSource &&
    validateSkillLocation(value.location) &&
    value.location.label !== '.' &&
    member(value.scope, ['project', 'user']) &&
    hash(value.sha256)
  );
}

/** A completed ledger entry cannot override the observed source and retained bytes. */
function observed(record: SkillQuarantineRecord) {
  const { status, original, payload, restoredAt } = record;
  if (status === 'recovery-required') return true;
  if (status === 'payload-changed') return payload === 'changed';
  if (status === 'payload-missing') return payload === 'missing';
  if (payload === 'changed' || payload === 'missing') return false;
  if (status === 'unverifiable')
    return (
      original === 'unverifiable' ||
      payload === 'unverifiable' ||
      (restoredAt !== null && original !== 'same')
    );
  if (payload !== 'match') return false;
  if (status === 'restored') return restoredAt !== null && original === 'same';
  if (restoredAt !== null) return false;
  return status === 'quarantined'
    ? original === 'absent'
    : status === 'reappeared' && (original === 'same' || original === 'different');
}

function record(value: unknown): value is SkillQuarantineRecord {
  if (
    !closed(value, [
      'id',
      'artifact',
      'createdAt',
      'restoredAt',
      'checkedAt',
      'files',
      'bytes',
      'status',
      'original',
      'payload',
      'restoreBlock',
    ]) ||
    ![
      'id',
      'artifact',
      'createdAt',
      'restoredAt',
      'checkedAt',
      'files',
      'bytes',
      'status',
      'original',
      'payload',
    ].every((key) => Object.hasOwn(value, key)) ||
    (Object.hasOwn(value, 'restoreBlock') &&
      (!member(value.restoreBlock, ['overlapping-skill', 'managed-source']) ||
        value.payload !== 'match')) ||
    !uuid(value.id) ||
    !artifact(value.artifact) ||
    !stamp(value.createdAt) ||
    !stamp(value.checkedAt) ||
    value.checkedAt < value.createdAt ||
    !(
      value.restoredAt === null ||
      (stamp(value.restoredAt) &&
        value.restoredAt >= value.createdAt &&
        value.restoredAt <= value.checkedAt)
    ) ||
    !amount(value) ||
    !member(value.status, [
      'quarantined',
      'reappeared',
      'restored',
      'payload-changed',
      'payload-missing',
      'recovery-required',
      'unverifiable',
    ]) ||
    !member(value.original, ['absent', 'same', 'different', 'unverifiable']) ||
    !member(value.payload, ['match', 'changed', 'missing', 'unverifiable'])
  )
    return false;
  return observed(value as unknown as SkillQuarantineRecord);
}

/** Safe local evidence only; callers additionally bind the workspace to their open context. */
export function validateSkillQuarantine(value: unknown): value is SkillQuarantineState {
  if (
    !exact(value, [
      'schema',
      'source',
      'generatedAt',
      'workspaceId',
      'available',
      'reason',
      'records',
      'gaps',
      'limitations',
    ]) ||
    value.schema !== 'stroq-skill-quarantine/2' ||
    value.source !== 'local' ||
    !stamp(value.generatedAt) ||
    !id(value.workspaceId, 'workspace') ||
    typeof value.available !== 'boolean' ||
    !(
      value.reason === null ||
      member(value.reason, [
        'platform-unsupported',
        'context-unavailable',
        'engine-unavailable',
        'vault-unavailable',
      ])
    ) ||
    value.available !== (value.reason === null) ||
    !list(value.records, 64, record) ||
    !dense(value.records) ||
    !list(
      value.gaps,
      64,
      (gap): gap is SkillQuarantineState['gaps'][number] =>
        exact(gap, ['scope', 'code']) &&
        member(gap.scope, ['project', 'user']) &&
        member(gap.code, ['vault-unavailable', 'vault-limit', 'record-invalid']),
    ) ||
    !dense(value.gaps) ||
    (value.gaps.length > 0 && value.reason !== 'vault-unavailable') ||
    !limitations(value.limitations)
  )
    return false;
  const { records, generatedAt } = value;
  return (
    new Set(records.map((item) => item.id)).size === records.length &&
    records.every((item) => item.checkedAt <= generatedAt) &&
    ['project', 'user'].every(
      (scope) => records.filter((item) => item.artifact.scope === scope).length <= 32,
    )
  );
}

export function validateSkillQuarantinePreview(value: unknown): value is SkillQuarantinePreview {
  return (
    exact(value, [
      'schema',
      'id',
      'source',
      'workspaceId',
      'expiresAt',
      'action',
      'recordId',
      'artifact',
      'files',
      'bytes',
      'effect',
      'requiresNewSession',
      'affectsAllWorkspaces',
      'limitations',
    ]) &&
    value.schema === 'stroq-skill-quarantine-preview/2' &&
    uuid(value.id) &&
    value.source === 'local' &&
    id(value.workspaceId, 'workspace') &&
    stamp(value.expiresAt) &&
    member(value.action, ['quarantine', 'restore']) &&
    uuid(value.recordId) &&
    artifact(value.artifact) &&
    amount(value) &&
    value.effect === effectOf(value.action as Action) &&
    value.requiresNewSession === true &&
    value.affectsAllWorkspaces === (value.artifact.scope === 'user') &&
    limitations(value.limitations)
  );
}

export function validateSkillQuarantineReceipt(value: unknown): value is SkillQuarantineReceipt {
  return (
    exact(value, [
      'schema',
      'source',
      'workspaceId',
      'id',
      'recordId',
      'action',
      'artifact',
      'completedAt',
      'status',
      'effect',
      'evidence',
      'requiresNewSession',
      'reviewBaselineChanged',
      'hostEnforcement',
    ]) &&
    value.schema === 'stroq-skill-quarantine-receipt/2' &&
    value.source === 'local' &&
    id(value.workspaceId, 'workspace') &&
    uuid(value.id) &&
    uuid(value.recordId) &&
    member(value.action, ['quarantine', 'restore']) &&
    artifact(value.artifact) &&
    stamp(value.completedAt) &&
    value.status === (value.action === 'quarantine' ? 'quarantined' : 'restored') &&
    value.effect === effectOf(value.action as Action) &&
    value.evidence === 'discovery-path' &&
    value.requiresNewSession === true &&
    value.reviewBaselineChanged === false &&
    value.hostEnforcement === false
  );
}

export function validateSkillQuarantinePreviewRequest(
  value: unknown,
): value is SkillQuarantinePreviewRequest {
  return (
    (exact(value, ['action', 'id', 'expectedSha256']) &&
      value.action === 'quarantine' &&
      id(value.id, 'item') &&
      hash(value.expectedSha256)) ||
    (exact(value, ['action', 'recordId']) && value.action === 'restore' && uuid(value.recordId))
  );
}

export function validateSkillQuarantineApplyRequest(
  value: unknown,
): value is SkillQuarantineApplyRequest {
  return (
    exact(value, ['previewId', 'confirm', 'acknowledgeSessionLimits']) &&
    uuid(value.previewId) &&
    value.confirm === true &&
    value.acknowledgeSessionLimits === true
  );
}
