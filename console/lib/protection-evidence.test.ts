import { describe, expect, it } from 'vitest';
import { AGENT_NAMES, validateAgentStatus, type AgentStatusState } from './agent-status';
import { validateLiveState, type LiveJob, type LiveReport, type LiveState } from './live-proof';
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
const THIRD = '48e0290a-d375-4668-9a99-1c1ef6fe4270';
const engine = { available: true, version: '0.28.0' };
const agents = (configured: (keyof typeof AGENT_NAMES)[] = []): AgentStatusState => ({
  schema: 'stroq-agents/1',
  source: 'local',
  generatedAt: NEW,
  agents: (Object.keys(AGENT_NAMES) as (keyof typeof AGENT_NAMES)[]).map((id) => ({
    id,
    hostVersion: null,
    scopes: (['project', 'user'] as const).map((scope) => ({
      scope,
      state: configured.includes(id) && scope === 'project' ? 'present' : 'missing',
      reason: configured.includes(id) ? 'matches-current-install' : 'hooks-missing',
      events: [],
      approval: 'not-required',
      recordedAt: null,
    })),
    observation: { scope: 'machine', lastHookAt: null, state: 'missing' },
    proof: {
      scope: 'machine',
      state: 'missing',
      checkedAt: null,
      hostVersion: null,
      freshness: 'not-checked',
      reason: 'no-live-proof',
    },
  })),
});
const report = (state: LiveReport['state'] = 'verified'): LiveReport => ({
  state,
  mode: 'live',
  hostVersion: 'PRIVATE_VERSION',
  requestsMade: 3,
  probes: [
    {
      id: 'deny',
      kind: 'deny',
      mark: state === 'verified' ? 'passed' : 'inconclusive',
      evidence: { E1: true, E2: true, E3: true, E4: true },
    },
  ],
  caveats: ['PRIVATE_CAVEAT /home/private'],
  advice: ['PRIVATE_ADVICE'],
});
const liveJob = (overrides: Partial<LiveJob> = {}): LiveJob => ({
  schema: 'stroq-live-job/1',
  id: ID,
  agent: 'claude-code',
  maxRequests: 3,
  status: 'completed',
  startedAt: OLD,
  finishedAt: OLD,
  result: report(),
  ...overrides,
});
const live = (jobs: LiveJob[] = [], overrides: Partial<LiveState> = {}): LiveState => ({
  schema: 'stroq-live/1',
  engine,
  target: 'isolated-host',
  agents: (Object.keys(AGENT_NAMES) as (keyof typeof AGENT_NAMES)[]).map((id) => ({
    id,
    supported: true,
    reason: null,
    proof: null,
  })),
  jobs,
  ...overrides,
});
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
  liveState: LiveState | null = live(),
  secretState: SecretScanState | null = secrets(),
  status: AgentStatusState | null = agents(),
  workspaceId: string | null = WORKSPACE,
) {
  if (liveState) expect(validateLiveState(liveState)).toBe(true);
  if (secretState) expect(validateSecretScanState(secretState)).toBe(true);
  if (status) expect(validateAgentStatus(status)).toBe(true);
  return protectionEvidenceRows({
    live: liveState,
    secrets: secretState,
    agents: status,
    workspaceId,
  });
}
const selected = (items: ReturnType<typeof rows>, id: string) =>
  items.find((row) => new URL(row.href, 'https://local.invalid').searchParams.get('job') === id);

describe('protection evidence queue', () => {
  it('keeps a newer failed attempt ahead of an older passing check for that agent', () => {
    const failed = liveJob({
      id: OTHER,
      startedAt: NEW,
      finishedAt: NEW,
      status: 'failed',
      error: 'PRIVATE_ERROR',
    });
    delete failed.result;
    const items = rows(live([liveJob(), failed]), secrets(), agents(['claude-code']));
    expect(selected(items, OTHER)).toMatchObject({ tone: 'orange' });
    expect(selected(items, OTHER)?.title).toMatch(/Claude Code.*failed/i);
    expect(selected(items, OTHER)?.detail).toContain(NEW);
    expect(selected(items, ID)).toBeUndefined();
    expect(JSON.stringify(items)).not.toContain('PRIVATE_ERROR');
  });

  it('never assigns a different agent running job to a configured agent', () => {
    const running = liveJob({ id: OTHER, agent: 'codex', status: 'running', startedAt: NEW });
    delete running.finishedAt;
    delete running.result;
    const items = rows(live([liveJob(), running]), secrets(), agents(['claude-code', 'codex']));
    expect(selected(items, ID)?.title).toMatch(/Claude Code.*passed/i);
    expect(selected(items, OTHER)?.title).toMatch(/Codex CLI.*running/i);
    expect(selected(items, ID)?.detail).toMatch(/historical.*isolated-host/i);
  });

  it('uses durable proof when no in-memory job remains, without implying current host protection', () => {
    const state = live();
    state.agents[0]!.proof = {
      state: 'verified',
      checkedAt: OLD,
      hostVersion: 'PRIVATE_VERSION',
      hostVersionRechecked: false,
      reason: 'PRIVATE_REASON',
      report: report(),
    };
    const item = rows(state, secrets(), agents(['claude-code'])).find((row) =>
      row.title.startsWith('Claude Code'),
    );
    expect(item?.detail).toContain(OLD);
    expect(item?.detail).toMatch(/historical.*isolated-host/i);
    expect(item?.detail).toMatch(/not.*verified/i);
    expect(new URL(item!.href, 'https://local.invalid').searchParams.get('agent')).toBe(
      'claude-code',
    );
    expect(JSON.stringify(item)).not.toContain('PRIVATE_');
  });

  it('keeps an untested configured agent selected when opening its live checks', () => {
    const items = rows(live(), secrets(), agents(['codex', 'cursor']));
    for (const agent of ['codex', 'cursor'] as const) {
      const item = items.find((row) => row.key === `live-${agent}`)!;
      const link = new URL(item.href, 'https://local.invalid');
      expect(link.searchParams.get('agent')).toBe(agent);
      expect(link.searchParams.get('workspace')).toBe(WORKSPACE);
      expect(link.searchParams.has('job')).toBe(false);
    }
  });

  it('shows a newer retained failure instead of an older in-memory passing job', () => {
    const state = live([liveJob()]);
    state.agents[0]!.proof = {
      state: 'failed',
      checkedAt: NEW,
      hostVersion: null,
      hostVersionRechecked: false,
      reason: 'PRIVATE_REASON',
      report: report('failed'),
    };
    const item = rows(state, secrets(), agents(['claude-code'])).find(
      (row) => row.key === 'live-claude-code',
    )!;
    expect(item.title).toMatch(/failed/i);
    expect(item.title).not.toMatch(/passed/i);
    expect(item.detail).toContain(NEW);
    expect(item.detail).toMatch(/historical.*isolated-host/i);
    const link = new URL(item.href, 'https://local.invalid');
    expect(link.searchParams.get('agent')).toBe('claude-code');
    expect(link.searchParams.has('job')).toBe(false);
  });

  it('compares a completed attempt by finish time and still exposes running work alongside a newer proof', () => {
    const state = live([liveJob({ finishedAt: NEW })]);
    state.agents[0]!.proof = {
      state: 'failed',
      checkedAt: '2026-10-23T01:30:00.000Z',
      hostVersion: null,
      hostVersionRechecked: false,
      reason: 'PRIVATE_REASON',
      report: report('failed'),
    };
    expect(selected(rows(state), ID)?.title).toMatch(/passed/i);
    const running = liveJob({ status: 'running' });
    delete running.result;
    delete running.finishedAt;
    state.jobs = [running];
    const item = selected(rows(state), ID)!;
    expect(item.title).toMatch(/running/i);
    expect(item.detail).toContain('2026-10-23T01:30:00.000Z');
    expect(item.detail).toMatch(/historical|retained/i);
    expect(JSON.stringify(item)).not.toContain('PRIVATE_');
  });

  it('shows stale proof and unsupported drivers without treating configured hooks as live proof', () => {
    const state = live();
    state.agents[0]!.proof = {
      state: 'stale',
      checkedAt: OLD,
      hostVersion: null,
      hostVersionRechecked: false,
      reason: 'PRIVATE_REASON',
      report: report(),
    };
    state.agents[2] = {
      id: 'codex',
      supported: false,
      reason: 'driver-unavailable',
      proof: null,
    };
    const items = rows(state, secrets(), agents(['claude-code', 'cursor', 'codex']));
    expect(items.find((row) => /Claude Code/.test(row.title))?.title).toMatch(/fresh|stale/i);
    expect(items.find((row) => /Cursor/.test(row.title))?.title).toMatch(/live.*not.*checked/i);
    expect(items.find((row) => /Codex/.test(row.title))?.detail).toMatch(/driver.*unavailable/i);
    expect(
      items
        .filter((row) => /Claude Code|Cursor|Codex/.test(row.title))
        .every((row) => row.tone === 'orange'),
    ).toBe(true);
  });

  it('treats stale proof as unverified freshness without asserting that the context changed', () => {
    const state = live();
    state.agents[0]!.proof = {
      state: 'stale',
      checkedAt: OLD,
      hostVersion: null,
      hostVersionRechecked: false,
      reason: 'host-version-not-checked',
      report: report(),
    };
    const item = rows(state).find((row) => row.key === 'live-claude-code')!;
    expect(item.detail).toMatch(/freshness has not been established/i);
    expect(item.detail).not.toMatch(/context.*changed/i);
    expect(item.tone).toBe('orange');
  });

  it('prioritizes retained exposure over passing checks while preserving equal-priority order', () => {
    const current = live([liveJob(), liveJob({ id: THIRD, agent: 'cursor' })]);
    const comparisons = secrets([
      secretJob(exposure('third_party')),
      secretJob(exposure('maybe'), { id: OTHER, startedAt: NEW, finishedAt: NEW }),
    ]);
    const items = rows(current, comparisons);
    expect(items[0]?.tone).toBe('red');
    expect(items[1]?.tone).toBe('orange');
    expect(items.filter((row) => row.key.startsWith('live-')).map((row) => row.key)).toEqual([
      'live-claude-code',
      'live-cursor',
    ]);
    expect(items.slice(2).every((row) => row.tone === 'muted')).toBe(true);
  });

  it('labels completed stand-in and inconclusive attempts without a passing live claim', () => {
    const job = liveJob({ result: { ...report('inconclusive'), mode: 'stand-in' } });
    const item = selected(rows(live([job])), ID);
    expect(item?.tone).toBe('orange');
    expect(item?.title).not.toMatch(/passed|protected|verified/i);
    expect(item?.detail).toMatch(/stand-in/i);
    expect(JSON.stringify(item)).not.toContain('PRIVATE_');
  });

  it.each(['third_party', 'maybe'] as const)(
    'retains older %s credential evidence after a newer clean narrower report',
    (tier) => {
      const items = rows(
        live(),
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
    const items = rows(live(), secrets([secretJob(exposure('third_party')), failed]));
    expect(selected(items, ID)?.tone).toBe('red');
    expect(selected(items, OTHER)?.title).toMatch(/did not complete/i);
    expect(selected(items, OTHER)?.detail).toContain(NEW);
  });

  it('keeps incomplete retained coverage visible after a newer complete report', () => {
    const incomplete = secretReport({ complete: false, notChecked: ['saved-outputs'] });
    const items = rows(
      live(),
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
      const items = rows(live(), secrets([secretJob(exposure('third_party')), attempt]));
      expect(selected(items, ID)?.tone).toBe('red');
      expect(selected(items, OTHER)?.title).toMatch(
        status === 'running' ? /running/i : /cancelled/i,
      );
      expect(selected(items, OTHER)?.detail).toMatch(/no completed report/i);
    },
  );

  it('distinguishes missing state, no retained scan, and a completed scan with no matches', () => {
    const missing = rows(null, null, null);
    expect(missing.some((row) => /live.*unavailable/i.test(row.title))).toBe(true);
    expect(missing.some((row) => /secret.*unavailable/i.test(row.title))).toBe(true);
    expect(rows().some((row) => /seen your keys/i.test(row.title))).toBe(true);
    const clean = selected(rows(live(), secrets([secretJob()])), ID);
    expect(clean?.tone).toBe('muted');
    expect(clean?.detail).toMatch(/does not establish/i);
  });

  it('stays quiet while the snapshots load, then names first steps without alarm', () => {
    // A first visit renders before the snapshots arrive; that is not evidence that they are missing.
    expect(
      protectionEvidenceRows({
        live: null,
        secrets: null,
        agents: null,
        workspaceId: WORKSPACE,
        loading: true,
      }),
    ).toEqual([]);
    // Loaded and nothing recorded yet: a step to take, not a finding.
    const scan = rows().find((row) => row.key === 'secret-never');
    expect(scan?.title).toBe('Check whether your agents have seen your keys');
    expect(scan?.tone).toBe('muted');
    expect(scan?.detail).toMatch(/no scan has been saved yet/i);
    const none = {
      ...agents(),
      agents: agents().agents.map((a) => ({
        ...a,
        scopes: a.scopes.map((s) => ({
          ...s,
          state: 'missing' as const,
          reason: 'hooks-missing' as const,
        })),
      })),
    };
    const test = rows(live(), secrets(), none).find((row) => row.key === 'live-never');
    expect(test?.title).toBe('No live test yet');
  });

  it('retains reports when either engine becomes unavailable', () => {
    const currentLive = live([liveJob()], { engine: { available: false, version: null } });
    const currentSecrets = {
      ...secrets([secretJob(exposure('third_party'))]),
      engine: { available: false, version: null },
    };
    const items = rows(currentLive, currentSecrets);
    expect(selected(items, ID)?.detail).toMatch(/historical/i);
    expect(items.some((row) => /live.*engine.*unavailable/i.test(row.title))).toBe(true);
    expect(items.some((row) => /credential.*engine.*unavailable/i.test(row.title))).toBe(true);
  });

  it('emits only safe fixed links even for IDs accepted by the older live schema', () => {
    const state = live([liveJob({ id: '../private?token=PRIVATE_AUTH' })]);
    const output = rows(state, secrets(), agents(), '../private?token=PRIVATE_AUTH');
    expect(JSON.stringify(output)).not.toContain('PRIVATE_');
    expect(
      output.every((row) =>
        ['/agents/checks/', '/keys/'].includes(new URL(row.href, 'https://local.invalid').pathname),
      ),
    ).toBe(true);
    expect(output.every((row) => !row.href.includes('?'))).toBe(true);
    const valid = selected(rows(live([liveJob()])), ID)!;
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
    const first = rows(live(), state);
    expect(JSON.stringify(state)).toBe(source);
    expect(first).toEqual(rows(live(), state));
    expect(new Set(first.map((row) => row.key)).size).toBe(first.length);
    expect(first.filter((row) => row.tone === 'red')).toHaveLength(8);
    expect(first.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(first)).not.toMatch(/8 credentials|8 external/);
  });
});
