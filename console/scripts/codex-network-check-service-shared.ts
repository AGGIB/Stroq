import type { CodexNetworkGuardCheckPreparation } from '../lib/codex-network-guard-check-private';
import type { CodexNetworkCheckJob, CodexNetworkCheckError } from '../lib/codex-network-check';
import type { NetworkReply } from './codex-network-service';
import type { NetworkInventory } from './codex-network-service';
import { serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import {
  validateCodexNetworkGuardCheckPreparation,
  codexNetworkGuardCheckPreparationBytes,
} from '../lib/codex-network-guard-check-private';
import { getProfileCopySha, getSuiteSha } from './codex-network-check-protocol';
import type { CodexNetworkCheckBinding } from '../lib/codex-network-check';
export type Store = {
  runs: unknown[];
  state(): { status: string };
  prepare(): Promise<boolean>;
  refresh(): Promise<unknown[] | null>;
  write(jobs: CodexNetworkCheckJob[]): Promise<boolean>;
};
export type NetworkCheckLease = { assertCurrent(): Promise<void>; release(): Promise<void> };
export async function assertNetworkCheckOwnership(
  owner: { releasing: boolean; lease: NetworkCheckLease } | null,
) {
  if (owner && !owner.releasing)
    try {
      await owner.lease.assertCurrent();
    } catch (error) {
      if (!owner.releasing) throw error;
    }
}
export function failNetworkCheckRelease(rows: CodexNetworkCheckJob[], job: CodexNetworkCheckJob) {
  const failed = (j: CodexNetworkCheckJob): CodexNetworkCheckJob => ({
    ...j,
    status: 'failed',
    error: 'codex-network-check-history-unavailable',
    result: null,
  });
  Object.assign(job, failed(job));
  return rows.map((j) =>
    j.id === job.id &&
    j.operationId === job.operationId &&
    isDeepStrictEqual(j.binding, job.binding)
      ? failed(j)
      : j,
  );
}
export type Runner = (
  input: CodexNetworkGuardCheckPreparation,
  options: { signal: AbortSignal; onProgress: (id: 'positive' | 'native' | 'cleanup') => void },
) => Promise<unknown>;
export const exact = (v: any, keys: string[]) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Reflect.ownKeys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export const failure = (error: CodexNetworkCheckError, status = 409): NetworkReply => ({
  status,
  body: { error },
});
export const invalid = (): NetworkReply => ({ status: 400, body: { error: 'invalid-request' } });
export const MAX_BYTES = 8 * 1024 * 1024;
export async function prepareNetworkCheck(
  inventory: NetworkInventory,
  selection: { controlContextId: string; captureSha256: string },
) {
  const response = await inventory.codexNetworkOperation('codex-network-check-prepare', {
    request: selection,
  });
  if (response.status !== 200)
    throw Error(
      response.body?.error === 'codex-network-busy'
        ? 'check-busy'
        : response.body?.error === 'codex-network-unsupported'
          ? 'unsupported'
          : 'native-changed',
    );
  if (
    !validateCodexNetworkGuardCheckPreparation(response.body) ||
    response.body.binding.controlContextId !== selection.controlContextId ||
    response.body.binding.captureSha256 !== selection.captureSha256 ||
    codexNetworkGuardCheckPreparationBytes(response.body) > MAX_BYTES ||
    serialize(response.body).byteLength > MAX_BYTES
  )
    throw Error('invalid-report');
  return response.body;
}
export function networkCheckBinding(
  input: CodexNetworkGuardCheckPreparation,
  workspaceId: string,
): CodexNetworkCheckBinding {
  return {
    ...input.binding,
    workspaceId,
    profileCopySha256: getProfileCopySha(input),
    suiteSha256: getSuiteSha(),
    copyKind: input.kind,
  };
}
export const code = (error: unknown): CodexNetworkCheckError => {
  const value = error instanceof Error ? error.message : '';
  return (
    (
      {
        cancelled: 'codex-network-check-cancelled',
        'deadline-exceeded': 'codex-network-check-timeout',
        'output-limit': 'codex-network-check-output-limit',
        'cleanup-failed': 'codex-network-check-cleanup-failed',
        unsupported: 'codex-network-check-unsupported',
        'native-changed': 'codex-network-check-stale',
        'invalid-report': 'codex-network-check-invalid-report',
      } as Record<string, CodexNetworkCheckError>
    )[value] ?? 'codex-network-check-unavailable'
  );
};
