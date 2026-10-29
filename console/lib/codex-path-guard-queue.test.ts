import { describe, it, expect } from 'vitest';
import { codexPathGuardRows } from './codex-path-guard-queue';
import type {
  CodexPathGuardState,
  CodexPathGuardRecord,
  CodexPathGuardPreview,
} from './codex-path-guard';
import type { PathGuardPending } from './codex-path-guard-client';
const context = 'codex-context-' + 'a'.repeat(64),
  foreign = 'codex-context-' + 'b'.repeat(64),
  at = '2026-10-27T00:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = (patch: Partial<CodexPathGuardRecord> = {}): CodexPathGuardRecord => ({
  id: id(1),
  operationId: id(2),
  revision: 'c'.repeat(64),
  controlContextId: context,
  kind: 'profile-path-deny',
  presetId: 'aws-credentials',
  createdAt: at,
  updatedAt: at,
  operationStatus: 'guarded',
  ownership: 'current',
  standing: 'selected',
  originalSha256: 'd'.repeat(64),
  candidateSha256: 'e'.repeat(64),
  canRestore: true,
  sharedUserConfig: true,
  hostEnforcement: false,
  ...patch,
});
const state = (records: CodexPathGuardRecord[] = []): CodexPathGuardState => ({
  schema: 'stroq-codex-path-guard/1',
  controlContextId: context,
  generatedAt: at,
  available: true,
  history: 'ready',
  records,
  error: null,
});
const pending = (ctx = context, op = 2): PathGuardPending => ({
  startedAt: at,
  preview: {
    schema: 'stroq-codex-path-preview/1',
    id: id(20 + op),
    operationId: id(op),
    controlContextId: ctx,
    operation: 'restore',
    kind: 'profile-path-deny',
    presetId: 'aws-credentials',
    recordId: id(1),
    recordRevision: 'c'.repeat(64),
    createdAt: at,
    expiresAt: '2026-10-27T00:02:00.000Z',
    binding: null,
    beforeSha256: 'e'.repeat(64),
    afterSha256: 'd'.repeat(64),
    filesystemEffect: 'prior-settings',
    pathEffect: 'prior-settings',
    networkEffect: 'preserved',
    sharedUserConfig: true,
    retainsConfigurationCopies: true,
    formattingPreserved: true,
    hostEnforcement: false,
  } satisfies CodexPathGuardPreview,
});
describe('Credential paths on Protection', () => {
  it('keeps confirmed empty ready or optional missing history quiet', () => {
    expect(codexPathGuardRows({ state: state() })).toEqual([]);
    expect(codexPathGuardRows({ state: { ...state(), history: 'missing' } })).toEqual([]);
  });
  it('does not turn missing-but-unavailable recovery state into empty optional history', () => {
    for (const value of [
      null,
      {
        ...state(),
        history: 'unavailable',
        available: false,
        error: 'codex-path-guard-store-unavailable',
      },
      {
        ...state(),
        history: 'missing',
        available: false,
        error: 'codex-path-guard-recovery-required',
      },
      { ...state(), history: 'missing', available: false },
    ]) {
      const rows = codexPathGuardRows({ state: value });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tone).toBe('orange');
      expect(rows[0]?.title).toMatch(/unavailable/);
    }
  });
  it('preserves all exact browser writes across absent, foreign or matching history', () => {
    const writes = [pending(), pending(foreign, 4)],
      before = JSON.stringify(writes);
    for (const value of [
      null,
      state(),
      state([record()]),
      { ...state(), controlContextId: foreign },
    ]) {
      const rows = codexPathGuardRows({ state: value, pending: writes });
      expect(rows.filter((r) => r.key.startsWith('codex-path-write:'))).toHaveLength(2);
      expect(rows[0]?.title).toMatch(/unconfirmed/);
      expect(rows.some((r) => r.href.includes('pathContext=' + foreign))).toBe(true);
    }
    expect(JSON.stringify(writes)).toBe(before);
  });
  it('deduplicates only exact context+record+operation, keeping later durable unknown independent', () => {
    const p = pending();
    let rows = codexPathGuardRows({
      state: state([record({ operationStatus: 'unknown', canRestore: false })]),
      pending: [p, p],
    });
    expect(rows.filter((r) => /unconfirmed|needs recheck/.test(r.title))).toHaveLength(1);
    rows = codexPathGuardRows({
      state: state([record({ operationId: id(8), operationStatus: 'unknown', canRestore: false })]),
      pending: [p],
    });
    expect(rows.filter((r) => /unconfirmed|needs recheck/.test(r.title))).toHaveLength(2);
  });
  it.each(['changed', 'overridden', 'unavailable'] as const)(
    'surfaces every current owned %s rule with an exact Inspect link',
    (standing) => {
      const rows = codexPathGuardRows({ state: state([record({ standing })]) });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tone).toBe('orange');
      expect(rows[0]?.href).toContain('codexPaths=history');
      expect(rows[0]?.href).toContain('pathRecord=' + id(1));
      expect(rows[0]?.href).toContain('pathContext=' + context);
      expect(rows[0]?.action).not.toMatch(/Restore|Apply|check/i);
    },
  );
  it('restored and superseded declarations stay quiet but their durable unknowns remain visible', () => {
    for (const r of [
      record({ operationStatus: 'restored', canRestore: false, standing: 'changed' }),
      record({ ownership: 'superseded', canRestore: false, standing: 'changed' }),
    ])
      expect(codexPathGuardRows({ state: state([r]) })).toEqual([]);
    expect(
      codexPathGuardRows({
        state: state([
          record({ ownership: 'superseded', operationStatus: 'unknown', canRestore: false }),
        ]),
      })[0]?.title,
    ).toMatch(/needs recheck/);
  });
  it('matching denial is a muted user declaration with native adoption still unverified', () => {
    const rows = codexPathGuardRows({ state: state([record()]) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tone).toBe('muted');
    expect(rows[0]?.detail).toMatch(/adoption.*unverified/i);
    expect(rows[0]?.context).toMatch(/user.*declaration/i);
    expect(JSON.stringify(rows)).not.toMatch(/Protected|green|proof|Run check/);
  });
  it('never hides drift because a different retained record matches the same preset', () => {
    const rows = codexPathGuardRows({
      state: state([record({ standing: 'changed' }), record({ id: id(3), operationId: id(4) })]),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.tone).toBe('orange');
    expect(rows[1]?.tone).toBe('muted');
  });
  it('does not infer profile equivalence for two matching records with identical preset ids', () => {
    const rows = codexPathGuardRows({
      state: state([record(), record({ id: id(3), operationId: id(4) })]),
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
  it('partial unavailable history cannot hide a validated durable unknown', () => {
    const rows = codexPathGuardRows({
      state: {
        ...state([record({ operationStatus: 'unknown', canRestore: false })]),
        available: false,
        history: 'unavailable',
        error: 'codex-path-guard-store-unavailable',
      },
    });
    expect(rows.some((r) => /needs recheck/.test(r.title))).toBe(true);
    expect(rows.some((r) => /unavailable/.test(r.title))).toBe(true);
  });
  it('rejects malformed metadata without private text or substitute action links', () => {
    const bad = {
      ...pending(),
      preview: { ...pending().preview, privatePath: '/private/SECRET' },
    } as unknown as PathGuardPending;
    const rows = codexPathGuardRows({
      state: { ...state(), raw: '/private/SECRET' },
      pending: [bad],
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|SECRET/);
    expect(rows.every((r) => !r.href.includes('pathRecord='))).toBe(true);
  });
  it('loading has no fabricated unavailable result but exact pending remains actionable', () => {
    expect(codexPathGuardRows({ state: null, loading: true })).toEqual([]);
    const rows = codexPathGuardRows({ state: null, loading: true, pending: [pending()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toMatch(/unconfirmed/);
  });
});
it('prioritizes durable unknown before drift regardless of retained history order', () => {
  const rows = codexPathGuardRows({
    state: state([
      record({ standing: 'changed' }),
      record({ id: id(3), operationId: id(4), operationStatus: 'unknown', canRestore: false }),
    ]),
  });
  expect(rows[0]?.title).toMatch(/needs recheck/);
  expect(rows[1]?.title).toMatch(/rule changed/);
});
