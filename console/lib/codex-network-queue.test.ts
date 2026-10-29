import { describe, it, expect } from 'vitest';
import { codexNetworkRows } from './codex-network-queue';
import type {
  CodexNetworkGuardRecord,
  CodexNetworkGuardState,
  CodexNetworkGuardPreview,
} from './codex-network-guard';
import type {
  CodexNetworkCheckBinding,
  CodexNetworkCheckJob,
  CodexNetworkCheckState,
} from './codex-network-check';
import type { GuardPending, CheckPending } from './codex-network-client';
const context = 'codex-context-' + 'a'.repeat(64),
  foreign = 'codex-context-' + 'f'.repeat(64),
  workspace = 'workspace-' + 'b'.repeat(24),
  otherWorkspace = 'workspace-' + 'c'.repeat(24),
  at = '2026-10-26T12:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = (patch: Partial<CodexNetworkGuardRecord> = {}): CodexNetworkGuardRecord => ({
  id: id(1),
  operationId: id(2),
  revision: 'c'.repeat(64),
  controlContextId: context,
  kind: 'profile-network-off',
  createdAt: at,
  updatedAt: at,
  operationStatus: 'guarded',
  ownership: 'current',
  standing: 'selected',
  originalSha256: null,
  candidateSha256: 'd'.repeat(64),
  canRestore: true,
  retainsInactiveProfile: false,
  sharedUserConfig: true,
  hostEnforcement: false,
  ...patch,
});
const guard = (records: CodexNetworkGuardRecord[] = []): CodexNetworkGuardState => ({
  schema: 'stroq-codex-network-guard/1',
  controlContextId: context,
  generatedAt: at,
  available: true,
  history: 'ready',
  records,
  error: null,
});
const binding = (ctx = context, ws = workspace): CodexNetworkCheckBinding => ({
  workspaceId: ws,
  controlContextId: ctx,
  captureSha256: 'a'.repeat(64),
  configSha256: null,
  runtimeSha256: 'b'.repeat(64),
  nativeBinarySha256: 'c'.repeat(64),
  sourceGraphSha256: 'd'.repeat(64),
  profileCopySha256: 'e'.repeat(64),
  suiteSha256: 'f'.repeat(64),
  copyKind: 'profile',
});
const job = (
  status: CodexNetworkCheckJob['status'] = 'completed',
  n = 4,
  ctx = context,
): CodexNetworkCheckJob => ({
  schema: 'stroq-codex-network-check-job/1',
  id: id(n),
  operationId: id(n + 100),
  binding: binding(ctx),
  startedAt: at,
  finishedAt: status === 'running' ? null : at,
  status,
  progress: 'native',
  error:
    status === 'failed'
      ? 'codex-network-check-timeout'
      : status === 'cancelled'
        ? 'codex-network-check-cancelled'
        : null,
  result:
    status === 'completed'
      ? {
          scope: 'isolated-permission-copy',
          outcome: 'passed',
          nativeBinarySha256: 'c'.repeat(64),
          profileCopySha256: 'e'.repeat(64),
          suiteSha256: 'f'.repeat(64),
          nativeExitCode: 0,
          cleanupConfirmed: true,
          checks: ['tcp', 'unix'].map((id) => ({
            id: id as 'tcp' | 'unix',
            positiveConnections: 1,
            attempted: true,
            effect: 'denied',
            connections: 0,
            errno: 'EPERM',
          })),
          modelCalls: 0,
          providerCalls: 0,
        }
      : null,
});
const checks = (jobs: CodexNetworkCheckJob[] = []): CodexNetworkCheckState => ({
  schema: 'stroq-codex-network-checks/2',
  workspaceId: workspace,
  controlContextId: context,
  generatedAt: at,
  history: 'ready',
  jobs,
  activeJobId: jobs.find((j) => j.status === 'running')?.id ?? null,
  ownedJobId: null,
  error: null,
});
const guardPending = (ctx = context, op = 2): GuardPending => ({
  startedAt: at,
  preview: {
    schema: 'stroq-codex-network-preview/1',
    id: id(op),
    operationId: id(op),
    controlContextId: ctx,
    operation: 'restore',
    kind: 'profile-network-off',
    recordId: id(1),
    recordRevision: 'c'.repeat(64),
    createdAt: at,
    expiresAt: '2026-10-26T12:02:00.000Z',
    binding: null,
    beforeSha256: 'd'.repeat(64),
    afterSha256: null,
    filesystemEffect: 'prior-settings',
    networkEffect: 'prior-settings',
    retainsInactiveProfile: false,
    sharedUserConfig: true,
    retainsConfigurationCopies: true,
    formattingPreserved: true,
    hostEnforcement: false,
  },
});
const checkPending = (
  action: 'start' | 'cancel' = 'start',
  ctx = context,
  ws = workspace,
): CheckPending => ({
  action,
  id: id(4),
  operationId: id(104),
  binding: binding(ctx, ws),
  startedAt: at,
});
const input = () => ({ workspaceId: workspace, guard: guard(), checks: checks() });
describe('Network Guard on Protection', () => {
  it('keeps verified empty history quiet; unavailable and malformed histories remain gaps', () => {
    expect(codexNetworkRows(input())).toEqual([]);
    for (const patch of [
      { guard: null },
      { checks: null },
      { guard: { ...guard(), raw: '/private/path' } },
      {
        checks: {
          ...checks(),
          history: 'unavailable',
          error: 'codex-network-check-history-unavailable',
        },
      },
    ]) {
      const rows = codexNetworkRows({ ...input(), ...patch });
      expect(rows).not.toHaveLength(0);
      expect(rows.every((r) => r.tone === 'orange')).toBe(true);
      expect(JSON.stringify(rows)).not.toContain('/private/path');
    }
  });
  it('preserves every exact unknown write across absent or foreign history without mutating it', () => {
    const pending = [guardPending(), guardPending(foreign, 3)];
    const before = JSON.stringify(pending);
    for (const g of [guard(), null, { ...guard(), controlContextId: foreign }]) {
      const rows = codexNetworkRows({ ...input(), guard: g, guardPending: pending });
      expect(rows.filter((r) => r.key.startsWith('codex-network-write:'))).toHaveLength(2);
      expect(rows.some((r) => r.href.includes('context=' + foreign))).toBe(true);
    }
    expect(JSON.stringify(pending)).toBe(before);
  });
  it('deduplicates only the same operation, retaining a later distinct durable unknown', () => {
    const pending = guardPending();
    let rows = codexNetworkRows({
      ...input(),
      guard: guard([record({ operationStatus: 'unknown', canRestore: false })]),
      guardPending: [pending, pending],
    });
    expect(rows.filter((r) => /unconfirmed|needs recheck/i.test(r.title))).toHaveLength(1);
    rows = codexNetworkRows({
      ...input(),
      guard: guard([record({ operationId: id(9), operationStatus: 'unknown', canRestore: false })]),
      guardPending: [pending],
    });
    expect(rows.filter((r) => /unconfirmed|needs recheck/i.test(r.title))).toHaveLength(2);
  });
  it.each(['changed', 'overridden', 'unavailable'] as const)(
    'surfaces current-owned %s declaration without a Restore CTA',
    (standing) => {
      const rows = codexNetworkRows({ ...input(), guard: guard([record({ standing })]) });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tone).toBe('orange');
      expect(rows[0]?.href).toContain('record=' + id(1));
      expect(rows[0]?.action).not.toMatch(/restore/i);
    },
  );
  it('keeps superseded and restored settings quiet, without hiding durable unknowns', () => {
    expect(
      codexNetworkRows({
        ...input(),
        guard: guard([record({ ownership: 'superseded', canRestore: false, standing: 'changed' })]),
      }),
    ).toEqual([]);
    expect(
      codexNetworkRows({
        ...input(),
        guard: guard([
          record({ operationStatus: 'restored', canRestore: false, standing: 'changed' }),
        ]),
      }),
    ).toEqual([]);
    expect(
      codexNetworkRows({
        ...input(),
        guard: guard([
          record({ operationStatus: 'unknown', ownership: 'superseded', canRestore: false }),
        ]),
      })[0]?.title,
    ).toMatch(/needs recheck/);
  });
  it('a matching owned declaration is muted user-setting evidence, never live host coverage', () => {
    const rows = codexNetworkRows({ ...input(), guard: guard([record()]) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tone).toBe('muted');
    expect(rows[0]?.context).toMatch(/user declaration/i);
    expect(rows[0]?.detail).toMatch(/adoption.*unverified/i);
    expect(JSON.stringify(rows)).not.toMatch(/Protected|current client is blocked/);
  });
  it('start and cancel unknowns stay actionable through missing/different history with namespaced links', () => {
    for (const p of [checkPending(), checkPending('cancel', foreign, otherWorkspace)]) {
      const rows = codexNetworkRows({ ...input(), checks: null, checkPending: [p] });
      const row = rows.find((r) => r.key.startsWith('codex-network-request:'));
      expect(row?.title).toMatch(/unconfirmed/);
      expect(row?.href).toContain('check=' + p.id);
      expect(row?.href).toContain('networkWorkspace=' + p.binding.workspaceId);
      expect(new URL(row!.href, 'http://local').searchParams.has('workspace')).toBe(false);
    }
  });
  it('a later historical pass never erases an independent earlier unknown start', () => {
    const rows = codexNetworkRows({
      ...input(),
      checks: checks([job('completed', 8)]),
      checkPending: [checkPending()],
    });
    expect(rows.some((r) => r.title.includes('unconfirmed'))).toBe(true);
    expect(rows.some((r) => r.title.includes('Latest Codex copy check'))).toBe(true);
    expect(rows.every((r) => r.tone !== 'red')).toBe(true);
  });
  it('exact pending attempt dominates its GET result until explicit owner recheck, no map reconciliation here', () => {
    const rows = codexNetworkRows({
      ...input(),
      checks: checks([job()]),
      checkPending: [checkPending()],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toMatch(/unconfirmed/);
  });
  it('running checks have exact job/context/workspace links without native start authority', () => {
    const rows = codexNetworkRows({ ...input(), checks: checks([job('running')]) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toMatch(/running/);
    expect(rows[0]?.href).toContain('check=' + id(4));
    expect(rows[0]?.action).toBe('Inspect check');
    expect(rows[0]?.context).toMatch(/copy/i);
  });
  it('surfaces failed, inconclusive and allowed-connection terminal results as historical attention', () => {
    const failed = job('failed');
    const inconclusive = job();
    inconclusive.result!.outcome = 'inconclusive';
    inconclusive.result!.nativeExitCode = 1;
    const allowed = job();
    allowed.result!.outcome = 'attention';
    allowed.result!.checks[0] = {
      id: 'tcp',
      positiveConnections: 1,
      attempted: true,
      effect: 'allowed',
      connections: 1,
      errno: null,
    };
    for (const j of [failed, inconclusive, allowed]) {
      const rows = codexNetworkRows({ ...input(), checks: checks([j]) });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tone).toBe('orange');
      expect(rows[0]?.context).toMatch(/Historical/i);
      expect(rows[0]?.action).toBe('Inspect check');
    }
  });
  it('selects latest terminal per context, while keeping a running attempt and another context separately', () => {
    const earlier = job('failed', 4),
      latest = job('completed', 5),
      running = job('running', 6),
      other = job('failed', 7, foreign);
    latest.startedAt = latest.finishedAt = '2026-10-26T12:01:00.000Z';
    running.startedAt = '2026-10-26T12:02:00.000Z';
    const rows = codexNetworkRows({
      ...input(),
      checks: checks([earlier, latest, running, other]),
    });
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.href.includes('check=' + earlier.id))).toBe(false);
    expect(rows.some((r) => r.href.includes('check=' + latest.id))).toBe(true);
    expect(rows.some((r) => r.href.includes('context=' + foreign))).toBe(true);
  });
  it('a passing historical copy never implies current default adoption or a green protection result', () => {
    const row = codexNetworkRows({ ...input(), checks: checks([job()]) })[0];
    expect(row?.tone).toBe('muted');
    expect(row?.context).toBe('Historical isolated permission copy');
    expect(row?.detail).toMatch(/current default.*unverified/i);
    expect(row?.title).not.toMatch(/protected|network blocked|resolved/i);
  });
  it('rejects malformed pending identities and foreign workspace state without leaking private data', () => {
    const pending = {
      ...checkPending(),
      binding: { ...binding(), raw: '/private/path' },
    } as unknown as CheckPending;
    const rows = codexNetworkRows({
      ...input(),
      checks: { ...checks(), workspaceId: otherWorkspace },
      checkPending: [pending],
    });
    expect(JSON.stringify(rows)).not.toContain('/private/path');
    expect(rows.some((r) => r.key.includes('history'))).toBe(true);
    expect(rows.every((r) => !r.href.includes(id(4)))).toBe(true);
  });
});
