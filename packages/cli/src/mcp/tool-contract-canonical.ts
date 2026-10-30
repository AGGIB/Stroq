import { createHash } from 'node:crypto';
import { stableStringify } from '@stroq/core';
import { parseStrictJson } from '../../../core/src/scope/strict-json.js';
import { findLossyJson } from '../harden/json-lossy.js';
import {
  contractError,
  TOOL_CONTRACT_LIMITS as LIMIT,
  type ContractJson,
  type ToolContractCapture,
  type ToolContractDecisionRequest,
} from './tool-contract-types.js';

export const contractSha = (domain: string, value: unknown): string =>
  createHash('sha256')
    .update(domain + '\n' + stableStringify(value))
    .digest('hex');
export const rawContractSha = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
export const contractRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const exactContractKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));
export const contractHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const contractId = (v: unknown): v is string =>
  typeof v === 'string' && /^binding-[a-f0-9]{64}$/.test(v);
/** Exactly the six fields of a decision, each in its fixed shape, and nothing else. */
export const contractDecisionRequest = (v: unknown): v is ToolContractDecisionRequest =>
  contractRecord(v) &&
  Object.keys(v).length === 6 &&
  exactContractKeys(v, [
    'bindingId',
    'expectedRevision',
    'expectedCaptureSha256',
    'toolId',
    'expectedContractSha256',
    'action',
  ]) &&
  contractId(v.bindingId) &&
  contractHash(v.expectedRevision) &&
  contractHash(v.expectedCaptureSha256) &&
  contractHash(v.expectedContractSha256) &&
  typeof v.toolId === 'string' &&
  /^tool-[a-f0-9]{64}$/.test(v.toolId) &&
  typeof v.action === 'string' &&
  ['approve', 'revoke'].includes(v.action);

/** Raw wire bytes must pass here before JSON.parse can discard duplicate keys or numeric precision. */
export function parseToolContractJson(
  raw: string | Buffer,
  maxBytes: number = LIMIT.captureBytes,
): unknown {
  if (Buffer.byteLength(raw) > maxBytes) contractError('tool-contract-limit');
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return contractError('tool-contract-invalid');
  }
  if (text.includes('\uFFFD')) contractError('tool-contract-invalid');
  const parsed = parseStrictJson(text);
  if (!parsed.ok || findLossyJson(text) !== null) contractError('tool-contract-invalid');
  return validateContractJson(
    parsed.value,
    maxBytes > LIMIT.captureBytes ? { nodes: 64_000, depth: 32 } : undefined,
  );
}

export function validateContractJson(
  value: unknown,
  limits: { nodes: number; depth: number } = { nodes: LIMIT.nodes, depth: LIMIT.depth },
): ContractJson {
  let nodes = 0;
  function visit(v: unknown, depth: number): ContractJson {
    if (++nodes > limits.nodes || depth > limits.depth) contractError('tool-contract-limit');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (
        v.includes('\uFFFD') ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)
      )
        contractError('tool-contract-invalid');
      return v;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Object.is(v, -0)) contractError('tool-contract-invalid');
      return v;
    }
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) contractError('tool-contract-invalid');
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (!d || !('value' in d)) return contractError('tool-contract-invalid');
        return visit(d.value, depth + 1);
      });
    }
    if (!contractRecord(v)) return contractError('tool-contract-invalid');
    const result: Record<string, ContractJson> = Object.create(null) as Record<
      string,
      ContractJson
    >;
    for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (
        !('value' in desc) ||
        !desc.enumerable ||
        key.includes('\uFFFD') ||
        /[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          key,
        ) ||
        ['__proto__', 'constructor', 'prototype'].includes(key)
      )
        contractError('tool-contract-invalid');
      result[key] = visit(desc.value, depth + 1);
    }
    return result;
  }
  return visit(value, 0);
}

const TOOL_KEYS = [
  'name',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'annotations',
  '_meta',
  'icons',
  'execution',
];
export function canonicalizeToolsList(value: unknown): ToolContractCapture {
  const copied = validateContractJson(value);
  if (!contractRecord(copied)) contractError('tool-contract-invalid');
  if ('nextCursor' in copied || !exactContractKeys(copied, ['tools']))
    contractError('tool-contract-unsupported');
  if (!Array.isArray(copied.tools)) contractError('tool-contract-invalid');
  if (copied.tools.length > LIMIT.tools) contractError('tool-contract-limit');
  const seen = new Set<string>();
  const tools = copied.tools
    .map((tool) => {
      if (!contractRecord(tool) || !exactContractKeys(tool, TOOL_KEYS))
        return contractError('tool-contract-unsupported');
      if (
        typeof tool.name !== 'string' ||
        tool.name.length === 0 ||
        tool.name.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(tool.name) ||
        seen.has(tool.name)
      )
        return contractError('tool-contract-invalid');
      seen.add(tool.name);
      if (
        !contractRecord(tool.inputSchema) ||
        (tool.inputSchema.type !== undefined && tool.inputSchema.type !== 'object')
      )
        return contractError('tool-contract-unsupported');
      for (const key of ['title', 'description'])
        if (tool[key] !== undefined && typeof tool[key] !== 'string')
          return contractError('tool-contract-invalid');
      for (const key of ['outputSchema', 'annotations', '_meta', 'execution'])
        if (tool[key] !== undefined && !contractRecord(tool[key]))
          return contractError('tool-contract-invalid');
      if (tool.icons !== undefined && !Array.isArray(tool.icons))
        return contractError('tool-contract-invalid');
      if (Buffer.byteLength(stableStringify(tool)) > LIMIT.toolBytes)
        return contractError('tool-contract-limit');
      const sha256 = contractSha('stroq-mcp-tool-contract/1', tool);
      return {
        id: 'tool-' + contractSha('stroq-mcp-tool-identity/1', [tool.name]),
        name: tool.name,
        sha256,
        contract: tool as Record<string, ContractJson>,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (Buffer.byteLength(stableStringify(copied)) > LIMIT.captureBytes)
    contractError('tool-contract-limit');
  // The private reader deliberately refuses numeric-key reorder as ambiguous JSON. Refuse
  // that unsupported spelling before mkdir/lock/publication, rather than writing unreadable authority.
  if (findLossyJson(stableStringify(copied)) !== null) contractError('tool-contract-unsupported');
  return {
    sha256: contractSha(
      'stroq-mcp-tools-list/1',
      tools.map((t) => [t.name, t.sha256]),
    ),
    tools,
  };
}
