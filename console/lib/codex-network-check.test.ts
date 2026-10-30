import { describe, expect, it } from 'vitest';
import {
  validateCodexNetworkCheckBinding,
  validateCodexNetworkCheckResult,
  validateCodexNetworkCheckPreview,
  validateCodexNetworkCheckJob,
  validateCodexNetworkCheckState,
} from './codex-network-check';
const sha = 'a'.repeat(64),
  at = '2026-10-26T12:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = () => ({
  workspaceId: 'workspace-' + 'a'.repeat(24),
  controlContextId: 'codex-context-' + sha,
  captureSha256: sha,
  configSha256: null,
  runtimeSha256: sha,
  nativeBinarySha256: sha,
  sourceGraphSha256: sha,
  profileCopySha256: sha,
  suiteSha256: sha,
  copyKind: 'profile',
});
const result = () => ({
  scope: 'isolated-permission-copy',
  outcome: 'passed',
  nativeBinarySha256: sha,
  profileCopySha256: sha,
  suiteSha256: sha,
  nativeExitCode: 0,
  cleanupConfirmed: true,
  checks: ['tcp', 'unix'].map((id) => ({
    id,
    positiveConnections: 1,
    attempted: true,
    effect: 'denied',
    connections: 0,
    errno: 'EPERM',
  })),
  modelCalls: 0,
  providerCalls: 0,
});
const preview = () => ({
  schema: 'stroq-codex-network-check-preview/1',
  id: uuid(1),
  operationId: uuid(1),
  jobId: uuid(2),
  createdAt: at,
  expiresAt: '2026-10-26T12:02:00.000Z',
  binding: binding(),
  scope: 'isolated-permission-copy',
  changesConfiguration: false,
  retainsDerivedResults: true,
  modelCalls: 0,
  providerCalls: 0,
});
describe('Codex copied-profile network check boundaries', () => {
  it('v2 state separates a retained running record from local ownership', () => {
    const job = {
      schema: 'stroq-codex-network-check-job/1',
      id: uuid(2),
      operationId: uuid(1),
      binding: binding(),
      startedAt: at,
      finishedAt: null,
      status: 'running',
      progress: 'native',
      error: null,
      result: null,
    };
    const state = {
      schema: 'stroq-codex-network-checks/2',
      workspaceId: binding().workspaceId,
      controlContextId: binding().controlContextId,
      generatedAt: at,
      history: 'ready',
      jobs: [job],
      activeJobId: job.id,
      ownedJobId: null,
      error: null,
    };
    expect(validateCodexNetworkCheckState(state)).toBe(true);
    expect(validateCodexNetworkCheckState({ ...state, ownedJobId: job.id })).toBe(true);
    expect(
      validateCodexNetworkCheckState({
        ...state,
        ownedJobId: job.id,
        history: 'unavailable',
        error: 'codex-network-check-history-unavailable',
      }),
    ).toBe(false);
    expect(validateCodexNetworkCheckState({ ...state, ownedJobId: uuid(3) })).toBe(false);
    expect(
      validateCodexNetworkCheckState({ ...state, activeJobId: null, ownedJobId: job.id }),
    ).toBe(false);
    expect(
      validateCodexNetworkCheckState({ ...state, schema: 'stroq-codex-network-checks/1' }),
    ).toBe(false);
  });
  it('accepts explicit positive controls and kernel denials with no broader claim', () => {
    expect(validateCodexNetworkCheckBinding(binding())).toBe(true);
    expect(validateCodexNetworkCheckResult(result())).toBe(true);
    expect(validateCodexNetworkCheckPreview(preview())).toBe(true);
  });
  it('never accepts a pass from absence, timeout, failed controls or missing cleanup', () => {
    for (const patch of [
      { positiveConnections: 0 },
      { attempted: false, effect: 'unreached', errno: null },
      { effect: 'error', errno: null },
    ]) {
      const value = result();
      Object.assign(value.checks[0]!, patch);
      expect(validateCodexNetworkCheckResult(value)).toBe(false);
    }
    expect(validateCodexNetworkCheckResult({ ...result(), cleanupConfirmed: false })).toBe(false);
    expect(validateCodexNetworkCheckResult({ ...result(), nativeExitCode: 1 })).toBe(false);
  });
  it('allowed connections require attention, while reached policy failure remains visible', () => {
    const value = result();
    Object.assign(value.checks[0]!, { effect: 'allowed', connections: 1, errno: null });
    expect(validateCodexNetworkCheckResult(value)).toBe(false);
    expect(validateCodexNetworkCheckResult({ ...value, outcome: 'attention' })).toBe(true);
  });
  it('refuses arbitrary fields, external scope, nonzero model calls and reordered probes', () => {
    for (const value of [
      { ...result(), raw: '/private/path' },
      { ...result(), scope: 'current-chat' },
      { ...result(), modelCalls: 1 },
      { ...result(), checks: result().checks.reverse() },
    ])
      expect(validateCodexNetworkCheckResult(value)).toBe(false);
  });
  it('preview IDs, retention and lifetime cannot silently change authority', () => {
    for (const value of [
      { ...preview(), operationId: uuid(3) },
      { ...preview(), expiresAt: '2026-10-26T12:03:00.000Z' },
      { ...preview(), changesConfiguration: true },
      { ...preview(), command: 'sh' },
    ])
      expect(validateCodexNetworkCheckPreview(value)).toBe(false);
  });
  it('completed jobs bind result hashes exactly and running jobs cannot carry results', () => {
    const job = {
      schema: 'stroq-codex-network-check-job/1',
      id: uuid(2),
      operationId: uuid(1),
      binding: binding(),
      startedAt: at,
      finishedAt: '2026-10-26T12:00:01.000Z',
      status: 'completed',
      progress: 'cleanup',
      error: null,
      result: result(),
    };
    expect(validateCodexNetworkCheckJob(job)).toBe(true);
    expect(
      validateCodexNetworkCheckJob({
        ...job,
        result: { ...result(), profileCopySha256: 'b'.repeat(64) },
      }),
    ).toBe(false);
    expect(validateCodexNetworkCheckJob({ ...job, status: 'running', finishedAt: null })).toBe(
      false,
    );
  });
});
