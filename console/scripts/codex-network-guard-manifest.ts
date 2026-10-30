import { closed, count, hash, stamp } from '../lib/local-guards.ts';
import {
  CONFIG_BYTES,
  UUID,
  same,
  publishedPin,
  type GuardManifest,
} from './codex-network-guard-binding.ts';
const exact = (v: unknown, k: string[]): v is Record<string, any> =>
  closed(v, k) && Reflect.ownKeys(v).length === k.length;
const pin = (v: unknown, full = false) =>
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
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
  v.nlink === 1 &&
  count(v.size, CONFIG_BYTES);
const parent = (v: unknown) =>
  exact(v, ['dev', 'ino', 'uid', 'mode']) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
const nullableName = (v: unknown) =>
  v === null ||
  (typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 2048 &&
    !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v));
export function validGuardManifest(v: unknown, id: string): v is GuardManifest {
  if (
    !exact(v, [
      'schema',
      'id',
      'operationId',
      'controlContextId',
      'rootBinding',
      'target',
      'sequence',
      'ownedKeys',
      'kind',
      'parentProfile',
      'childProfile',
      'createdAt',
      'updatedAt',
      'phase',
      'originalSha256',
      'candidateSha256',
      'beforeBytes',
      'candidateBytes',
      'mode',
      'nativeBinarySha256',
      'captureSha256',
      'sourceGraphSha256',
      'staged',
      'parents',
      'publication',
      'restoreSha256',
      'restoreStaged',
      'restorePublication',
    ])
  )
    return false;
  if (
    v.schema !== 'stroq-codex-network-record/1' ||
    v.id !== id ||
    !UUID.test(id) ||
    typeof v.operationId !== 'string' ||
    !UUID.test(v.operationId) ||
    typeof v.controlContextId !== 'string' ||
    !/^codex-context-[a-f0-9]{64}$/.test(v.controlContextId) ||
    !hash(v.rootBinding) ||
    !count(v.sequence, Number.MAX_SAFE_INTEGER) ||
    v.sequence < 1 ||
    !Array.isArray(v.ownedKeys) ||
    v.ownedKeys.length < 1 ||
    v.ownedKeys.length > 2 ||
    !v.ownedKeys.every(
      (p: unknown) =>
        Array.isArray(p) &&
        p.length > 0 &&
        p.length <= 4 &&
        p.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 2048),
    ) ||
    typeof v.target !== 'string' ||
    !v.target.startsWith('/') ||
    !v.target.endsWith('/config.toml') ||
    v.target.length > 4096 ||
    ![
      'profile-network-off',
      'profile-child',
      'legacy-network-off',
      'legacy-enable-workspace',
    ].includes(v.kind) ||
    !nullableName(v.parentProfile) ||
    !nullableName(v.childProfile) ||
    !stamp(v.createdAt) ||
    !stamp(v.updatedAt) ||
    v.updatedAt < v.createdAt ||
    !['prepared', 'guarded', 'restoring', 'restored'].includes(v.phase) ||
    !(v.originalSha256 === null || hash(v.originalSha256)) ||
    !hash(v.candidateSha256) ||
    !count(v.beforeBytes, CONFIG_BYTES) ||
    !count(v.candidateBytes, CONFIG_BYTES) ||
    !count(v.mode, 511) ||
    (v.mode & 0o022) !== 0 ||
    (v.mode & 0o200) === 0 ||
    !hash(v.nativeBinarySha256) ||
    !hash(v.captureSha256) ||
    !hash(v.sourceGraphSha256) ||
    !(v.staged === null || pin(v.staged)) ||
    !Array.isArray(v.parents) ||
    v.parents.length < 1 ||
    v.parents.length > 128 ||
    !v.parents.every(parent) ||
    !(v.publication === null || pin(v.publication, true)) ||
    !(v.restoreSha256 === null || hash(v.restoreSha256)) ||
    !(v.restoreStaged === null || pin(v.restoreStaged)) ||
    !(v.restorePublication === null || pin(v.restorePublication, true))
  )
    return false;
  if (
    v.kind === 'profile-child'
      ? v.childProfile !== `stroq-network-${id}` || v.parentProfile !== ':workspace'
      : v.childProfile !== null || v.parentProfile !== null
  )
    return false;
  if (v.phase === 'prepared')
    return v.publication === null && v.restoreStaged === null && v.restorePublication === null;
  if (v.staged === null || v.publication === null || !same(publishedPin(v.publication), v.staged))
    return false;
  if (v.phase === 'restored')
    return (
      v.restoreSha256 !== null &&
      v.restoreStaged !== null &&
      v.restorePublication !== null &&
      same(publishedPin(v.restorePublication), v.restoreStaged)
    );
  return v.restorePublication === null;
}
