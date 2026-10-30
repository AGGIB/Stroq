import { describe, it, expect } from 'vitest';
import * as g from './codex-path-guard';
const hash = 'a'.repeat(64),
  context = `codex-context-${hash}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-27T00:00:00.000Z';
const binding = {
  controlContextId: context,
  captureSha256: hash,
  configSha256: hash,
  runtimeSha256: hash,
  nativeBinarySha256: hash,
  sourceGraphSha256: hash,
  targetMetadataSha256: hash,
};
const record = () => ({
  id: id(1),
  operationId: id(2),
  revision: hash,
  controlContextId: context,
  presetId: 'aws-credentials',
  kind: 'profile-path-deny',
  createdAt: at,
  updatedAt: at,
  operationStatus: 'guarded',
  ownership: 'current',
  standing: 'selected',
  originalSha256: hash,
  candidateSha256: hash,
  canRestore: true,
  sharedUserConfig: true,
  hostEnforcement: false,
});
const capture = () => ({
  schema: 'stroq-codex-path-capture/1',
  capturedAt: at,
  binding,
  compatibility: {
    status: 'supported',
    version: 'codex-cli 0.118.0',
    platform: 'darwin',
    binarySha256: hash,
  },
  baseline: { kind: 'profile', profile: 'custom', network: 'off' },
  actionKind: 'profile-path-deny',
  reason: null,
  presets: g.CODEX_PATH_GUARD_PRESETS.map((id) => ({
    id,
    target: 'regular',
    declaration: 'read',
    canGuard: true,
    reason: null,
  })),
  gaps: [],
});
const preview = () => ({
  schema: 'stroq-codex-path-preview/1',
  id: id(3),
  operationId: id(2),
  controlContextId: context,
  operation: 'guard',
  kind: 'profile-path-deny',
  presetId: 'aws-credentials',
  recordId: id(1),
  recordRevision: null,
  createdAt: at,
  expiresAt: '2026-10-27T00:02:00.000Z',
  binding,
  beforeSha256: hash,
  afterSha256: hash,
  pathEffect: 'deny-read-write',
  filesystemEffect: 'deny-exact-path',
  networkEffect: 'preserved',
  sharedUserConfig: true,
  retainsConfigurationCopies: true,
  formattingPreserved: true,
  hostEnforcement: false,
});
const state = () => ({
  schema: 'stroq-codex-path-guard/1',
  controlContextId: context,
  generatedAt: at,
  available: true,
  history: 'ready',
  records: [record()],
  error: null,
});
describe('closed Codex credential path contracts', () => {
  it('accepts finite presets, metadata-bound capture and independent preview/operation ids', () => {
    expect(g.validateCodexPathGuardBinding(binding)).toBe(true);
    expect(g.validateCodexPathGuardCapture(capture())).toBe(true);
    expect(g.validateCodexPathGuardPreview(preview())).toBe(true);
    expect(g.validateCodexPathGuardRecord(record())).toBe(true);
    expect(g.validateCodexPathGuardState(state())).toBe(true);
  });
  it('refuses raw paths, body content, dynamic labels and malformed metadata hashes', () => {
    expect(g.validateCodexPathGuardBinding({ ...binding, targetMetadataSha256: null })).toBe(false);
    for (const extra of [
      { path: '/private/credential' },
      { content: 'SECRET' },
      { profileName: 'private' },
    ]) {
      expect(g.validateCodexPathGuardCapture({ ...capture(), ...extra })).toBe(false);
      expect(g.validateCodexPathGuardPreview({ ...preview(), ...extra })).toBe(false);
      expect(g.validateCodexPathGuardRecord({ ...record(), ...extra })).toBe(false);
    }
  });
  it('requires all seven preset ids in fixed order and safe actionable targets', () => {
    const c = capture();
    expect(g.validateCodexPathGuardCapture({ ...c, presets: c.presets.slice(1) })).toBe(false);
    expect(g.validateCodexPathGuardCapture({ ...c, presets: [...c.presets].reverse() })).toBe(
      false,
    );
    for (const patch of [
      { target: 'unsafe' },
      { target: 'unavailable' },
      { declaration: 'deny' },
      { declaration: 'unknown' },
    ])
      expect(
        g.validateCodexPathGuardCapture({
          ...c,
          presets: c.presets.map((p, i) => (i ? p : { ...p, ...patch })),
        }),
      ).toBe(false);
    expect(
      g.validateCodexPathGuardCapture({
        ...c,
        compatibility: { ...c.compatibility, status: 'unsupported' },
      }),
    ).toBe(false);
    expect(g.validateCodexPathGuardCapture({ ...c, binding: null })).toBe(false);
  });
  it('requires exact preview effects, expiry, context and restore binding', () => {
    const p = preview();
    for (const patch of [
      { networkEffect: 'off' },
      { hostEnforcement: true },
      { expiresAt: at },
      { expiresAt: '2026-10-27T00:02:00.001Z' },
      { presetId: 'any-path' },
    ])
      expect(g.validateCodexPathGuardPreview({ ...p, ...patch })).toBe(false);
    expect(
      g.validateCodexPathGuardPreview({
        ...p,
        binding: { ...binding, controlContextId: `codex-context-${'b'.repeat(64)}` },
      }),
    ).toBe(false);
    const restore = {
      ...p,
      operation: 'restore',
      recordRevision: hash,
      binding: null,
      pathEffect: 'prior-settings',
      filesystemEffect: 'prior-settings',
    };
    expect(g.validateCodexPathGuardPreview(restore)).toBe(true);
    expect(g.validateCodexPathGuardPreview({ ...restore, binding })).toBe(false);
  });
  it('does not offer restore for unknown, restored or superseded ownership', () => {
    for (const patch of [
      { operationStatus: 'unknown' },
      { operationStatus: 'restored' },
      { ownership: 'superseded' },
    ])
      expect(g.validateCodexPathGuardRecord({ ...record(), ...patch })).toBe(false);
    expect(
      g.validateCodexPathGuardRecord({ ...record(), ownership: 'superseded', canRestore: false }),
    ).toBe(true);
    expect(g.validateCodexPathGuardState({ ...state(), records: [record(), record()] })).toBe(
      false,
    );
    expect(g.validateCodexPathGuardState({ ...state(), history: 'unavailable' })).toBe(false);
  });
  it('validates exact selections and never accepts a filesystem path as authority', () => {
    const selection = {
      operation: 'guard',
      controlContextId: context,
      captureSha256: hash,
      presetId: 'npmrc',
    };
    expect(g.validateCodexPathGuardSelection(selection)).toBe(true);
    expect(g.validateCodexPathGuardSelection({ ...selection, path: '~/.npmrc' })).toBe(false);
    expect(g.validateCodexPathGuardSelection({ ...selection, presetId: '../npmrc' })).toBe(false);
    expect(
      g.validateCodexPathGuardRestoreSelection({
        operation: 'restore',
        controlContextId: context,
        recordId: id(1),
        recordRevision: hash,
      }),
    ).toBe(true);
    expect(
      g.validateCodexPathGuardRecheckSelection({
        controlContextId: context,
        recordId: id(1),
        recordRevision: hash,
        operationId: id(2),
      }),
    ).toBe(true);
  });
  it('requires exact receipt identities and confirmed operation status', () => {
    const r = {
      schema: 'stroq-codex-path-receipt/1',
      operationId: id(2),
      controlContextId: context,
      operation: 'guard',
      checkedAt: at,
      writeConfirmed: true,
      record: record(),
    };
    expect(g.validateCodexPathGuardReceipt(r)).toBe(true);
    expect(g.validateCodexPathGuardReceipt({ ...r, operationId: id(9) })).toBe(false);
    expect(g.validateCodexPathGuardReceipt({ ...r, operation: 'restore' })).toBe(false);
    expect(
      g.validateCodexPathGuardReceipt({
        ...r,
        writeConfirmed: false,
        record: { ...record(), operationStatus: 'unknown', canRestore: false },
      }),
    ).toBe(true);
  });
});
