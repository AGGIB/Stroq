import { createHash } from 'node:crypto';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import { validateMcpGovernanceBinding } from '../lib/mcp-governance.ts';
import { exact, uuid } from '../lib/mcp-governance-validation.ts';
import { hash, stamp } from '../lib/local-guards.ts';
import type { McpGovernanceIntent } from './mcp-governance-store-types.ts';

export const GOVERNANCE_RECORDS = 32;
export const GOVERNANCE_STORE_BYTES = 8 * 1024 * 1024;
export const GOVERNANCE_RECORD_BYTES = 256 * 1024;
export const governanceHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export function governanceFail(code = 'mcp-governance-store-unavailable'): never {
  throw new Error(code);
}
export const owned = (s: { uid: number }) =>
  typeof process.getuid !== 'function' || s.uid === process.getuid();
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown) => finite(v) && Number.isSafeInteger(v);
export function directoryPin(v: unknown): boolean {
  return (
    exact(v, ['dev', 'ino', 'uid', 'mode']) &&
    Object.values(v).every(integer) &&
    (v.mode & 0o170000) === 0o40000 &&
    (v.mode & 0o022) === 0
  );
}
export function filePin(v: unknown, full = false): boolean {
  return (
    exact(v, [
      'dev',
      'ino',
      'uid',
      'mode',
      'nlink',
      'size',
      'mtimeMs',
      ...(full ? ['ctimeMs'] : []),
    ]) &&
    Object.values(v).every(finite) &&
    ['dev', 'ino', 'uid', 'mode', 'nlink', 'size'].every((k) => integer(v[k])) &&
    (v.mode & 0o170000) === 0o100000 &&
    (v.mode & 0o022) === 0 &&
    v.nlink === 1 &&
    v.size <= GOVERNANCE_RECORD_BYTES
  );
}
const parents = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.length <= 128 && v.every(directoryPin);
const history = (v: unknown) =>
  v === null || (exact(v, ['entryId', 'recordSha256']) && uuid(v.entryId) && hash(v.recordSha256));
export function validateMcpGovernanceIntent(v: unknown): v is McpGovernanceIntent {
  try {
    if (
      !exact(v, [
        'schema',
        'id',
        'operationId',
        'binding',
        'createdAt',
        'updatedAt',
        'candidateRawSha256',
        'candidateFingerprint',
        'beforePolicy',
        'phase',
        'staged',
        'historyRef',
        'terminalSource',
      ]) ||
      v.schema !== 'stroq-mcp-governance-intent/1' ||
      !uuid(v.id) ||
      !uuid(v.operationId) ||
      !validateMcpGovernanceBinding(v.binding) ||
      !stamp(v.createdAt) ||
      !stamp(v.updatedAt) ||
      v.updatedAt < v.createdAt ||
      !hash(v.candidateRawSha256) ||
      !hash(v.candidateFingerprint) ||
      !exact(v.beforePolicy, ['rawSha256', 'fingerprint', 'file', 'parents']) ||
      v.beforePolicy.rawSha256 !== v.binding.policyRawSha256 ||
      v.beforePolicy.fingerprint !== v.binding.policyFingerprint ||
      !(v.beforePolicy.rawSha256 === null
        ? v.beforePolicy.file === null
        : hash(v.beforePolicy.rawSha256) && filePin(v.beforePolicy.file, true)) ||
      !parents(v.beforePolicy.parents) ||
      !history(v.historyRef) ||
      !['prepared', 'staged', 'applied', 'not-applied'].includes(v.phase) ||
      ![null, 'apply', 'recheck'].includes(v.terminalSource)
    )
      return false;
    if (
      v.staged !== null &&
      (!exact(v.staged, ['file', 'parents', 'sha256']) ||
        !filePin(v.staged.file) ||
        !parents(v.staged.parents) ||
        v.staged.sha256 !== v.candidateRawSha256)
    )
      return false;
    if (v.phase === 'prepared') return v.staged === null && v.terminalSource === null;
    if (v.phase === 'staged') return v.staged !== null && v.terminalSource === null;
    if (v.phase === 'not-applied') return v.staged === null && v.terminalSource !== null;
    return v.staged !== null && v.terminalSource !== null;
  } catch {
    return false;
  }
}
export function parseGovernanceMetadata(bytes: Uint8Array): unknown {
  try {
    const parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed.ok) governanceFail();
    return parsed.value;
  } catch {
    governanceFail();
  }
}
