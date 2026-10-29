import { describe, expect, it } from 'vitest';
import {
  SKILL_QUARANTINE_LIMITATIONS,
  validateSkillQuarantine,
  validateSkillQuarantineApplyRequest,
  validateSkillQuarantinePreview,
  validateSkillQuarantinePreviewRequest,
  validateSkillQuarantineReceipt,
} from './skill-quarantine';

const uuid = (n = 1) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const createdAt = '2026-10-23T01:02:03.000Z';
const checkedAt = '2026-10-23T01:02:05.000Z';
const workspaceId = `workspace-${'a'.repeat(24)}`;
const artifact = () => ({
  id: `item-${'b'.repeat(24)}`,
  name: 'Release notes',
  agent: 'claude-code',
  skillSource: 'claude-skills',
  location: { label: 'Release notes', redacted: false },
  scope: 'project',
  sha256: 'c'.repeat(64),
});
const record = () => ({
  id: uuid(),
  artifact: artifact(),
  createdAt,
  restoredAt: null as string | null,
  checkedAt,
  files: 2,
  bytes: 120,
  status: 'quarantined',
  original: 'absent',
  payload: 'match',
});
const state = () => ({
  schema: 'stroq-skill-quarantine/2',
  source: 'local',
  generatedAt: checkedAt,
  workspaceId,
  available: true,
  reason: null as string | null,
  records: [record()],
  gaps: [] as { scope: string; code: string }[],
  limitations: [...SKILL_QUARANTINE_LIMITATIONS],
});
const preview = () => ({
  schema: 'stroq-skill-quarantine-preview/2',
  id: uuid(2),
  source: 'local',
  workspaceId,
  expiresAt: '2026-10-23T01:04:03.000Z',
  action: 'quarantine',
  recordId: uuid(),
  artifact: artifact(),
  files: 2,
  bytes: 120,
  effect: 'remove-discovery-path',
  requiresNewSession: true,
  affectsAllWorkspaces: false,
  limitations: [...SKILL_QUARANTINE_LIMITATIONS],
});
const receipt = () => ({
  schema: 'stroq-skill-quarantine-receipt/2',
  source: 'local',
  workspaceId,
  id: uuid(2),
  recordId: uuid(),
  action: 'quarantine',
  artifact: artifact(),
  completedAt: checkedAt,
  status: 'quarantined',
  effect: 'remove-discovery-path',
  evidence: 'discovery-path',
  requiresNewSession: true,
  reviewBaselineChanged: false,
  hostEnforcement: false,
});
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe('skill quarantine boundary', () => {
  it('accepts exact bounded state, previews and completion evidence', () => {
    expect(validateSkillQuarantine(state())).toBe(true);
    expect(validateSkillQuarantinePreview(preview())).toBe(true);
    expect(validateSkillQuarantineReceipt(receipt())).toBe(true);
    expect(validateSkillQuarantine({ ...state(), records: [] })).toBe(true);
    expect(
      validateSkillQuarantine({
        ...state(),
        available: false,
        reason: 'vault-unavailable',
        gaps: [{ scope: 'project', code: 'vault-unavailable' }],
      }),
    ).toBe(true);
  });

  it('binds restore action, scope, effect and completion status', () => {
    const restored = {
      ...record(),
      status: 'restored',
      original: 'same',
      restoredAt: '2026-10-23T01:02:04.000Z',
    };
    expect(validateSkillQuarantine({ ...state(), records: [restored] })).toBe(true);
    expect(
      validateSkillQuarantinePreview({
        ...preview(),
        action: 'restore',
        effect: 'restore-discovery-path',
        artifact: { ...artifact(), scope: 'user' },
        affectsAllWorkspaces: true,
      }),
    ).toBe(true);
    expect(
      validateSkillQuarantineReceipt({
        ...receipt(),
        action: 'restore',
        effect: 'restore-discovery-path',
        status: 'restored',
      }),
    ).toBe(true);
    for (const patch of [
      { action: 'restore' },
      { effect: 'restore-discovery-path' },
      { affectsAllWorkspaces: true },
      { artifact: { ...artifact(), scope: 'user' } },
      { requiresNewSession: false },
    ])
      expect(validateSkillQuarantinePreview({ ...preview(), ...patch })).toBe(false);
    for (const patch of [
      { action: 'restore' },
      { status: 'restored' },
      { effect: 'restore-discovery-path' },
      { evidence: 'host-enforcement' },
      { hostEnforcement: true },
      { reviewBaselineChanged: true },
      { requiresNewSession: false },
    ])
      expect(validateSkillQuarantineReceipt({ ...receipt(), ...patch })).toBe(false);
  });

  it('requires observations consistent with each public record status', () => {
    const valid = [
      { status: 'quarantined', original: 'absent', payload: 'match' },
      { status: 'reappeared', original: 'same', payload: 'match' },
      { status: 'reappeared', original: 'different', payload: 'match' },
      { status: 'payload-changed', original: 'absent', payload: 'changed' },
      { status: 'payload-missing', original: 'same', payload: 'missing' },
      { status: 'recovery-required', original: 'different', payload: 'changed' },
      { status: 'unverifiable', original: 'unverifiable', payload: 'match' },
      { status: 'unverifiable', original: 'absent', payload: 'unverifiable' },
      {
        status: 'unverifiable',
        original: 'different',
        payload: 'match',
        restoredAt: '2026-10-23T01:02:04.000Z',
      },
      {
        status: 'payload-changed',
        original: 'same',
        payload: 'changed',
        restoredAt: '2026-10-23T01:02:04.000Z',
      },
    ];
    for (const patch of valid)
      expect(validateSkillQuarantine({ ...state(), records: [{ ...record(), ...patch }] })).toBe(
        true,
      );
    for (const patch of [
      { status: 'quarantined', original: 'same' },
      { status: 'quarantined', payload: 'missing' },
      { status: 'quarantined', restoredAt: createdAt },
      { status: 'reappeared', original: 'absent' },
      { status: 'reappeared', payload: 'changed' },
      { status: 'reappeared', original: 'same', restoredAt: createdAt },
      { status: 'restored', original: 'same' },
      { status: 'restored', original: 'absent', restoredAt: createdAt },
      { status: 'restored', original: 'same', payload: 'changed', restoredAt: createdAt },
      { status: 'payload-changed', payload: 'match' },
      { status: 'payload-missing', payload: 'match' },
      { status: 'unverifiable', original: 'absent', payload: 'match' },
      { status: 'disabled' },
      { original: 'protected' },
      { payload: 'safe' },
    ])
      expect(validateSkillQuarantine({ ...state(), records: [{ ...record(), ...patch }] })).toBe(
        false,
      );
  });

  it('retains the exact scope and retention caveats in order', () => {
    expect(SKILL_QUARANTINE_LIMITATIONS).toEqual([
      'This action moves one captured folder in one fixed local skill source; it does not establish that a client loaded it.',
      'Already loaded instructions and running processes are not revoked; start a fresh agent session.',
      'Other scopes or copies can still provide a skill with the same name; synced and plugin skills are outside this control.',
      'Any client reading this source can be affected; user-scoped sources are shared across workspaces.',
      'Original files, including any secrets they contain, are retained locally in an unencrypted private folder.',
      'The retained folder is not an execution sandbox or protection against another process running as your OS user.',
      'Review baselines and Stroq installation pins are not changed by this operation.',
    ]);
    for (const limitations of [
      [],
      [...SKILL_QUARANTINE_LIMITATIONS].reverse(),
      [...SKILL_QUARANTINE_LIMITATIONS, 'Everything is protected.'],
      SKILL_QUARANTINE_LIMITATIONS.map((line, index) => (index === 1 ? 'Restart optional.' : line)),
    ]) {
      expect(validateSkillQuarantine({ ...state(), limitations })).toBe(false);
      expect(validateSkillQuarantinePreview({ ...preview(), limitations })).toBe(false);
    }
  });

  it('requires all closed keys and rejects raw or unsupported fields at every level', () => {
    for (const [value, validate] of [
      [state(), validateSkillQuarantine],
      [preview(), validateSkillQuarantinePreview],
      [receipt(), validateSkillQuarantineReceipt],
    ] as const) {
      for (const key of Object.keys(value)) expect(validate(without(value, key))).toBe(false);
      expect(validate({ ...value, path: '/private/credential' })).toBe(false);
      expect(validate({ ...value, artifact: { ...artifact(), command: 'private' } })).toBe(false);
      for (const key of Object.keys(artifact()))
        expect(validate({ ...value, artifact: without(artifact(), key) })).toBe(false);
    }
    for (const key of Object.keys(record()))
      expect(validateSkillQuarantine({ ...state(), records: [without(record(), key)] })).toBe(
        false,
      );
    expect(
      validateSkillQuarantine({ ...state(), records: [{ ...record(), content: 'private' }] }),
    ).toBe(false);
    expect(
      validateSkillQuarantine({
        ...state(),
        gaps: [{ scope: 'project', code: 'record-invalid', reason: '/private/path' }],
      }),
    ).toBe(false);
  });

  it('rejects unsafe labels, unsupported agents, paths and malformed identifiers', () => {
    for (const name of [
      '',
      'x'.repeat(81),
      '../private',
      '/private',
      'C:\\private',
      'Open\u202enotes',
      'OPENAI_API_KEY',
      'Private token',
      'sk-ant-secret-credential-value',
      'a'.repeat(32),
    ])
      expect(
        validateSkillQuarantinePreview({ ...preview(), artifact: { ...artifact(), name } }),
      ).toBe(false);
    for (const patch of [
      { agent: 'cursor' },
      { scope: 'enterprise' },
      { id: 'item-../../private' },
      { id: 'item-' + 'A'.repeat(24) },
      { sha256: null },
      { sha256: 'C'.repeat(64) },
    ])
      expect(
        validateSkillQuarantinePreview({ ...preview(), artifact: { ...artifact(), ...patch } }),
      ).toBe(false);
    for (const id of [uuid().toUpperCase(), '../path', uuid().replace('-4000-', '-0000-')]) {
      expect(validateSkillQuarantinePreview({ ...preview(), recordId: id })).toBe(false);
      expect(validateSkillQuarantineReceipt({ ...receipt(), id })).toBe(false);
    }
    expect(validateSkillQuarantine({ ...state(), workspaceId: '/private/path' })).toBe(false);
  });

  it('bounds counts, unique records, per-scope retention and timestamps', () => {
    for (const patch of [
      { files: 0 },
      { files: 129 },
      { files: 1.5 },
      { bytes: -1 },
      { bytes: 524_289 },
      { bytes: Number.NaN },
      { bytes: Number.POSITIVE_INFINITY },
    ]) {
      expect(validateSkillQuarantinePreview({ ...preview(), ...patch })).toBe(false);
      expect(validateSkillQuarantine({ ...state(), records: [{ ...record(), ...patch }] })).toBe(
        false,
      );
    }
    expect(validateSkillQuarantinePreview({ ...preview(), files: 128, bytes: 524_288 })).toBe(true);
    expect(validateSkillQuarantinePreview({ ...preview(), files: 1, bytes: 0 })).toBe(true);
    expect(validateSkillQuarantine({ ...state(), records: [record(), record()] })).toBe(false);
    const many = Array.from({ length: 64 }, (_, i) => ({
      ...record(),
      id: uuid(i + 1),
      artifact: { ...artifact(), scope: i < 32 ? 'project' : 'user' },
    }));
    expect(validateSkillQuarantine({ ...state(), records: many })).toBe(true);
    expect(
      validateSkillQuarantine({ ...state(), records: [...many, { ...record(), id: uuid(65) }] }),
    ).toBe(false);
    expect(
      validateSkillQuarantine({
        ...state(),
        records: many.slice(0, 33).map((item) => ({ ...item, artifact: artifact() })),
      }),
    ).toBe(false);
    for (const patch of [
      { createdAt: '2026-10-23' },
      { checkedAt: '2026-10-23T01:02:02.000Z' },
      { restoredAt: '2026-10-23T01:02:02.000Z' },
      { restoredAt: '2026-10-23T01:02:06.000Z' },
      { checkedAt: '2026-10-23T01:02:06.000Z' },
    ])
      expect(validateSkillQuarantine({ ...state(), records: [{ ...record(), ...patch }] })).toBe(
        false,
      );
    for (const expiresAt of ['2026-10-23', '2026-02-30T01:02:03.000Z', '2026-10-23T01:02:03+00:00'])
      expect(validateSkillQuarantinePreview({ ...preview(), expiresAt })).toBe(false);
  });

  it('does not turn unavailable context or invalid gaps into available state', () => {
    for (const reason of [
      'platform-unsupported',
      'context-unavailable',
      'engine-unavailable',
      'vault-unavailable',
    ]) {
      expect(validateSkillQuarantine({ ...state(), available: false, reason })).toBe(true);
      expect(validateSkillQuarantine({ ...state(), reason })).toBe(false);
    }
    expect(validateSkillQuarantine({ ...state(), available: false })).toBe(false);
    expect(validateSkillQuarantine({ ...state(), available: false, reason: '/private/path' })).toBe(
      false,
    );
    for (const gap of [
      { scope: 'other', code: 'record-invalid' },
      { scope: 'project', code: 'all-protected' },
      { scope: 'project' },
      { code: 'record-invalid' },
    ])
      expect(validateSkillQuarantine({ ...state(), gaps: [gap] })).toBe(false);
    expect(
      validateSkillQuarantine({
        ...state(),
        gaps: Array.from({ length: 65 }, () => ({ scope: 'project', code: 'record-invalid' })),
      }),
    ).toBe(false);
    for (const patch of [{}, { available: false, reason: 'engine-unavailable' }])
      expect(
        validateSkillQuarantine({
          ...state(),
          ...patch,
          gaps: [{ scope: 'project', code: 'record-invalid' }],
        }),
      ).toBe(false);
  });

  it('accepts only closed preview/apply requests with explicit acknowledgements', () => {
    const quarantine = {
      action: 'quarantine',
      id: artifact().id,
      expectedSha256: artifact().sha256,
    };
    const restore = { action: 'restore', recordId: uuid() };
    const apply = { previewId: uuid(2), confirm: true, acknowledgeSessionLimits: true };
    expect(validateSkillQuarantinePreviewRequest(quarantine)).toBe(true);
    expect(validateSkillQuarantinePreviewRequest(restore)).toBe(true);
    expect(validateSkillQuarantineApplyRequest(apply)).toBe(true);
    for (const [value, validate] of [
      [quarantine, validateSkillQuarantinePreviewRequest],
      [restore, validateSkillQuarantinePreviewRequest],
      [apply, validateSkillQuarantineApplyRequest],
    ] as const) {
      for (const key of Object.keys(value)) expect(validate(without(value, key))).toBe(false);
      expect(validate({ ...value, path: '/private/path' })).toBe(false);
    }
    expect(validateSkillQuarantinePreviewRequest({ ...quarantine, recordId: uuid() })).toBe(false);
    expect(validateSkillQuarantinePreviewRequest({ ...restore, id: artifact().id })).toBe(false);
    expect(validateSkillQuarantinePreviewRequest({ ...quarantine, expectedSha256: null })).toBe(
      false,
    );
    expect(validateSkillQuarantineApplyRequest({ ...apply, confirm: false })).toBe(false);
    expect(validateSkillQuarantineApplyRequest({ ...apply, acknowledgeSessionLimits: false })).toBe(
      false,
    );
    expect(validateSkillQuarantineApplyRequest({ ...apply, confirm: 'true' })).toBe(false);
  });

  it('rejects non-records, symbols and prototypes outside the JSON boundary', () => {
    for (const value of [null, [], 1, true, 'quarantine', Object.create(state())]) {
      expect(validateSkillQuarantine(value)).toBe(false);
      expect(validateSkillQuarantinePreview(value)).toBe(false);
      expect(validateSkillQuarantineReceipt(value)).toBe(false);
    }
    expect(validateSkillQuarantine({ ...state(), [Symbol('raw')]: 'private' })).toBe(false);
    expect(validateSkillQuarantine({ ...state(), records: Array(1) })).toBe(false);
    expect(validateSkillQuarantine({ ...state(), gaps: Array(1) })).toBe(false);
    expect(validateSkillQuarantine({ ...state(), limitations: Array(6) })).toBe(false);
    expect(
      validateSkillQuarantine({
        ...state(),
        records: Object.assign([record()], { path: '/private/path' }),
      }),
    ).toBe(false);
  });
});

it('requires exact source and safe relative location on every normalized public artifact', () => {
  const owners = {
    'claude-skills': 'claude-code',
    'agents-skills': 'shared',
    'codex-skills': 'codex',
    'cursor-skills': 'cursor',
    'windsurf-skills': 'windsurf',
    'devin-skills': 'windsurf',
  };
  for (const [skillSource, agent] of Object.entries(owners)) {
    const a = {
      ...artifact(),
      skillSource,
      agent,
      location: { label: 'release/notes', redacted: false },
    };
    expect(validateSkillQuarantinePreview({ ...preview(), artifact: a })).toBe(true);
    expect(validateSkillQuarantineReceipt({ ...receipt(), artifact: a })).toBe(true);
    expect(validateSkillQuarantine({ ...state(), records: [{ ...record(), artifact: a }] })).toBe(
      true,
    );
  }
  for (const patch of [
    { skillSource: 'cursor-skills' },
    { location: { label: '../notes', redacted: false } },
    { location: { label: '.', redacted: false } },
    { location: { label: 'release/PRIVATE_TOKEN', redacted: false } },
    { location: { label: 'release/notes', redacted: true } },
  ])
    expect(
      validateSkillQuarantinePreview({ ...preview(), artifact: { ...artifact(), ...patch } }),
    ).toBe(false);
  for (const field of ['location', 'skillSource'])
    expect(
      validateSkillQuarantinePreview({ ...preview(), artifact: without(artifact(), field) }),
    ).toBe(false);
  expect(
    validateSkillQuarantinePreview({
      ...preview(),
      artifact: { ...artifact(), location: { label: 'Folder name withheld', redacted: true } },
    }),
  ).toBe(true);
  expect(validateSkillQuarantine({ ...state(), schema: 'stroq-skill-quarantine/1' })).toBe(false);
});

it('retains complex legacy payload evidence with an explicit restore block', () => {
  for (const restoreBlock of ['overlapping-skill', 'managed-source'])
    expect(validateSkillQuarantine({ ...state(), records: [{ ...record(), restoreBlock }] })).toBe(
      true,
    );
  expect(
    validateSkillQuarantine({ ...state(), records: [{ ...record(), restoreBlock: 'safe' }] }),
  ).toBe(false);
  expect(
    validateSkillQuarantine({
      ...state(),
      records: [
        {
          ...record(),
          restoreBlock: 'overlapping-skill',
          payload: 'changed',
          status: 'payload-changed',
        },
      ],
    }),
  ).toBe(false);
});
