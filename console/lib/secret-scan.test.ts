import { describe, expect, it } from 'vitest';
import {
  SECRET_LIMITATIONS,
  validateSecretJob,
  validateSecretPreview,
  validateSecretReport,
  validateSecretState,
} from './secret-scan';
// @ts-expect-error The read-only engine projection is JavaScript outside the Next source tree.
import { projectSecretReport } from '../scripts/secret-scan-safe.mjs';

const AT = '2026-10-23T01:00:00.000Z';
const FINISHED = '2026-10-23T01:00:01.000Z';
const ID = '92371fb6-f288-4847-b435-a6b3773301e4';
const OTHER_ID = '0e0290a0-d375-4668-9a99-1c1ef6fe4270';
const engine = { available: true, version: '0.28.0' };
const report = () => ({
  schema: 'stroq-secret-scan-report/1',
  source: 'local',
  scope: 'project',
  checkedAt: AT,
  evidence: 'recorded-transcripts',
  complete: true,
  sessions: { total: 1, claudeCode: 1, codex: 0, cursor: 0, skipped: 0 },
  keys: {
    compared: 1,
    sourceFiles: 1,
    environment: 0,
    unreadableFiles: 0,
    partialFiles: 0,
    skippedFiles: 0,
    rejectedLines: 0,
    truncated: false,
  },
  totals: {
    findings: 1,
    external: 1,
    uncertain: 0,
    modelVisible: 0,
    ownService: 0,
    reportedStopped: 0,
  },
  findings: [
    {
      id: 'credential-1',
      provider: 'Other',
      source: 'project-env-file',
      tier: 'third_party',
      route: 'command',
      agent: 'claude-code',
      at: AT,
      occurrences: 1,
      sessions: 1,
      seen: 1,
      reportedStopped: true,
      wouldBe: null,
      canary: false,
      laterNetworkCommands: 0,
    },
  ],
  omittedFindings: 0,
  notChecked: [],
  limitations: [...SECRET_LIMITATIONS],
});
const running = () => ({
  schema: 'stroq-secrets-job/1',
  id: ID,
  scope: 'project',
  status: 'running',
  startedAt: AT,
});
const preview = () => ({
  schema: 'stroq-secrets-preview/1',
  id: ID,
  scope: 'project',
  createdAt: AT,
  expiresAt: '2026-10-23T01:02:00.000Z',
  engineVersion: '0.28.0',
  canStart: true,
  reason: null,
  disclosure: {
    credentialValuesInMemoryOnly: true,
    readsHomeCredentialFiles: true,
    readsEnvironmentCredentials: true,
    readsProjectEnvFiles: true,
    readsProjectAncestorEnvFiles: true,
    readsRelatedSessionEnvFiles: true,
    followsCredentialFileSymlinks: true,
    readsRegisteredCanaryFiles: true,
    readsAgentAndGitMetadata: true,
    readsReferencedSavedOutputs: true,
    readsSelectedProjectTranscripts: true,
    enumeratesSessionMetadata: true,
    readsCursorStoreForDiscovery: true,
    externalRequests: false,
    writesCredentials: false,
    deadlineMs: 120_000,
    heapLimitMiB: 256,
  },
});

describe('secret scan report boundary', () => {
  it('accepts the real safe projection without returning scanner metadata', () => {
    const value = projectSecretReport(
      {
        schema: 'stroq-sent/2',
        scope: 'project',
        checked: AT,
        complete: true,
        sessions: { total: 1, agents: { codex: { sessions: 1 } } },
        keys: { compared: 1, env: 0, unreadable: 0, files: ['/PRIVATE/.env'] },
        findings: [
          {
            name: 'PRIVATE_NAME',
            source: '/PRIVATE/.env',
            provider: 'PRIVATE_PROVIDER',
            tier: 'third_party',
            times: 1,
            sessions: 1,
            seen: 1,
            at: AT,
            session: { agent: 'codex', id: 'PRIVATE_SESSION' },
            place: { tier: 'third_party', route: 'command', host: 'PRIVATE_HOST' },
          },
        ],
        notChecked: [],
      },
      'project',
    );
    expect(validateSecretReport(value)).toBe(true);
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  });

  it('preserves a reported stop as transcript evidence without certifying enforcement', () => {
    expect(validateSecretReport(report())).toBe(true);
    expect(validateSecretReport({ ...report(), evidence: 'verified-host-blocking' })).toBe(false);
    expect(validateSecretReport({ ...report(), hostBlocked: true })).toBe(false);
    const value = report();
    value.findings[0]!.reportedStopped = false;
    expect(validateSecretReport(value)).toBe(true);
  });

  it('rejects credential values and raw metadata at every report level', () => {
    for (const field of ['value', 'name', 'host', 'path', 'sessionId', 'command', 'url']) {
      const value = report();
      expect(validateSecretReport({ ...value, [field]: 'PRIVATE' })).toBe(false);
      expect(
        validateSecretReport({
          ...value,
          findings: [{ ...value.findings[0], [field]: 'PRIVATE' }],
        }),
      ).toBe(false);
    }
    const value = report();
    expect(validateSecretReport({ ...value, keys: { ...value.keys, files: ['PRIVATE'] } })).toBe(
      false,
    );
    expect(
      validateSecretReport({ ...value, sessions: { ...value.sessions, paths: ['PRIVATE'] } }),
    ).toBe(false);
  });

  it('accepts only fixed safe labels and exact limitation text', () => {
    for (const field of ['id', 'provider', 'source', 'tier', 'route', 'agent', 'wouldBe']) {
      const value = report();
      expect(
        validateSecretReport({
          ...value,
          findings: [{ ...value.findings[0], [field]: 'PRIVATE' }],
        }),
      ).toBe(false);
    }
    expect(validateSecretReport({ ...report(), limitations: ['PRIVATE'] })).toBe(false);
    expect(
      validateSecretReport({ ...report(), limitations: [...SECRET_LIMITATIONS].reverse() }),
    ).toBe(false);
    expect(validateSecretReport({ ...report(), notChecked: ['PRIVATE'] })).toBe(false);
  });

  it('requires bounded safe counts and coherent exclusive tier totals', () => {
    const value = report();
    for (const count of [-1, 1.5, Infinity, NaN, 1_000_000_001, '1']) {
      expect(validateSecretReport({ ...value, keys: { ...value.keys, compared: count } })).toBe(
        false,
      );
    }
    expect(validateSecretReport({ ...value, totals: { ...value.totals, external: 0 } })).toBe(
      false,
    );
    expect(validateSecretReport({ ...value, keys: { ...value.keys, compared: 0 } })).toBe(false);
    expect(validateSecretReport({ ...value, sessions: { ...value.sessions, total: 2 } })).toBe(
      false,
    );
    expect(
      validateSecretReport({
        ...value,
        scope: 'last',
        sessions: { ...value.sessions, total: 2, codex: 1 },
      }),
    ).toBe(false);
  });

  it('preserves incomplete scope evidence and bounds detail omission', () => {
    const value = report();
    expect(validateSecretReport({ ...value, scope: 'machine' })).toBe(false);
    expect(validateSecretReport({ ...value, complete: true, notChecked: ['no-sessions'] })).toBe(
      false,
    );
    expect(validateSecretReport({ ...value, complete: false, notChecked: ['no-sessions'] })).toBe(
      true,
    );
    expect(
      validateSecretReport({
        ...value,
        complete: false,
        notChecked: ['no-sessions', 'no-sessions'],
      }),
    ).toBe(false);
    const omitted = {
      ...value,
      complete: false,
      omittedFindings: 1,
      keys: { ...value.keys, compared: 2 },
      totals: { ...value.totals, findings: 2, uncertain: 1 },
    };
    expect(validateSecretReport(omitted)).toBe(true);
    expect(validateSecretReport({ ...omitted, complete: true })).toBe(false);
    expect(validateSecretReport({ ...omitted, omittedFindings: 0 })).toBe(false);
    expect(validateSecretReport({ ...value, findings: Array(201).fill(value.findings[0]) })).toBe(
      false,
    );
  });

  it('refuses complete status when credential or session coverage is partial', () => {
    const value = report();
    const partials = [
      { ...value, sessions: { ...value.sessions, total: 0, claudeCode: 0 } },
      { ...value, sessions: { ...value.sessions, skipped: 1 } },
      ...['unreadableFiles', 'partialFiles', 'skippedFiles', 'rejectedLines'].map((key) => ({
        ...value,
        keys: { ...value.keys, [key]: 1 },
      })),
      { ...value, keys: { ...value.keys, truncated: true } },
    ];
    for (const partial of partials) {
      expect(validateSecretReport(partial)).toBe(false);
      expect(validateSecretReport({ ...partial, complete: false })).toBe(true);
    }
  });

  it('requires canonical ISO dates and every required public field', () => {
    for (const checkedAt of ['2026-02-30T01:00:00.000Z', '2026-10-23', 'PRIVATE', null]) {
      expect(validateSecretReport({ ...report(), checkedAt })).toBe(false);
    }
    for (const key of Object.keys(report())) {
      const value: Record<string, unknown> = report();
      delete value[key];
      expect(validateSecretReport(value)).toBe(false);
    }
  });
});

describe('secret scan job lifecycle', () => {
  it('requires completed reports to match the chosen scope and terminal timestamps', () => {
    const value = { ...running(), status: 'completed', finishedAt: FINISHED, result: report() };
    expect(validateSecretJob(value)).toBe(true);
    expect(validateSecretJob({ ...value, scope: 'last' })).toBe(false);
    expect(validateSecretJob({ ...value, finishedAt: '2026-10-22T01:00:00.000Z' })).toBe(false);
    expect(validateSecretJob({ ...value, error: 'scan-failed' })).toBe(false);
    expect(validateSecretJob({ ...value, result: { ...report(), value: 'PRIVATE' } })).toBe(false);
  });

  it('keeps running and cancelled jobs free of partial results and raw errors', () => {
    expect(validateSecretJob(running())).toBe(true);
    expect(validateSecretJob({ ...running(), result: report() })).toBe(false);
    expect(validateSecretJob({ ...running(), finishedAt: FINISHED })).toBe(false);
    expect(validateSecretJob({ ...running(), error: 'scan-failed' })).toBe(false);
    const value = { ...running(), status: 'cancelled', finishedAt: FINISHED };
    expect(validateSecretJob(value)).toBe(true);
    expect(validateSecretJob({ ...value, result: report() })).toBe(false);
    expect(validateSecretJob({ ...value, error: 'PRIVATE /raw/command' })).toBe(false);
  });

  it('allows only sanitized failure codes and canonical job identifiers', () => {
    const value = { ...running(), status: 'failed', finishedAt: FINISHED, error: 'scan-failed' };
    expect(validateSecretJob(value)).toBe(true);
    expect(validateSecretJob({ ...value, error: 'PRIVATE /raw/command' })).toBe(false);
    expect(validateSecretJob({ ...value, error: undefined })).toBe(false);
    expect(validateSecretJob({ ...value, id: '../private' })).toBe(false);
    expect(validateSecretJob({ ...value, path: 'PRIVATE' })).toBe(false);
  });

  it('bounds retained jobs and permits only one active scan with unique IDs', () => {
    const value = { schema: 'stroq-secrets/1', engine, jobs: [running()] };
    expect(validateSecretState(value)).toBe(true);
    expect(validateSecretState({ ...value, jobs: [running(), running()] })).toBe(false);
    expect(
      validateSecretState({ ...value, jobs: [running(), { ...running(), id: OTHER_ID }] }),
    ).toBe(false);
    expect(validateSecretState({ ...value, jobs: Array(9).fill(running()) })).toBe(false);
    expect(validateSecretState({ ...value, engine: { ...engine, command: 'PRIVATE' } })).toBe(
      false,
    );
    expect(validateSecretState({ ...value, credentials: [] })).toBe(false);
  });
});

describe('explicit secret scan preview', () => {
  it('requires disclosure of local credential and transcript reads', () => {
    const value = preview();
    expect(validateSecretPreview(value)).toBe(true);
    for (const field of Object.keys(value.disclosure)) {
      expect(
        validateSecretPreview({
          ...value,
          disclosure: {
            ...value.disclosure,
            [field]: !value.disclosure[field as keyof typeof value.disclosure],
          },
        }),
      ).toBe(false);
      const disclosure: Record<string, unknown> = { ...value.disclosure };
      delete disclosure[field];
      expect(validateSecretPreview({ ...value, disclosure })).toBe(false);
    }
    expect(
      validateSecretPreview({ ...value, disclosure: { ...value.disclosure, path: 'PRIVATE' } }),
    ).toBe(false);
  });

  it('binds availability and exact two-minute lifetime without arbitrary paths', () => {
    const value = preview();
    expect(
      validateSecretPreview({
        ...value,
        canStart: false,
        engineVersion: null,
        reason: 'engine-unavailable',
      }),
    ).toBe(true);
    expect(validateSecretPreview({ ...value, canStart: false })).toBe(false);
    expect(validateSecretPreview({ ...value, engineVersion: null })).toBe(false);
    expect(validateSecretPreview({ ...value, expiresAt: AT })).toBe(false);
    expect(validateSecretPreview({ ...value, expiresAt: '2026-10-23T01:05:00.000Z' })).toBe(false);
    expect(validateSecretPreview({ ...value, scope: 'machine' })).toBe(false);
    expect(validateSecretPreview({ ...value, project: '/PRIVATE' })).toBe(false);
  });
});
