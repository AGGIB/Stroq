import { describe, expect, it } from 'vitest';
import {
  validateWorkspaceReviewRun,
  type WorkspaceReviewRun,
  type WorkspaceReviewState,
} from './workspace-review';
import {
  workspaceReviewCanRecord,
  workspaceReviewReceiptMatches,
  workspaceReviewRunMatches,
  workspaceReviewInput,
} from './workspace-review-binding';
const ws = `workspace-${'a'.repeat(24)}`,
  sha = 'a'.repeat(64),
  other = 'b'.repeat(64),
  id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture() {
  const baseline = { status: 'missing' as const, revision: null, reviewedAt: null, capture: null };
  const run: WorkspaceReviewRun = {
    schema: 'stroq-workspace-review-run/1',
    id,
    workspaceId: ws,
    status: 'completed',
    startedAt: '2026-10-24T00:00:00.000Z',
    finishedAt: '2026-10-24T00:00:01.000Z',
    result: {
      capture: {
        schema: 'stroq-workspace-capture/1',
        workspaceId: ws,
        capturedAt: '2026-10-24T00:00:01.000Z',
        captureSha256: sha,
        profile: {
          id: 'stroq-workspace-surface/1',
          engineVersion: '1.0.0',
          runtimeSha256: sha,
          scopeSha256: sha,
        },
        complete: true,
        coverage: { omittedSources: 0, omittedEntries: 0, exclusions: [], gaps: [] },
        sources: [],
        entries: [],
      },
      baseline,
      comparison: {
        status: 'missing',
        reason: 'no-baseline',
        sources: [],
        entries: { added: [], removed: [], unchanged: 0 },
      },
      canReview: true,
    },
  };
  const state: WorkspaceReviewState = {
    schema: 'stroq-workspace-review/1',
    workspaceId: ws,
    engine: { available: true, version: '1.0.0' },
    history: { status: 'ready' },
    baseline,
    runs: [run],
  };
  const receipt = {
    schema: 'stroq-workspace-review-receipt/1' as const,
    workspaceId: ws,
    runId: id,
    captureSha256: sha,
    revision: other,
    reviewedAt: '2026-10-24T00:00:02.000Z',
    reviewOnly: true as const,
    hostEnforcement: false as const,
  };
  return { run, state, receipt };
}
describe('workspace review approval binding', () => {
  it('uses the exact captured run and displayed baseline with explicit consent only', () => {
    const { run, state } = fixture();
    expect(validateWorkspaceReviewRun(run)).toBe(true);
    expect(workspaceReviewCanRecord(run, state, ws)).toBe(true);
    expect(workspaceReviewInput(run, state, ws, false)).toBeNull();
    expect(workspaceReviewInput(run, state, ws, true)).toEqual({
      runId: id,
      expectedCaptureSha256: sha,
      expectedReviewedRevision: null,
      acknowledgeReviewOnly: true,
    });
  });
  it('refuses changed baseline, another workspace, missing run and partial captures', () => {
    const { run, state } = fixture();
    expect(
      workspaceReviewCanRecord(
        run,
        { ...state, baseline: { ...state.baseline, revision: other } },
        ws,
      ),
    ).toBe(false);
    expect(workspaceReviewCanRecord(run, state, `workspace-${'b'.repeat(24)}`)).toBe(false);
    expect(workspaceReviewCanRecord(run, { ...state, runs: [] }, ws)).toBe(false);
    expect(
      workspaceReviewCanRecord(run, { ...state, engine: { available: false, version: null } }, ws),
    ).toBe(false);
    const partial = structuredClone(run);
    partial.result!.capture.complete = false;
    partial.result!.capture.coverage.gaps = [
      { code: 'unreadable', sourceId: null, label: null, labelHidden: false },
    ];
    partial.result!.canReview = false;
    expect(workspaceReviewCanRecord(partial, { ...state, runs: [partial] }, ws)).toBe(false);
  });
  it('binds complete receipts to source/workspace/run and ordering, never just a valid schema', () => {
    const { run, receipt } = fixture();
    expect(workspaceReviewReceiptMatches(receipt, run, ws)).toBe(true);
    for (const value of [
      { ...receipt, workspaceId: `workspace-${'b'.repeat(24)}` },
      { ...receipt, runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { ...receipt, captureSha256: other },
      { ...receipt, reviewedAt: run.startedAt },
      { ...receipt, raw: 'private' },
    ])
      expect(workspaceReviewReceiptMatches(value, run, ws)).toBe(false);
  });
  it('never substitutes an unrelated report for a selected running or completed run', () => {
    const { run } = fixture();
    expect(workspaceReviewRunMatches(run, ws, id)).toBe(true);
    expect(workspaceReviewRunMatches(run, ws, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
    expect(workspaceReviewRunMatches(run, `workspace-${'b'.repeat(24)}`, id)).toBe(false);
  });
});
