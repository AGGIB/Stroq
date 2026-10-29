import { expect, it } from 'vitest';
import { quarantinePreviewMatches, quarantineReceiptMatches } from './quarantine-binding';
import type {
  SkillQuarantineArtifact,
  SkillQuarantinePreview,
  SkillQuarantineReceipt,
} from './skill-quarantine';
const artifact: SkillQuarantineArtifact = {
  id: 'item-' + 'a'.repeat(24),
  name: 'notes',
  agent: 'claude-code',
  skillSource: 'claude-skills',
  location: { label: 'release/notes', redacted: false },
  scope: 'project',
  sha256: 'b'.repeat(64),
};
const workspace = 'workspace-' + 'c'.repeat(24);
const preview = {
  action: 'restore',
  recordId: '12345678-abcd-4abc-8abc-123456789abc',
  artifact,
  workspaceId: workspace,
  id: '87654321-abcd-4abc-8abc-123456789abc',
} as SkillQuarantinePreview;
const receipt: SkillQuarantineReceipt = {
  schema: 'stroq-skill-quarantine-receipt/2',
  source: 'local',
  workspaceId: workspace,
  id: preview.id,
  recordId: preview.recordId,
  action: 'restore',
  artifact,
  completedAt: '2026-10-23T00:00:00.000Z',
  status: 'restored',
  effect: 'restore-discovery-path',
  evidence: 'discovery-path',
  requiresNewSession: true,
  reviewBaselineChanged: false,
  hostEnforcement: false,
};
it('accepts only the requested workspace, artifact revision, scope and operation', () => {
  expect(quarantinePreviewMatches(preview, 'restore', artifact, workspace, preview.recordId)).toBe(
    true,
  );
  expect(quarantinePreviewMatches(preview, 'quarantine', artifact, workspace)).toBe(false);
  expect(
    quarantinePreviewMatches(
      preview,
      'restore',
      artifact,
      'workspace-' + 'd'.repeat(24),
      preview.recordId,
    ),
  ).toBe(false);
  expect(
    quarantinePreviewMatches(
      preview,
      'restore',
      { ...artifact, sha256: 'e'.repeat(64) },
      workspace,
      preview.recordId,
    ),
  ).toBe(false);
  expect(
    quarantinePreviewMatches(
      preview,
      'restore',
      { ...artifact, scope: 'user' },
      workspace,
      preview.recordId,
    ),
  ).toBe(false);
  expect(
    quarantinePreviewMatches(preview, 'restore', artifact, workspace, 'different-record'),
  ).toBe(false);
});
it('binds completion to the exact single-use preview and retained record', () => {
  expect(quarantineReceiptMatches(receipt, preview)).toBe(true);
  expect(quarantineReceiptMatches({ ...receipt, id: preview.recordId }, preview)).toBe(false);
  expect(quarantineReceiptMatches({ ...receipt, recordId: preview.id }, preview)).toBe(false);
  expect(
    quarantineReceiptMatches(
      { ...receipt, artifact: { ...artifact, id: 'item-' + 'f'.repeat(24) } },
      preview,
    ),
  ).toBe(false);
});
it('rejects equal-name copies from another fixed source or nested folder', () => {
  const matches = (changed: Partial<SkillQuarantineArtifact>) =>
    quarantinePreviewMatches(
      { ...preview, artifact: { ...artifact, ...changed } },
      'restore',
      artifact,
      workspace,
      preview.recordId,
    );
  expect(matches({ agent: 'shared', skillSource: 'agents-skills' })).toBe(false);
  expect(matches({ location: { label: 'review/notes', redacted: false } })).toBe(false);
  expect(matches({ location: { label: 'Folder name withheld', redacted: true } })).toBe(false);
  expect(
    quarantineReceiptMatches(
      {
        ...receipt,
        artifact: {
          ...artifact,
          location: { label: 'review/notes', redacted: false },
        },
      },
      preview,
    ),
  ).toBe(false);
});
