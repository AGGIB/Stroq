import { stableStringify } from '@stroq/core';
import { stateMac } from '../state-mac.js';
import {
  contractHash,
  contractRecord,
  exactContractKeys,
  parseToolContractJson,
} from './tool-contract-canonical.js';
import { validateToolContractBinding } from './tool-contract-binding.js';
import { boundContractCapture } from './tool-contract-capture.js';
import { decodeApprovedBaselines } from './tool-contract-baselines.js';
import {
  contractError,
  TOOL_CONTRACT_LIMITS as LIMIT,
  type ToolContractEvent,
  type ToolContractRecord,
} from './tool-contract-types.js';

export { boundContractCapture } from './tool-contract-capture.js';

const SCHEMA: ToolContractRecord['schema'] = 'stroq-mcp-tool-contracts/3';
/** What a Stroq before signed records wrote. Nothing in such a record is trusted. */
const UNSIGNED_SCHEMAS: readonly unknown[] = [
  'stroq-mcp-tool-contracts/1',
  'stroq-mcp-tool-contracts/2',
];
const MAC_DOMAIN = 'mcp-tool-contract-record';

/**
 * The exact bytes of a record on disk: the record with a `mac` beside it, an HMAC under the home's
 * state key (`state-mac.ts`) over the record without it. A process that can write the file but does not
 * hold the key cannot approve a tool by rewriting it: the reader re-encodes under the same key and
 * compares bytes, so a plain digest or another key's tag does not decode. Tamper-evident, not a
 * boundary: a process of the same user that can read `<home>/keys`, or write a key of its own there,
 * can still sign (`state-mac.ts`). Nor is it rollback
 * protection on its own: a writer that kept an older record this home signed can put it back, and it
 * verifies. The `sequence` inside the signed body lets a running store refuse a record older than one
 * it has already accepted (`tool-contracts.ts`); a process that starts after the old record was put back
 * has nothing to compare it with and accepts it.
 */
export function encodeContractRecord(record: ToolContractRecord, key: Buffer): Buffer {
  const body = stableStringify(record);
  return Buffer.from(stableStringify({ ...record, mac: stateMac(key, MAC_DOMAIN, body) }) + '\n');
}

const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/**
 * The record, or `null` for a record written before records were signed (version 1 or 2), which
 * counts as absent: none of its approvals or baselines are used, and the next listing replaces it.
 * A signed record that does not verify under `key`, or one found when this home has no key, is
 * refused as `tool-contract-invalid` and never treated as absent, so it is not overwritten either.
 */
export function decodeContractRecord(bytes: Buffer, key: Buffer | null): ToolContractRecord | null {
  const signed = parseToolContractJson(bytes, LIMIT.recordBytes);
  if (!contractRecord(signed)) return contractError('tool-contract-invalid');
  if (UNSIGNED_SCHEMAS.includes(signed.schema)) return null;
  const { mac, ...v } = signed;
  if (signed.schema !== SCHEMA || !contractHash(mac) || key === null)
    return contractError('tool-contract-invalid');
  if (!bytes.equals(encodeContractRecord(v as unknown as ToolContractRecord, key)))
    contractError('tool-contract-invalid');
  if (
    Object.keys(v).length !== 9 ||
    !exactContractKeys(v, [
      'schema',
      'sequence',
      'binding',
      'observedAt',
      'observation',
      'capture',
      'approvals',
      'history',
      'approvedBaselines',
    ]) ||
    typeof v.sequence !== 'number' ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 1 ||
    !validateToolContractBinding(v.binding) ||
    !iso(v.observedAt) ||
    typeof v.observation !== 'string' ||
    !['complete', 'invalidated'].includes(v.observation)
  )
    contractError('tool-contract-invalid');
  if (v.capture !== null) {
    if (
      !contractRecord(v.capture) ||
      Object.keys(v.capture).length !== 2 ||
      !exactContractKeys(v.capture, ['sha256', 'tools']) ||
      !contractHash(v.capture.sha256) ||
      !Array.isArray(v.capture.tools)
    )
      contractError('tool-contract-invalid');
    const contracts = v.capture.tools.map((tool) => {
      if (
        !contractRecord(tool) ||
        Object.keys(tool).length !== 4 ||
        !exactContractKeys(tool, ['id', 'name', 'sha256', 'contract'])
      )
        return contractError('tool-contract-invalid');
      return tool.contract;
    });
    const fresh = boundContractCapture(v.binding, { tools: contracts });
    if (stableStringify(fresh) !== stableStringify(v.capture))
      contractError('tool-contract-invalid');
  } else if (v.observation === 'complete') contractError('tool-contract-invalid');
  if (
    !Array.isArray(v.approvals) ||
    v.approvals.length > LIMIT.tools ||
    !Array.isArray(v.history) ||
    v.history.length > LIMIT.history
  )
    contractError('tool-contract-invalid');
  const seen = new Set<string>();
  for (const a of v.approvals) {
    if (
      !contractRecord(a) ||
      Object.keys(a).length !== 4 ||
      !exactContractKeys(a, ['toolId', 'contractSha256', 'approved', 'decidedAt']) ||
      typeof a.toolId !== 'string' ||
      !/^tool-[a-f0-9]{64}$/.test(a.toolId) ||
      !contractHash(a.contractSha256) ||
      typeof a.approved !== 'boolean' ||
      !iso(a.decidedAt) ||
      seen.has(a.toolId)
    )
      contractError('tool-contract-invalid');
    seen.add(a.toolId);
  }
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of v.history) {
    if (
      !contractRecord(event) ||
      Object.keys(event).length !== 4 ||
      !exactContractKeys(event, ['action', 'toolId', 'contractSha256', 'at']) ||
      typeof event.action !== 'string' ||
      !['approve', 'revoke'].includes(event.action) ||
      typeof event.toolId !== 'string' ||
      !/^tool-[a-f0-9]{64}$/.test(event.toolId) ||
      !contractHash(event.contractSha256) ||
      !iso(event.at)
    )
      contractError('tool-contract-invalid');
    latest.set(event.toolId, event);
  }
  if (latest.size !== v.approvals.length) contractError('tool-contract-invalid');
  for (const a of v.approvals) {
    const event = latest.get(a.toolId);
    if (
      !event ||
      event.contractSha256 !== a.contractSha256 ||
      event.at !== a.decidedAt ||
      (event.action === 'approve') !== a.approved
    )
      contractError('tool-contract-invalid');
  }
  const history = v.history as unknown as readonly ToolContractEvent[];
  return {
    ...(v as unknown as ToolContractRecord),
    approvedBaselines: decodeApprovedBaselines(v.approvedBaselines, v.binding, history),
  };
}
