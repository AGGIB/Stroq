import { lstat, opendir } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { closed, hash, stamp, text, count } from '../lib/local-guards.ts';
import { validateSkillLocation } from '../lib/skill-location.ts';
import { isCodexControlContext } from '../lib/codex-skill-controls.ts';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import {
  CONFIG_BYTES,
  UUID,
  same,
  publishedPin,
  owned,
  fail,
  type ControlManifest,
  type Root,
} from './codex-skill-control-binding.ts';
const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  closed(v, keys) && Reflect.ownKeys(v).length === keys.length;
const pinKeys = ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs'];
const validPin = (v: unknown, ctime = false) =>
  exact(v, [...pinKeys, ...(ctime ? ['ctimeMs'] : [])]) &&
  Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
  v.nlink === 1 &&
  count(v.size, CONFIG_BYTES);
const validRoot = (v: unknown) =>
  exact(v, ['dev', 'ino', 'uid', 'mode']) &&
  ['dev', 'ino', 'uid', 'mode'].every(
    (k) => typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0,
  );
export function validControlManifest(v: unknown, id: string): v is ControlManifest {
  if (
    !exact(v, [
      'schema',
      'id',
      'operationId',
      'controlContextId',
      'rootBinding',
      'target',
      'documentPath',
      'nativeName',
      'name',
      'location',
      'createdAt',
      'updatedAt',
      'phase',
      'originalSha256',
      'candidateSha256',
      'mode',
      'beforeBytes',
      'candidateBytes',
      'sourceId',
      'candidateId',
      'entrypointSha256',
      'runtimeSha256',
      'staged',
      'parents',
      'publication',
      'restoreSha256',
      'restoreStaged',
      'restorePublication',
      'removal',
    ])
  )
    return false;
  const coherent =
    (v.phase === 'prepared'
      ? v.publication === null && v.restoreStaged === null && v.restorePublication === null
      : v.staged !== null &&
        v.publication !== null &&
        validPin(v.publication, true) &&
        same(publishedPin(v.publication), v.staged)) &&
    (v.phase !== 'restored' ||
      (v.restoreSha256 === null
        ? v.restorePublication === null
        : v.restoreStaged !== null &&
          v.restorePublication !== null &&
          validPin(v.restorePublication, true) &&
          same(publishedPin(v.restorePublication), v.restoreStaged))) &&
    (v.phase !== 'restoring' || v.restorePublication === null);
  return (
    coherent &&
    v.schema === 'stroq-codex-skill-control-record/1' &&
    v.id === id &&
    UUID.test(id) &&
    typeof v.operationId === 'string' &&
    UUID.test(v.operationId) &&
    isCodexControlContext(v.controlContextId) &&
    hash(v.rootBinding) &&
    typeof v.target === 'string' &&
    v.target.length <= 4096 &&
    isAbsolute(v.target) &&
    typeof v.documentPath === 'string' &&
    v.documentPath.length <= 4096 &&
    isAbsolute(v.documentPath) &&
    text(v.nativeName, 2048) &&
    text(v.name, 200) &&
    validateSkillLocation(v.location) &&
    stamp(v.createdAt) &&
    stamp(v.updatedAt) &&
    v.updatedAt >= v.createdAt &&
    ['prepared', 'disabled', 'restoring', 'restored'].includes(v.phase) &&
    (v.originalSha256 === null || hash(v.originalSha256)) &&
    hash(v.candidateSha256) &&
    count(v.mode, 511) &&
    (v.mode & 0o022) === 0 &&
    (v.mode & 0o200) !== 0 &&
    count(v.beforeBytes, CONFIG_BYTES) &&
    count(v.candidateBytes, CONFIG_BYTES) &&
    typeof v.sourceId === 'string' &&
    /^source-[a-f0-9]{24}$/.test(v.sourceId) &&
    typeof v.candidateId === 'string' &&
    /^candidate-[a-f0-9]{24}$/.test(v.candidateId) &&
    hash(v.entrypointSha256) &&
    hash(v.runtimeSha256) &&
    (v.staged === null || validPin(v.staged)) &&
    Array.isArray(v.parents) &&
    v.parents.length <= 128 &&
    v.parents.every(validRoot) &&
    (v.publication === null || validPin(v.publication, true)) &&
    (v.restoreSha256 === null || hash(v.restoreSha256)) &&
    (v.restoreStaged === null || validPin(v.restoreStaged)) &&
    (v.restorePublication === null || validPin(v.restorePublication, true)) &&
    validRemoval(v)
  );
}
function validRemoval(v: Record<string, any>) {
  const r = v.removal;
  if (r === null)
    return (
      (v.phase !== 'restoring' && !(v.phase === 'restored' && v.restoreSha256 === null)) ||
      v.restoreSha256 !== null
    );
  if (
    !exact(r, ['directory', 'directoryPin', 'original', 'moved']) ||
    r.directory !== join(dirname(v.target), `.stroq-skill-restore-${v.operationId}.tmp`) ||
    !(
      r.directoryPin === null ||
      (exact(r.directoryPin, ['path', 'dev', 'ino', 'uid', 'mode']) &&
        r.directoryPin.path === r.directory &&
        validRoot(Object.fromEntries(Object.entries(r.directoryPin).filter(([k]) => k !== 'path'))))
    ) ||
    !validPin(r.original, true) ||
    !(r.moved === null || validPin(r.moved, true)) ||
    v.restoreSha256 !== null ||
    !['restoring', 'restored'].includes(v.phase)
  )
    return false;
  return (
    v.phase !== 'restored' ||
    (r.directoryPin !== null &&
      r.moved !== null &&
      same(publishedPin(r.original), publishedPin(r.moved)))
  );
}

/** Pending absence restore retains at most one private native-config holder; never repair on reads. */
export async function auditControlRemoval(root: Root, manifest: ControlManifest) {
  const r = manifest.removal;
  if (!r) return;
  let exists = true;
  try {
    await lstat(r.directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
    else throw e;
  }
  if (!exists) return;
  if (
    manifest.phase === 'restored' ||
    !r.directoryPin ||
    !same(await rootIdentity(r.directory), r.directoryPin) ||
    !owned(r.directoryPin) ||
    (r.directoryPin.mode & 0o777) !== 0o700
  )
    fail('codex-control-store-unavailable');
  let count = 0;
  for await (const file of await opendir(r.directory, { bufferSize: 2 })) {
    if (++count > 1 || file.name !== 'config.toml' || !file.isFile())
      fail('codex-control-store-unavailable');
    const read = await snapshotFile(root, join(r.directory, file.name), CONFIG_BYTES);
    if (!read.file || !owned(read.file) || (read.file.mode & 0o022) !== 0)
      fail('codex-control-store-unavailable');
  }
}
