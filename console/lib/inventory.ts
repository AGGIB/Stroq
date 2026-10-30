import { validateSkillLocation, type SkillLocation } from './skill-location';
import {
  validateInventorySignalProjection,
  type InventorySignalProjection,
} from './inventory-signal-decision';
import { closed, count, hash, list, member, stamp, text } from './local-guards';
import {
  isSkillSourceId,
  skillSourceOf,
  validateSkillSourceCoverage,
  type SkillSourceId,
  type SkillSourceCoverage,
} from './skill-sources';
export { validateInventoryEvidence } from './inventory-evidence';
export { validateInventoryComparison } from './inventory-changes';
export {
  INVENTORY_SIGNAL_LIMITATIONS,
  signalReasonMatches,
  validateInventorySignalState,
  validateInventorySignalPreview,
  validateInventorySignalReceipt,
} from './inventory-signal-decision';
export type {
  InventoryEvidence,
  InventoryEvidenceFile,
  InventoryEvidenceMatch,
} from './inventory-evidence';
export const INVENTORY_QUARANTINE_REASONS = {
  supported: 'Folder can be moved',
  'source-root': 'This folder is the source root',
  'overlapping-skill': 'This folder overlaps another skill',
  'managed-source': 'Managed or plugin content',
  'unsafe-location': 'Source location could not be verified',
  incomplete: 'Complete inspection required',
} as const;
export type InventoryQuarantineReason = keyof typeof INVENTORY_QUARANTINE_REASONS;
export interface InventoryItem {
  id: string;
  kind: 'skill' | 'mcp';
  name: string;
  agent: 'claude-code' | 'cursor' | 'windsurf' | 'claude-desktop' | 'codex' | 'shared';
  skillSource?: SkillSourceId;
  quarantineSupported?: boolean;
  quarantineReason?: InventoryQuarantineReason;
  location?: SkillLocation;
  signalDecision?: InventorySignalProjection;
  scope: 'project' | 'user';
  fileType: 'skill-tree' | 'mcp-config';
  sha256: string | null;
  reviewedSha256: string | null;
  state: 'unreviewed' | 'unchanged' | 'changed' | 'missing' | 'unverifiable';
  scan: { status: 'clean' | 'suspect' | 'incomplete' | 'not-scanned'; findings: number };
  capabilities?: { kind: keyof typeof CAPABILITIES; count: number }[];
  mcp?: {
    transport: 'stdio' | 'http' | 'unknown';
    wrapper: 'configured' | 'not-configured' | 'unknown';
    strict: boolean;
  };
}
export interface InventoryState {
  schema: 'stroq-inventory/1';
  source: 'local';
  generatedAt: string;
  workspace: { id: string; label: string };
  baseline: { status: 'missing' | 'ready' | 'invalid'; reviewedAt: string | null };
  items: InventoryItem[];
  gaps: { code: string; agent: string; scope: string; kind: string; skillSource?: SkillSourceId }[];
  limitations: string[];
  skillSources?: SkillSourceCoverage[];
  signalDecisions?: { status: 'missing' | 'ready' | 'unavailable' };
}
export const INVENTORY_AGENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  shared: 'Shared source',
};
export const INVENTORY_STATES: Record<InventoryItem['state'], string> = {
  unreviewed: 'New',
  unchanged: 'Reviewed',
  changed: 'Changed',
  missing: 'Missing',
  unverifiable: 'Incomplete',
};
export const CAPABILITIES = {
  'fs.read': 'File reads',
  'fs.write': 'File writes',
  net: 'Network access',
  'cred.env': 'Credential environment access',
  'cred.file': 'Credential file access',
  exec: 'Process execution',
  hook: 'Hooks',
  'install-script': 'Install scripts',
  tool: 'Tools',
  'allowed-tools': 'Tool permissions',
  signal: 'Other inspection signals',
} as const;
export function validateInventoryItem(v: unknown): v is InventoryItem {
  if (
    !closed(v, [
      'id',
      'kind',
      'name',
      'agent',
      'scope',
      'fileType',
      'sha256',
      'reviewedSha256',
      'state',
      'scan',
      'mcp',
      'capabilities',
      'skillSource',
      'quarantineSupported',
      'quarantineReason',
      'location',
      'signalDecision',
    ]) ||
    typeof v.id !== 'string' ||
    !/^item-[a-f0-9]{24}$/.test(v.id) ||
    !member(v.kind, ['skill', 'mcp']) ||
    !text(v.name, 200) ||
    !member(v.agent, Object.keys(INVENTORY_AGENTS)) ||
    !member(v.scope, ['project', 'user']) ||
    !member(v.fileType, ['skill-tree', 'mcp-config']) ||
    !(v.sha256 === null || hash(v.sha256)) ||
    !(v.reviewedSha256 === null || hash(v.reviewedSha256)) ||
    !member(v.state, Object.keys(INVENTORY_STATES)) ||
    !closed(v.scan, ['status', 'findings']) ||
    !member(v.scan.status, ['clean', 'suspect', 'incomplete', 'not-scanned']) ||
    !count(v.scan.findings)
  )
    return false;
  if (
    v.kind === 'skill' &&
    (skillSourceOf(v as unknown as InventoryItem) === null ||
      (Object.hasOwn(v, 'skillSource') && !isSkillSourceId(v.skillSource)) ||
      (Object.hasOwn(v, 'quarantineSupported') && typeof v.quarantineSupported !== 'boolean') ||
      (Object.hasOwn(v, 'location') && !validateSkillLocation(v.location)) ||
      (Object.hasOwn(v, 'quarantineReason') &&
        (!member(v.quarantineReason, Object.keys(INVENTORY_QUARANTINE_REASONS)) ||
          typeof v.quarantineSupported !== 'boolean' ||
          v.quarantineSupported !== (v.quarantineReason === 'supported'))) ||
      (Object.hasOwn(v, 'signalDecision') &&
        !validateInventorySignalProjection(v.signalDecision)) ||
      v.fileType !== 'skill-tree' ||
      Object.hasOwn(v, 'mcp') ||
      !Array.isArray(v.capabilities) ||
      v.capabilities.length > 11 ||
      !v.capabilities.every(
        (c) =>
          closed(c, ['kind', 'count']) &&
          member(c.kind, Object.keys(CAPABILITIES)) &&
          count(c.count, 10_000) &&
          c.count > 0,
      ))
  )
    return false;
  if (
    v.kind === 'mcp' &&
    (Object.hasOwn(v, 'location') ||
      Object.hasOwn(v, 'quarantineReason') ||
      Object.hasOwn(v, 'signalDecision') ||
      Object.hasOwn(v, 'skillSource') ||
      Object.hasOwn(v, 'quarantineSupported') ||
      !member(v.agent, ['claude-code', 'claude-desktop', 'cursor', 'windsurf']) ||
      v.fileType !== 'mcp-config' ||
      Object.hasOwn(v, 'capabilities') ||
      !closed(v.mcp, ['transport', 'wrapper', 'strict']) ||
      !member(v.mcp.transport, ['stdio', 'http', 'unknown']) ||
      !member(v.mcp.wrapper, ['configured', 'not-configured', 'unknown']) ||
      typeof v.mcp.strict !== 'boolean')
  )
    return false;
  if (v.quarantineSupported === true) {
    if (
      !hash(v.sha256) ||
      v.scan.status === 'incomplete' ||
      v.scan.status === 'not-scanned' ||
      v.state === 'missing' ||
      v.state === 'unverifiable'
    )
      return false;
    const location = (v as unknown as InventoryItem).location;
    if (location?.label === '.') return false;
    if (
      (v.quarantineReason === 'supported' ||
        skillSourceOf(v as unknown as InventoryItem) !== 'claude-skills') &&
      (!location || v.quarantineReason !== 'supported')
    )
      return false;
  }
  const decision = (v as unknown as InventoryItem).signalDecision;
  if (decision?.record) {
    const b = decision.record.binding;
    if (
      b.itemId !== v.id ||
      b.agent !== v.agent ||
      b.skillSource !== skillSourceOf(v as unknown as InventoryItem) ||
      b.scope !== v.scope
    )
      return false;
    if (
      decision.standing === 'applies' &&
      (v.scan.status !== 'suspect' ||
        v.scan.findings === 0 ||
        v.state === 'unverifiable' ||
        b.artifactSha256 !== v.sha256)
    )
      return false;
  }
  if (v.state === 'unchanged' && (!hash(v.sha256) || v.sha256 !== v.reviewedSha256)) return false;
  if (
    v.state === 'changed' &&
    (!hash(v.sha256) || !hash(v.reviewedSha256) || v.sha256 === v.reviewedSha256)
  )
    return false;
  if (v.state === 'missing' && (v.sha256 !== null || !hash(v.reviewedSha256))) return false;
  return true;
}
export function validateInventory(v: unknown): v is InventoryState {
  if (
    !closed(v, [
      'schema',
      'source',
      'generatedAt',
      'workspace',
      'baseline',
      'items',
      'gaps',
      'limitations',
      'skillSources',
      'signalDecisions',
    ]) ||
    v.schema !== 'stroq-inventory/1' ||
    v.source !== 'local' ||
    !stamp(v.generatedAt) ||
    !closed(v.workspace, ['id', 'label']) ||
    typeof v.workspace.id !== 'string' ||
    !/^workspace-[a-f0-9]{24}$/.test(v.workspace.id) ||
    !text(v.workspace.label, 120) ||
    !closed(v.baseline, ['status', 'reviewedAt']) ||
    !member(v.baseline.status, ['missing', 'ready', 'invalid']) ||
    !(v.baseline.reviewedAt === null || stamp(v.baseline.reviewedAt)) ||
    !list(v.items, 512, validateInventoryItem) ||
    !Array.isArray(v.gaps) ||
    v.gaps.length > 512 ||
    !v.gaps.every(
      (g) =>
        closed(g, ['code', 'agent', 'scope', 'kind', 'skillSource']) &&
        text(g.code, 100) &&
        text(g.agent, 80) &&
        text(g.scope, 80) &&
        text(g.kind, 80) &&
        (!Object.hasOwn(g, 'skillSource') ||
          (isSkillSourceId(g.skillSource) &&
            skillSourceOf(g as unknown as InventoryItem) !== null &&
            member(g.scope, ['project', 'user']))),
    ) ||
    !Array.isArray(v.limitations) ||
    v.limitations.length > 32 ||
    !v.limitations.every((s) => text(s, 600)) ||
    (Object.hasOwn(v, 'signalDecisions') &&
      (!closed(v.signalDecisions, ['status']) ||
        !member(v.signalDecisions.status, ['missing', 'ready', 'unavailable']))) ||
    (Object.hasOwn(v, 'skillSources') &&
      (!list(v.skillSources, 12, validateSkillSourceCoverage) ||
        new Set(v.skillSources.map((s) => `${s.id}:${s.scope}`)).size !== v.skillSources.length))
  )
    return false;
  if (new Set(v.items.map((i) => i.id)).size !== v.items.length) return false;
  const status = (v as unknown as InventoryState).signalDecisions?.status;
  const workspaceId = v.workspace.id;
  return v.items.every((i) => {
    const d = i.signalDecision;
    if (!d) return true;
    if (
      d.record &&
      (d.record.binding.workspaceId !== workspaceId || d.record.recordedAt > String(v.generatedAt))
    )
      return false;
    if (d.standing === 'applies' && status !== 'ready') return false;
    if (status === 'unavailable' && d.standing !== 'unavailable') return false;
    if (status === 'missing' && d.standing !== 'unresolved') return false;
    return true;
  });
}
export { validateCodexSkillSourcesReport } from './codex-skill-sources';
export {
  CODEX_SKILL_CONTROL_ERRORS,
  validateCodexSkillControlState,
  validateCodexSkillControlPreview,
  validateCodexSkillControlReceipt,
  validateCodexSkillControlRecord,
  validateCodexSkillControlSelection,
  validateCodexSkillControlRestoreSelection,
  validateCodexSkillControlRecheckSelection,
} from './codex-skill-controls';
export {
  validateCodexSkillControlPrivatePlan,
  codexSkillControlPrivatePlanBytes,
} from './codex-skill-controls-private';
export * from './codex-network-guard';
export * from './codex-path-guard';
export {
  validateCodexPathGuardPrivatePlan,
  codexPathGuardPrivatePlanBytes,
} from './codex-path-guard-private';
export {
  validateCodexNetworkGuardPrivatePlan,
  codexNetworkGuardPrivatePlanBytes,
} from './codex-network-guard-private';
export {
  validateCodexNetworkGuardCheckPreparation,
  codexNetworkGuardCheckPreparationBytes,
} from './codex-network-guard-check-private';
