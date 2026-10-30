import { describe, expect, it } from 'vitest';
import { codexSkillControlRows } from './codex-skill-control-queue';
import type {
  CodexSkillControlPreview,
  CodexSkillControlRecord,
  CodexSkillControlState,
} from './codex-skill-controls';

const context = 'codex-context-' + 'a'.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = (change: Partial<CodexSkillControlRecord> = {}): CodexSkillControlRecord => ({
  id: id(1),
  operationId: id(2),
  revision: 'b'.repeat(64),
  controlContextId: context,
  createdAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:00:01.000Z',
  name: 'Notes',
  location: { label: 'notes', redacted: false },
  operationStatus: 'disabled',
  standing: 'disabled',
  originalSha256: null,
  candidateSha256: 'c'.repeat(64),
  canRestore: true,
  sharedUserConfig: true,
  hostEnforcement: false,
  ...change,
});
const state = (records: CodexSkillControlRecord[] = []): CodexSkillControlState => ({
  schema: 'stroq-codex-skill-controls/1',
  controlContextId: context,
  generatedAt: '2026-10-26T10:01:00.000Z',
  available: true,
  history: 'ready',
  records,
  error: null,
});
const preview = (): CodexSkillControlPreview => ({
  schema: 'stroq-codex-skill-control-preview/1',
  id: id(2),
  operationId: id(2),
  binding: null,
  controlContextId: context,
  operation: 'restore',
  recordId: id(1),
  recordRevision: 'b'.repeat(64),
  createdAt: '2026-10-26T10:00:00.000Z',
  expiresAt: '2026-10-26T10:02:00.000Z',
  name: 'Notes',
  location: { label: 'notes', redacted: false },
  beforeSha256: 'c'.repeat(64),
  afterSha256: null,
  sameNameCopies: 0,
  sharedUserConfig: true,
  retainsConfigurationCopies: true,
  formattingPreserved: true,
  hostEnforcement: false,
});

describe('Codex skill controls in Protection', () => {
  it('keeps empty history quiet and rejects malformed snapshots', () => {
    expect(codexSkillControlRows(state())).toEqual([]);
    expect(codexSkillControlRows({ ...state(), private: '/raw/path' })[0]?.title).toMatch(
      /unavailable/,
    );
  });
  it('shows current base declaration separately from native adoption', () => {
    const rows = codexSkillControlRows(state([record()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tone).toBe('muted');
    expect(rows[0]?.detail).toMatch(/base user configuration/);
    expect(rows[0]?.detail).toMatch(/Native adoption is unverified/);
    expect(rows[0]?.href).toContain('codexControls=history');
  });
  it('counts matching records without claiming distinct physical paths', () => {
    const rows = codexSkillControlRows(
      state([record(), record({ id: id(4), operationId: id(5) })]),
    );
    expect(rows[0]?.title).toBe('2 Codex disable records match current settings');
  });
  it('returns an exact retained recovery link for uncertain and drifted records', () => {
    for (const r of [
      record({ operationStatus: 'unknown', canRestore: false }),
      record({ standing: 'enabled-or-unspecified' }),
    ]) {
      const rows = codexSkillControlRows(state([r]));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tone).toBe('orange');
      expect(rows[0]?.href).toContain('codexControl=' + r.id);
      expect(rows[0]?.href).toContain('context=' + context);
      expect(rows[0]?.title).not.toMatch(/protected|blocked/i);
    }
  });
  it('does not turn Restore into an enable or unresolved-incident claim', () => {
    expect(
      codexSkillControlRows(
        state([record({ operationStatus: 'restored', standing: 'disabled', canRestore: false })]),
      ),
    ).toEqual([]);
  });
  it('retains exact browser unknown writes through empty, unavailable and different-context history', () => {
    for (const current of [
      state(),
      null,
      { ...state(), controlContextId: 'codex-context-' + 'd'.repeat(64) },
    ]) {
      const rows = codexSkillControlRows(current, [{ preview: preview() }]);
      expect(rows[0]?.title).toBe('Codex skill change is unconfirmed');
      expect(rows[0]?.href).toContain('context=' + context);
      expect(rows[0]?.tone).toBe('orange');
    }
  });
  it('deduplicates only the same operation while preserving a later distinct saved operation', () => {
    const p = { preview: preview() };
    expect(
      codexSkillControlRows(state([record({ operationStatus: 'unknown', canRestore: false })]), [
        p,
        p,
      ]),
    ).toHaveLength(1);
    const rows = codexSkillControlRows(
      state([record({ operationId: id(3), operationStatus: 'unknown', canRestore: false })]),
      [p],
    );
    expect(rows).toHaveLength(2);
  });
});
