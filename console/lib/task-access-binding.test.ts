import { describe, expect, it } from 'vitest';
import {
  taskAccessIssueInput,
  taskAccessPreviewMatches,
  taskAccessReceiptMatches,
  taskAccessStateMatches,
} from './task-access-binding';
import type { TaskAccessPreview, TaskAccessReceipt, TaskAccessState } from './task-access';
const sha = 'a'.repeat(64),
  ws = `workspace-${'b'.repeat(24)}`,
  at = '2026-10-24T00:00:00.000Z',
  id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const incident = { id: `incident-${sha}`, evidenceSha256: sha, sequence: 1, recordedAt: at };
const p = {
  id,
  workspaceId: ws,
  createdAt: at,
  expiresAt: '2026-10-24T00:02:00.000Z',
  grantExpiresAt: '2026-10-24T00:05:00.000Z',
  incident,
  task: { id: `task-${sha}`, permitSha256: sha },
  operation: { fingerprint: sha },
} as TaskAccessPreview;
const r = {
  id,
  previewId: id,
  workspaceId: ws,
  incident,
  taskId: p.task.id,
  permitSha256: sha,
  fingerprint: sha,
  issuedAt: at,
  expiresAt: p.grantExpiresAt,
} as TaskAccessReceipt;
describe('one-use consent and receipt binding', () => {
  it('requires both explicit consents and exact unexpired preview', () => {
    for (const [one, key] of [
      [false, false],
      [true, false],
      [false, true],
    ])
      expect(taskAccessIssueInput(p, one!, key!, Date.parse(at))).toBeNull();
    expect(taskAccessIssueInput(p, true, true, Date.parse(p.expiresAt))).toBeNull();
    expect(taskAccessIssueInput(p, true, true, Date.parse(at) - 1)).toBeNull();
    expect(taskAccessIssueInput(p, true, true, Date.parse(at))).toEqual({
      previewId: id,
      acknowledgeOneUse: true,
      acknowledgeSigningKeyUse: true,
    });
  });
  it('binds immutable finding fields and selected workspace', () => {
    const selected = { id: incident.id, evidenceSha: sha, sequence: 1, recordedAt: at };
    expect(taskAccessPreviewMatches(p, selected, ws)).toBe(true);
    expect(taskAccessPreviewMatches(p, { ...selected, sequence: 2 }, ws)).toBe(false);
    expect(taskAccessPreviewMatches(p, selected, `workspace-${'c'.repeat(24)}`)).toBe(false);
  });
  it('refuses matched IDs with wrong grant, permit, fingerprint, incident or fixed issue time', () => {
    expect(taskAccessReceiptMatches(r, p)).toBe(true);
    for (const field of [
      'previewId',
      'workspaceId',
      'taskId',
      'permitSha256',
      'fingerprint',
      'issuedAt',
      'expiresAt',
    ])
      expect(taskAccessReceiptMatches({ ...r, [field]: 'different' }, p)).toBe(false);
    expect(taskAccessReceiptMatches({ ...r, incident: { ...incident, sequence: 2 } }, p)).toBe(
      false,
    );
    expect(
      taskAccessReceiptMatches(
        { ...r, incident: { recordedAt: at, sequence: 1, evidenceSha256: sha, id: incident.id } },
        p,
      ),
    ).toBe(true);
  });
  it('checks ledger task/permit/workspace without substituting a newer permit', () => {
    const state = { workspaceId: ws, taskId: p.task.id, permitSha256: sha } as TaskAccessState;
    expect(taskAccessStateMatches(state, ws, p.task.id, sha)).toBe(true);
    expect(taskAccessStateMatches(state, ws, p.task.id, 'c'.repeat(64))).toBe(false);
  });
});
