import { closed, hash, list, member, stamp, text } from './local-guards';
import {
  compareMcpToolContract,
  type McpToolContractComparison,
} from './mcp-tool-contract-comparison';
export type { McpToolContractComparison } from './mcp-tool-contract-comparison';

export const MCP_TOOL_CONTRACT_LIMITATIONS = Object.freeze([
  'Records describe advertised tool contracts observed through an opted-in strict proxy. Opening or refreshing this page never starts or probes a server.',
  'On an already running server, capture starts only after the client explicitly requests tools/list without a cursor. The proxy follows each cursor to collect a complete listing.',
  'Captures are limited to 16 pages, 256 tools, 200,000 serialized JSON characters and 1 MiB of aggregate JSON bytes. Strict scanning can refuse smaller captures.',
  'Opaque cursors are limited to 4,096 bytes. The complete listing must arrive within 30 seconds.',
  'Every page and the combined listing must pass full strict scanning. Timeout, cancellation, a list change, duplicate tools, cursor cycles, malformed pages or a limit leave the capture incomplete; no approved empty or complete listing is inferred.',
  'The entire advertised tool listing is withheld while any version is pending or revoked. Named calls are gated against their exact approved version.',
  'Each proxy connection needs a fresh listing after restart; saved captures are historical evidence.',
  'Approval applies to one exact contract and connection binding. Ordinary Stroq policy and message scanning remain independent gates.',
  'Approval does not retry a call, prove honest server behavior or establish adoption by a running native client.',
  'Advertised descriptions and schemas are retained unencrypted in private local storage and may contain sensitive or hostile text.',
  'Records have no automatic expiry. Storage limits refuse new records rather than silently discarding decision history.',
  'Comparison uses the last explicitly approved body, not the previous observation. Legacy approval bodies can be unavailable. Comparison is descriptive and does not establish safe or compatible behavior.',
] as const);
export const MCP_TOOL_CONTRACT_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'tool-contract-invalid': 'This tool-contract record could not be verified.',
  'tool-contract-limit':
    'The tool-contract storage or capture limit was reached. No empty listing is inferred.',
  'tool-contract-unsupported':
    'This tool contract or connection is not supported by the review gate.',
  'tool-contract-unavailable':
    'Tool-contract records are unavailable. No approval state is inferred.',
  'tool-contract-stale':
    'The connection, capture or decision changed. Refresh and review the current version.',
  'tool-contract-write-unconfirmed':
    'The decision acknowledgement could not be verified. Recheck this exact tool before another action.',
  'tool-contract-lock-timeout': 'Tool-contract storage is busy. Recheck before another action.',
});
export interface McpToolContractTool {
  id: string;
  name: string;
  sha256: string;
  contract: string;
  decision: 'pending' | 'approved' | 'revoked';
  previousApprovedContract: string | null;
  comparison: McpToolContractComparison;
}
export interface McpToolContractRegistration {
  id: string;
  name: string;
  agent: 'claude-code' | 'claude-desktop' | 'cursor';
  scope: 'project' | 'user';
  registrationSha256: string;
  bindingId: string;
  revision: string | null;
  status: 'none' | 'complete' | 'incomplete';
  reason: null | 'listing-invalidated';
  captureSha256: string | null;
  observedAt: string | null;
  tools: McpToolContractTool[];
  history: { action: 'approve' | 'revoke'; toolId: string; contractSha256: string; at: string }[];
}
export interface McpToolContractState {
  schema: 'stroq-mcp-tool-contracts/1';
  workspaceId: string;
  generatedAt: string;
  available: boolean;
  reason: null | 'runtime-unavailable' | 'storage-unavailable' | 'context-unavailable';
  registrations: McpToolContractRegistration[];
  gaps: ('source-unavailable' | 'source-limit')[];
  limitations: string[];
}
export interface McpToolContractDecisionRequest {
  action: 'approve' | 'revoke';
  bindingId: string;
  expectedRevision: string;
  expectedCaptureSha256: string;
  toolId: string;
  expectedContractSha256: string;
}
interface DecisionIdentity extends McpToolContractDecisionRequest {
  workspaceId: string;
  registrationId: string;
  registrationSha256: string;
}
export interface McpToolContractPreview extends DecisionIdentity {
  schema: 'stroq-mcp-tool-contract-preview/1';
  id: string;
  createdAt: string;
  expiresAt: string;
  tool: {
    name: string;
    contract: string;
    previousApprovedContract: string | null;
    comparison: McpToolContractComparison;
  };
  hostEnforcement: false;
}
export interface McpToolContractReceipt extends DecisionIdentity {
  schema: 'stroq-mcp-tool-contract-receipt/1';
  previewId: string;
  completedAt: string;
  revision: string;
  hostEnforcement: false;
}
export interface McpToolContractApplyRequest {
  previewId: string;
  confirm: true;
  acknowledgeContract: true;
  acknowledgeCallLimits: true;
}
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const identifier = (v: unknown, prefix: 'workspace' | 'item' | 'binding' | 'tool') =>
  typeof v === 'string' &&
  new RegExp(`^${prefix}-[a-f0-9]{${prefix === 'workspace' || prefix === 'item' ? 24 : 64}}$`).test(
    v,
  );
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const nullableHash = (v: unknown) => v === null || hash(v);
const nullableStamp = (v: unknown) => v === null || stamp(v);
const toolName = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(v);
function contract(v: unknown, name: string): v is string {
  if (typeof v !== 'string' || v.length === 0 || new TextEncoder().encode(v).byteLength > 65_536)
    return false;
  try {
    const value: unknown = JSON.parse(v);
    if (
      !closed(value, [
        'name',
        'title',
        'description',
        'inputSchema',
        'outputSchema',
        'annotations',
        '_meta',
        'icons',
        'execution',
      ]) ||
      value.name !== name ||
      !toolName(name) ||
      !closed(value.inputSchema, Object.keys(value.inputSchema as object)) ||
      (value.inputSchema.type !== undefined && value.inputSchema.type !== 'object') ||
      JSON.stringify(value) !== v
    )
      return false;
    if (
      ['title', 'description'].some(
        (key) => Object.hasOwn(value, key) && typeof value[key] !== 'string',
      )
    )
      return false;
    if (
      ['outputSchema', 'annotations', '_meta', 'execution'].some(
        (key) =>
          Object.hasOwn(value, key) && !closed(value[key], Object.keys(value[key] as object)),
      )
    )
      return false;
    if (Object.hasOwn(value, 'icons') && !Array.isArray(value.icons)) return false;
    const pending: [unknown, number][] = [[value, 0]];
    let nodes = 0;
    while (pending.length) {
      const [part, depth] = pending.pop()!;
      if (++nodes > 20_000 || depth > 32) return false;
      if (part !== null && typeof part === 'object') {
        if (
          !Array.isArray(part) &&
          Object.keys(part).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))
        )
          return false;
        for (const child of Object.values(part)) pending.push([child, depth + 1]);
      }
    }
    return true;
  } catch {
    return false;
  }
}
function tool(v: unknown): v is McpToolContractTool {
  return (
    exact(v, [
      'id',
      'name',
      'sha256',
      'contract',
      'decision',
      'previousApprovedContract',
      'comparison',
    ]) &&
    identifier(v.id, 'tool') &&
    toolName(v.name) &&
    hash(v.sha256) &&
    contract(v.contract, v.name) &&
    member(v.decision, ['pending', 'approved', 'revoked']) &&
    (v.previousApprovedContract === null || contract(v.previousApprovedContract, v.name)) &&
    comparison(v.comparison, v.contract, v.previousApprovedContract, v.sha256)
  );
}
function comparison(
  value: unknown,
  current: string,
  previous: string | null,
  currentSha: string,
): value is McpToolContractComparison {
  if (
    !exact(value, ['status', 'baselineSha256', 'baselineApprovedAt', 'counts', 'changes']) ||
    !nullableHash(value.baselineSha256) ||
    !nullableStamp(value.baselineApprovedAt) ||
    (value.baselineSha256 === null) !== (value.baselineApprovedAt === null) ||
    (previous !== null && value.baselineSha256 === null)
  )
    return false;
  const expected = compareMcpToolContract(
    current,
    previous,
    value.baselineSha256 === null
      ? null
      : { sha256: value.baselineSha256 as string, approvedAt: value.baselineApprovedAt as string },
  );
  if (
    value.status !== expected.status ||
    !Array.isArray(value.changes) ||
    value.changes.length !== expected.changes.length
  )
    return false;
  if (expected.status === 'unchanged' && value.baselineSha256 !== currentSha) return false;
  if (expected.status === 'changed' && value.baselineSha256 === currentSha) return false;
  if (
    expected.counts === null
      ? value.counts !== null
      : !exact(value.counts, ['added', 'changed', 'removed']) ||
        value.counts.added !== expected.counts.added ||
        value.counts.changed !== expected.counts.changed ||
        value.counts.removed !== expected.counts.removed
  )
    return false;
  return value.changes.every(
    (row, i) =>
      exact(row, ['path', 'kind']) &&
      row.path === expected.changes[i]?.path &&
      row.kind === expected.changes[i]?.kind,
  );
}
export function validateMcpToolContractRegistration(v: unknown): v is McpToolContractRegistration {
  if (
    !exact(v, [
      'id',
      'name',
      'agent',
      'scope',
      'registrationSha256',
      'bindingId',
      'revision',
      'status',
      'reason',
      'captureSha256',
      'observedAt',
      'tools',
      'history',
    ]) ||
    !identifier(v.id, 'item') ||
    !text(v.name, 200) ||
    !member(v.agent, ['claude-code', 'claude-desktop', 'cursor']) ||
    !member(v.scope, ['project', 'user']) ||
    !hash(v.registrationSha256) ||
    !identifier(v.bindingId, 'binding') ||
    !nullableHash(v.revision) ||
    !member(v.status, ['none', 'complete', 'incomplete']) ||
    !(v.reason === null || v.reason === 'listing-invalidated') ||
    !nullableHash(v.captureSha256) ||
    !nullableStamp(v.observedAt) ||
    !list(v.tools, 256, tool) ||
    !list(
      v.history,
      1024,
      (row): row is McpToolContractRegistration['history'][number] =>
        exact(row, ['action', 'toolId', 'contractSha256', 'at']) &&
        member(row.action, ['approve', 'revoke']) &&
        identifier(row.toolId, 'tool') &&
        hash(row.contractSha256) &&
        stamp(row.at),
    )
  )
    return false;
  if (
    new Set(v.tools.map((row) => row.id)).size !== v.tools.length ||
    new Set(v.tools.map((row) => row.name)).size !== v.tools.length
  )
    return false;
  for (const candidate of v.tools) {
    const event = v.history.findLast((row) => row.toolId === candidate.id);
    const expected =
      event?.contractSha256 === candidate.sha256
        ? event.action === 'approve'
          ? 'approved'
          : 'revoked'
        : 'pending';
    if (candidate.decision !== expected) return false;
    const approved = v.history.findLast(
      (row) => row.toolId === candidate.id && row.action === 'approve',
    );
    if (
      candidate.comparison.baselineSha256 !== (approved?.contractSha256 ?? null) ||
      candidate.comparison.baselineApprovedAt !== (approved?.at ?? null)
    )
      return false;
  }
  if (v.status === 'none')
    return (
      v.revision === null &&
      v.captureSha256 === null &&
      v.observedAt === null &&
      v.reason === null &&
      v.tools.length === 0 &&
      v.history.length === 0
    );
  if (!hash(v.revision)) return false;
  if (v.status === 'complete')
    return hash(v.captureSha256) && stamp(v.observedAt) && v.reason === null;
  return v.reason === 'listing-invalidated';
}
export function validateMcpToolContractState(v: unknown): v is McpToolContractState {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'generatedAt',
      'available',
      'reason',
      'registrations',
      'gaps',
      'limitations',
    ]) ||
    v.schema !== 'stroq-mcp-tool-contracts/1' ||
    !identifier(v.workspaceId, 'workspace') ||
    !stamp(v.generatedAt) ||
    typeof v.available !== 'boolean' ||
    !(
      v.reason === null ||
      member(v.reason, ['runtime-unavailable', 'storage-unavailable', 'context-unavailable'])
    ) ||
    !list(v.registrations, 128, validateMcpToolContractRegistration) ||
    !Array.isArray(v.gaps) ||
    v.gaps.length > 2 ||
    !v.gaps.every((code) => member(code, ['source-unavailable', 'source-limit'])) ||
    new Set(v.gaps).size !== v.gaps.length ||
    !Array.isArray(v.limitations) ||
    v.limitations.length !== MCP_TOOL_CONTRACT_LIMITATIONS.length ||
    !v.limitations.every((line, i) => line === MCP_TOOL_CONTRACT_LIMITATIONS[i])
  )
    return false;
  if (
    new Set(v.registrations.map((row) => row.id)).size !== v.registrations.length ||
    new Set(v.registrations.map((row) => row.bindingId)).size !== v.registrations.length
  )
    return false;
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > 524_288) return false;
  return v.available ? v.reason === null : v.reason !== null && v.registrations.length === 0;
}
const identityKeys = [
  'action',
  'workspaceId',
  'registrationId',
  'registrationSha256',
  'bindingId',
  'expectedRevision',
  'expectedCaptureSha256',
  'toolId',
  'expectedContractSha256',
];
function identity(v: Record<string, unknown>) {
  return (
    member(v.action, ['approve', 'revoke']) &&
    identifier(v.workspaceId, 'workspace') &&
    identifier(v.registrationId, 'item') &&
    hash(v.registrationSha256) &&
    identifier(v.bindingId, 'binding') &&
    hash(v.expectedRevision) &&
    hash(v.expectedCaptureSha256) &&
    identifier(v.toolId, 'tool') &&
    hash(v.expectedContractSha256)
  );
}
export function validateMcpToolContractPreview(v: unknown): v is McpToolContractPreview {
  return (
    exact(v, [
      'schema',
      'id',
      'createdAt',
      'expiresAt',
      'tool',
      'hostEnforcement',
      ...identityKeys,
    ]) &&
    v.schema === 'stroq-mcp-tool-contract-preview/1' &&
    identity(v) &&
    uuid(v.id) &&
    stamp(v.createdAt) &&
    stamp(v.expiresAt) &&
    Date.parse(v.expiresAt) > Date.parse(v.createdAt) &&
    Date.parse(v.expiresAt) <= Date.parse(v.createdAt) + 120_000 &&
    v.hostEnforcement === false &&
    exact(v.tool, ['name', 'contract', 'previousApprovedContract', 'comparison']) &&
    toolName(v.tool.name) &&
    contract(v.tool.contract, v.tool.name) &&
    (v.tool.previousApprovedContract === null ||
      contract(v.tool.previousApprovedContract, v.tool.name)) &&
    comparison(
      v.tool.comparison,
      v.tool.contract,
      v.tool.previousApprovedContract,
      v.expectedContractSha256 as string,
    )
  );
}
export function validateMcpToolContractReceipt(v: unknown): v is McpToolContractReceipt {
  return (
    exact(v, [
      'schema',
      'previewId',
      'completedAt',
      'revision',
      'hostEnforcement',
      ...identityKeys,
    ]) &&
    v.schema === 'stroq-mcp-tool-contract-receipt/1' &&
    identity(v) &&
    uuid(v.previewId) &&
    stamp(v.completedAt) &&
    hash(v.revision) &&
    v.revision !== v.expectedRevision &&
    v.hostEnforcement === false
  );
}
