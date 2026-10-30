import { setTimeout as delay } from 'node:timers/promises';
import { validateWorkspaceReviewRun } from '../lib/workspace-review.ts';
import {
  WORKSPACE_TASK_SOURCE_ID,
  validateWorkspaceTaskRecord,
  validateWorkspaceTaskReceipt,
  type WorkspaceTaskRecord,
  type WorkspaceTaskVerification,
} from '../lib/workspace-task-controls.ts';
export function createTaskVerification({
  review,
  ctx,
  worker,
  locked,
  assertLive,
  captureIds,
  stamp,
  codeOf,
}: Record<string, any>) {
  async function stopCapture(id: string) {
    if (captureIds.delete(id)) await review?.cancel?.({ id });
  }
  async function captureVerification(
    record: WorkspaceTaskRecord,
    bound: any,
    scopeSha256: string,
  ): Promise<WorkspaceTaskVerification> {
    let runId: string | null = null;
    let terminal = false;
    try {
      assertLive();
      const accepted = await review.check({});
      if (
        accepted.status !== 202 ||
        !validateWorkspaceReviewRun(accepted.body) ||
        accepted.body.status !== 'running' ||
        accepted.body.workspaceId !== ctx.workspaceId
      )
        throw new Error();
      runId = accepted.body.id;
      captureIds.add(runId);
      const end = Date.now() + 25000;
      while (Date.now() < end) {
        assertLive();
        const run = review.getRun(runId);
        if (
          !validateWorkspaceReviewRun(run) ||
          run.id !== runId ||
          run.workspaceId !== ctx.workspaceId
        )
          throw new Error();
        if (run.status !== 'running') {
          terminal = true;
          if (run.status !== 'completed') throw new Error();
          const capture = run.result!.capture,
            source = capture.sources.find((s) => s.id === WORKSPACE_TASK_SOURCE_ID);
          if (
            capture.profile.engineVersion !== bound.engineVersion ||
            capture.profile.runtimeSha256 !== bound.runtimeSha256 ||
            capture.profile.scopeSha256 !== scopeSha256 ||
            capture.workspaceId !== record.workspaceId ||
            Date.parse(capture.capturedAt) < Date.parse(record.updatedAt)
          )
            throw new Error();
          const expected = record.status === 'manual' ? record.manualSha256 : record.originalSha256;
          return {
            status: 'recorded',
            runId,
            captureSha256: capture.captureSha256,
            capturedAt: capture.capturedAt,
            complete: capture.complete,
            sourceMatches:
              source?.kind === 'file' &&
              source.role === 'workspace' &&
              source.sha256 === expected &&
              source.mode === record.mode &&
              !capture.coverage.gaps.some((g) => g.sourceId === WORKSPACE_TASK_SOURCE_ID),
          };
        }
        await delay(20);
      }
      throw new Error();
    } catch {
      return { status: 'unavailable', runId, error: 'capture-unavailable' };
    } finally {
      if (runId) {
        if (!terminal) {
          try {
            await stopCapture(runId);
          } catch {
            /* No claim of capture completion. */
          }
        } else captureIds.delete(runId);
      }
    }
  }
  async function finish(
    record: WorkspaceTaskRecord,
    bound: any,
    operation: 'make-manual' | 'restore' | 'recheck',
    expiresAt: number,
    writeConfirmed: boolean,
    scopeSha256: string,
  ) {
    const verification = await captureVerification(record, bound, scopeSha256);
    let updated: WorkspaceTaskRecord;
    try {
      updated = await locked(bound, () =>
        worker(
          'task-verification',
          { recordId: record.id, expectedRevision: record.revision, verification },
          bound,
          expiresAt,
        ),
      );
      if (!validateWorkspaceTaskRecord(updated) || updated.id !== record.id)
        throw new Error('write-unconfirmed');
      if (record.status === 'uncertain')
        updated = { ...updated, status: 'uncertain', canRestore: false };
    } catch (error) {
      // A verified publication is a historical file fact. Later capture/receipt
      // storage failures cannot turn it into an unconfirmed write or invent a saved capture.
      updated = {
        ...record,
        fileState: 'unverifiable',
        canRestore: false,
        recoveryAvailable: false,
        verification: { status: 'unavailable', runId: verification.runId, error: codeOf(error) },
      };
    }
    const body = {
      schema: 'stroq-workspace-task-receipt/1',
      workspaceId: ctx.workspaceId,
      operation,
      checkedAt: stamp(),
      writeConfirmed,
      record: updated,
    };
    if (!validateWorkspaceTaskReceipt(body)) throw new Error('write-unconfirmed');
    return { status: 200, body: structuredClone(body) };
  }
  return { finish, stopCapture };
}
