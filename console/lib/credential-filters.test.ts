import { describe, expect, it } from 'vitest';
import {
  type CredentialFilterRow,
  type CredentialFiltersState,
  CREDENTIAL_FILTER_LIMITATIONS,
  CREDENTIAL_FILTER_RETENTION,
  CREDENTIAL_FILTER_TARGETS,
  validateCredentialFilters,
  validateCredentialFilterPreview,
  validateCredentialFilterReceipt,
} from './credential-filters';
const sha = 'a'.repeat(64),
  workspaceId = 'workspace-' + 'a'.repeat(24),
  at = '2026-10-23T12:00:00.000Z';
const row = (id: keyof typeof CREDENTIAL_FILTER_TARGETS): CredentialFilterRow => ({
  id,
  ...CREDENTIAL_FILTER_TARGETS[id],
  location: id === 'claude-user' ? 'user' : 'workspace',
  context: id === 'claude-user' ? 'all-workspaces' : 'workspace',
  status: 'absent',
  exists: false,
  sourceSha256: null,
  bytes: 0,
  present: 0,
  managed: 0,
  unmanaged: 0,
  applications: 0,
  undoAvailable: false,
  reason: null,
});
const state = (): CredentialFiltersState & {
  targets: [CredentialFilterRow, CredentialFilterRow, CredentialFilterRow];
} => ({
  schema: 'stroq-credential-filters/1',
  source: 'local',
  workspaceId,
  generatedAt: at,
  available: true,
  reason: null,
  targets: [row('claude-project'), row('claude-user'), row('cursor-project')],
  limitations: [...CREDENTIAL_FILTER_LIMITATIONS],
});
const preview = () => ({
  schema: 'stroq-credential-filter-preview/1',
  id: '11111111-1111-4111-8111-111111111111',
  expiresAt: at,
  workspaceId,
  target: 'claude-project',
  action: 'apply-filter',
  location: 'workspace',
  context: 'workspace',
  operation: 'create',
  sourceSha256: null,
  candidateSha256: sha,
  bytes: 0,
  required: 13,
  present: 0,
  added: 13,
  removed: 0,
  kept: 0,
  applications: 0,
  backup: 'none-new-file',
  reformatted: false,
  needs: {
    acknowledgeReformat: false,
    acknowledgeLink: false,
    acknowledgeCredentialLoss: false,
    acknowledgeSharedScope: false,
  },
  evidence: 'configuration',
  hostEnforcement: false,
  limitations: [...CREDENTIAL_FILTER_LIMITATIONS],
  retention: CREDENTIAL_FILTER_RETENTION,
});
const receipt = () => ({
  schema: 'stroq-credential-filter-receipt/1',
  status: 'configured',
  action: 'apply-filter',
  target: 'claude-project',
  workspaceId,
  previewId: '11111111-1111-4111-8111-111111111111',
  candidateSha256: sha,
  completedAt: at,
  applications: 1,
  backup: 'none-new-file',
  evidence: 'configuration',
  hostEnforcement: false,
  requiresClientRestart: true,
});
describe('credential filter public boundaries', () => {
  it('accepts the three fixed targets and immutable configuration limitations', () => {
    expect(validateCredentialFilters(state())).toBe(true);
    expect(validateCredentialFilterPreview(preview())).toBe(true);
    expect(validateCredentialFilterReceipt(receipt())).toBe(true);
  });
  it('refuses source content, paths, duplicate targets and cross-agent metadata', () => {
    expect(validateCredentialFilters({ ...state(), rawSettings: '{}' })).toBe(false);
    const v = state();
    v.targets[0] = {
      ...v.targets[0],
      target: '/private/home/settings.json',
    } as unknown as CredentialFilterRow;
    expect(validateCredentialFilters(v)).toBe(false);
    const duplicate = state();
    duplicate.targets[2] = duplicate.targets[0];
    expect(validateCredentialFilters(duplicate)).toBe(false);
    const wrong = state();
    wrong.targets[0] = { ...wrong.targets[0], agent: 'cursor' } as (typeof wrong.targets)[0];
    expect(validateCredentialFilters(wrong)).toBe(false);
  });
  it('keeps configuration and ownership independent without inventing recovery', () => {
    const v = state();
    v.targets[0] = {
      ...v.targets[0],
      status: 'configured',
      exists: true,
      sourceSha256: sha,
      bytes: 80,
      present: 13,
      managed: null,
      unmanaged: null,
      applications: null,
      reason: 'credential-filter-storage-unavailable',
    } as unknown as CredentialFilterRow;
    expect(validateCredentialFilters(v)).toBe(true);
    v.targets[0].undoAvailable = true;
    expect(validateCredentialFilters(v)).toBe(false);
    expect(
      validateCredentialFilters({
        ...state(),
        targets: [
          { ...row('claude-project'), status: 'configured' },
          row('claude-user'),
          row('cursor-project'),
        ],
      }),
    ).toBe(false);
  });
  it('refuses misleading counts, missing bytes identity and runtime enforcement claims', () => {
    const v = state();
    v.targets[0].present = 14;
    expect(validateCredentialFilters(v)).toBe(false);
    const missing = state();
    missing.targets[0].exists = true;
    expect(validateCredentialFilters(missing)).toBe(false);
    expect(validateCredentialFilterPreview({ ...preview(), hostEnforcement: true })).toBe(false);
    expect(validateCredentialFilterReceipt({ ...receipt(), evidence: 'blocking' })).toBe(false);
    expect(validateCredentialFilterReceipt({ ...receipt(), requiresClientRestart: false })).toBe(
      false,
    );
  });
  it('requires exact preview action, count, source and scope relationships', () => {
    expect(validateCredentialFilterPreview({ ...preview(), required: 2 })).toBe(false);
    expect(validateCredentialFilterPreview({ ...preview(), action: 'undo-filter' })).toBe(false);
    expect(validateCredentialFilterPreview({ ...preview(), context: 'all-workspaces' })).toBe(
      false,
    );
    const user = {
      ...preview(),
      target: 'claude-user',
      location: 'user',
      context: 'all-workspaces',
      needs: { ...preview().needs, acknowledgeSharedScope: true },
    };
    expect(validateCredentialFilterPreview(user)).toBe(true);
    expect(
      validateCredentialFilterPreview({
        ...user,
        needs: { ...user.needs, acknowledgeSharedScope: false },
      }),
    ).toBe(false);
    expect(validateCredentialFilterPreview({ ...preview(), rawPlan: {} })).toBe(false);
  });
  it('never describes deletion of a newly created file as restoring a source copy', () => {
    const undo = {
      ...preview(),
      action: 'undo-filter',
      operation: 'remove-created-file',
      sourceSha256: sha,
      candidateSha256: null,
      present: 13,
      added: 0,
      removed: 13,
      applications: 1,
      backup: 'none-new-file',
    };
    expect(validateCredentialFilterPreview(undo)).toBe(true);
    expect(validateCredentialFilterPreview({ ...undo, backup: 'copy' })).toBe(false);
    expect(validateCredentialFilterPreview({ ...undo, operation: 'restore-copy' })).toBe(false);
  });
  it('requires undo receipt status/action coherence and bounded fixed reasons', () => {
    expect(validateCredentialFilterReceipt({ ...receipt(), status: 'undone' })).toBe(false);
    expect(
      validateCredentialFilterReceipt({ ...receipt(), status: 'undone', action: 'undo-filter' }),
    ).toBe(true);
    expect(validateCredentialFilterReceipt({ ...receipt(), applications: 1001 })).toBe(false);
    expect(validateCredentialFilters({ ...state(), reason: '/Users/person/secret' })).toBe(false);
    expect(validateCredentialFilters({ ...state(), limitations: [] })).toBe(false);
  });
});
