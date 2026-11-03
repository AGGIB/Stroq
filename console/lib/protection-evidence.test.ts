import { describe, expect, it } from 'vitest';
import {
  SECRET_LIMITATIONS,
  validateSecretScanState,
  type SecretJob,
  type SecretReport,
  type SecretScanState,
} from './secret-scan';
import { protectionEvidenceRows } from './protection-evidence';

const WORKSPACE = 'workspace-' + 'a'.repeat(24);
const OLD = '2026-10-23T01:00:00.000Z';
const NEW = '2026-10-23T02:00:00.000Z';
const ID = '92371fb6-f288-4847-b435-a6b3773301e4';
const OTHER = '0e0290a0-d375-4668-9a99-1c1ef6fe4270';
const engine = { available: true, version: '0.28.0' };
const secretReport = (overrides: Partial<SecretReport> = {}): SecretReport => ({
  schema: 'stroq-secret-scan-report/1',
  source: 'local',
  scope: 'project',
  checkedAt: OLD,
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
    findings: 0,
    external: 0,
    uncertain: 0,
    modelVisible: 0,
    ownService: 0,
    reportedStopped: 0,
  },
  findings: [],
  omittedFindings: 0,
  notChecked: [],
  limitations: [...SECRET_LIMITATIONS],
  ...overrides,
});
const exposure = (tier: 'third_party' | 'maybe'): SecretReport => ({
  ...secretReport(),
  totals: {
    findings: 1,
    external: tier === 'third_party' ? 1 : 0,
    uncertain: tier === 'maybe' ? 1 : 0,
    modelVisible: 0,
    ownService: 0,
    reportedStopped: 0,
  },
  findings: [
    {
      id: 'credential-1',
      provider: 'Other',
      source: 'environment',
      tier,
      route: 'command',
      agent: 'claude-code',
      at: OLD,
      occurrences: 1,
      sessions: 1,
      seen: 1,
      reportedStopped: false,
      wouldBe: null,
      canary: false,
      laterNetworkCommands: 0,
    },
  ],
});
const secretJob = (result = secretReport(), overrides: Partial<SecretJob> = {}): SecretJob => ({
  schema: 'stroq-secrets-job/1',
  id: ID,
  scope: result.scope,
  status: 'completed',
  startedAt: OLD,
  finishedAt: OLD,
  result,
  ...overrides,
});
const secrets = (jobs: SecretJob[] = []): SecretScanState => ({
  schema: 'stroq-secrets/1',
  engine,
  jobs,
});
function rows(
  secretState: SecretScanState | null = secrets(),
  workspaceId: string | null = WORKSPACE,
) {
  if (secretState) expect(validateSecretScanState(secretState)).toBe(true);
  return protectionEvidenceRows({ secrets: secretState, workspaceId });
}
const selected = (items: ReturnType<typeof rows>, id: string) =>
  items.find((row) => new URL(row.href, 'https://local.invalid').searchParams.get('job') === id);

describe('protection evidence queue', () => {
  it('puts retained exposure first and keeps rows of equal priority in order', () => {
    const items = rows(
      secrets([
        secretJob(exposure('maybe'), { id: OTHER, startedAt: NEW, finishedAt: NEW }),
        secretJob(exposure('third_party')),
      ]),
    );
    expect(items[0]?.tone).toBe('red');
    expect(items[1]?.tone).toBe('orange');
  });

  it.each(['third_party', 'maybe'] as const)(
    'retains older %s credential evidence after a newer clean narrower report',
    (tier) => {
      const items = rows(
        secrets([
          secretJob(exposure(tier)),
          secretJob(secretReport({ scope: 'last', checkedAt: NEW }), {
            id: OTHER,
            startedAt: NEW,
            finishedAt: NEW,
          }),
        ]),
      );
      expect(selected(items, ID)?.tone).toBe(tier === 'third_party' ? 'red' : 'orange');
      expect(selected(items, ID)?.detail).toContain(OLD);
      expect(selected(items, ID)?.detail).toMatch(/historical.*transcript/i);
      expect(selected(items, OTHER)?.detail).toMatch(/latest related session/i);
    },
  );

  it('retains exposure after a later failure and keeps current failed attempt visible', () => {
    const failed: SecretJob = {
      schema: 'stroq-secrets-job/1',
      id: OTHER,
      scope: 'project',
      status: 'failed',
      startedAt: NEW,
      finishedAt: NEW,
      error: 'deadline-exceeded',
    };
    const items = rows(secrets([secretJob(exposure('third_party')), failed]));
    expect(selected(items, ID)?.tone).toBe('red');
    expect(selected(items, OTHER)?.title).toMatch(/did not complete/i);
    expect(selected(items, OTHER)?.detail).toContain(NEW);
  });

  it('keeps incomplete retained coverage visible after a newer complete report', () => {
    const incomplete = secretReport({ complete: false, notChecked: ['saved-outputs'] });
    const items = rows(
      secrets([
        secretJob(incomplete),
        secretJob(secretReport({ checkedAt: NEW }), { id: OTHER, startedAt: NEW, finishedAt: NEW }),
      ]),
    );
    expect(selected(items, ID)?.title).toMatch(/coverage gaps/i);
    expect(selected(items, ID)?.tone).toBe('orange');
    expect(selected(items, ID)?.detail).toMatch(/incomplete/i);
  });

  it.each(['running', 'cancelled'] as const)(
    'keeps a %s credential attempt separate from retained findings',
    (status) => {
      const attempt: SecretJob = {
        schema: 'stroq-secrets-job/1',
        id: OTHER,
        scope: 'project',
        status,
        startedAt: NEW,
        ...(status === 'cancelled' ? { finishedAt: NEW } : {}),
      };
      const items = rows(secrets([secretJob(exposure('third_party')), attempt]));
      expect(selected(items, ID)?.tone).toBe('red');
      expect(selected(items, OTHER)?.title).toMatch(
        status === 'running' ? /running/i : /cancelled/i,
      );
      expect(selected(items, OTHER)?.detail).toMatch(/no completed report/i);
    },
  );

  it('distinguishes missing state, no retained scan, and a completed scan with no matches', () => {
    const missing = rows(null);
    expect(missing.some((row) => /secret.*unavailable/i.test(row.title))).toBe(true);
    expect(missing.some((row) => /live/i.test(row.title))).toBe(false);
    expect(rows().some((row) => /seen your keys/i.test(row.title))).toBe(true);
    const clean = selected(rows(secrets([secretJob()])), ID);
    expect(clean?.tone).toBe('muted');
    expect(clean?.detail).toMatch(/does not establish/i);
  });

  it('stays quiet while the snapshots load, then names first steps without alarm', () => {
    // A first visit renders before the snapshots arrive; that is not evidence that they are missing.
    expect(
      protectionEvidenceRows({ secrets: null, workspaceId: WORKSPACE, loading: true }),
    ).toEqual([]);
    // Loaded and nothing recorded yet: a step to take, not a finding.
    const items = rows();
    const scan = items.find((row) => row.key === 'secret-never');
    expect(scan?.title).toBe('Check whether your agents have seen your keys');
    expect(scan?.tone).toBe('muted');
    expect(scan?.detail).toMatch(/no scan has been saved yet/i);
    expect(items.some((row) => row.key.startsWith('live-'))).toBe(false);
  });

  it('retains reports when the engine becomes unavailable', () => {
    const currentSecrets = {
      ...secrets([secretJob(exposure('third_party'))]),
      engine: { available: false, version: null },
    };
    const items = rows(currentSecrets);
    expect(selected(items, ID)?.detail).toMatch(/historical/i);
    expect(items.some((row) => /credential.*engine.*unavailable/i.test(row.title))).toBe(true);
  });

  it('emits only safe fixed links, even for a workspace id that is not one', () => {
    const output = rows(
      secrets([secretJob(exposure('third_party'))]),
      '../private?token=PRIVATE_AUTH',
    );
    expect(JSON.stringify(output)).not.toContain('PRIVATE_');
    expect(
      output.every((row) => new URL(row.href, 'https://local.invalid').pathname === '/keys/'),
    ).toBe(true);
    expect(output.every((row) => !row.href.includes('?'))).toBe(true);
    const valid = selected(rows(secrets([secretJob(exposure('third_party'))])), ID)!;
    const link = new URL(valid.href, 'https://local.invalid');
    expect(link.searchParams.get('workspace')).toBe(WORKSPACE);
    expect([...link.searchParams.keys()].sort()).toEqual(['job', 'workspace']);
  });

  it('is read-only, keeps stable row keys, and bounds retained report rows without adding duplicate credential totals', () => {
    const state = secrets(
      Array.from({ length: 8 }, (_, index) =>
        secretJob(exposure('third_party'), {
          id: `92371fb6-f288-4847-b435-${String(index).padStart(12, '0')}`,
        }),
      ),
    );
    const source = JSON.stringify(state);
    const first = rows(state);
    expect(JSON.stringify(state)).toBe(source);
    expect(first).toEqual(rows(state));
    expect(new Set(first.map((row) => row.key)).size).toBe(first.length);
    expect(first.filter((row) => row.tone === 'red')).toHaveLength(8);
    expect(first.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(first)).not.toMatch(/8 credentials|8 external/);
  });
});
