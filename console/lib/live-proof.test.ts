import { describe, it, expect } from 'vitest';
import {
  validateLiveReport,
  validateLiveJob,
  validateLivePreview,
  latestLiveJob,
  updateLiveJobs,
  type LiveJob,
} from './live-proof';
const report = {
  state: 'inconclusive',
  mode: 'live',
  hostVersion: '1.0',
  requestsMade: 2,
  probes: [
    {
      id: 'deny',
      kind: 'deny',
      mark: 'inconclusive',
      evidence: { E1: true, E2: null, E3: null, E4: null },
    },
  ],
  caveats: ['A control did not finish.'],
  advice: ['Run the check again.'],
};
describe('live proof boundary', () => {
  it('preserves all 24 retained attempts when a dialog updates the active job', () => {
    const jobs = Array.from({ length: 24 }, (_, index) => ({
      schema: 'stroq-live-job/1',
      id: `job-${index}`,
      agent: 'codex',
      maxRequests: 3,
      status: 'running',
      startedAt: `2026-10-23T01:00:${String(index).padStart(2, '0')}.000Z`,
    })) as LiveJob[];
    const updated: LiveJob = {
      ...jobs[23]!,
      status: 'failed',
      finishedAt: '2026-10-23T01:01:00.000Z',
    };
    const merged = updateLiveJobs(jobs, updated);
    expect(merged).toHaveLength(24);
    expect(merged[0]?.id).toBe('job-0');
    expect(merged[23]).toEqual(updated);
    expect(jobs[23]?.status).toBe('running');
    expect(
      updateLiveJobs(merged, { ...updated, id: 'new', startedAt: '2026-10-23T01:02:00.000Z' }),
    ).toHaveLength(24);
    expect(
      updateLiveJobs(merged, { ...updated, id: 'new', startedAt: '2026-10-23T01:02:00.000Z' })[0]
        ?.id,
    ).toBe('job-1');
  });
  it('shows the newest attempt even when an earlier one passed', () => {
    const first = {
      schema: 'stroq-live-job/1',
      id: 'old',
      agent: 'claude-code',
      maxRequests: 3,
      status: 'completed',
      startedAt: '2026-10-23T01:00:00.000Z',
      finishedAt: '2026-10-23T01:00:01.000Z',
      result: { ...report, state: 'verified' },
    } as LiveJob;
    const newer = {
      ...first,
      id: 'new',
      startedAt: '2026-10-23T02:00:00.000Z',
      result: report,
    } as LiveJob;
    expect(latestLiveJob([first, newer], 'claude-code')?.id).toBe('new');
  });
  it('accepts inconclusive evidence but never upgrades it or a stand-in to verified', () => {
    expect(validateLiveReport(report)).toBe(true);
    expect(validateLiveReport({ ...report, state: 'verified' })).toBe(false);
    expect(
      validateLiveReport({
        ...report,
        state: 'verified',
        mode: 'stand-in',
        probes: [{ ...report.probes[0], mark: 'passed' }],
      }),
    ).toBe(false);
    expect(
      validateLiveReport({
        ...report,
        state: 'verified',
        probes: [{ ...report.probes[0], mark: 'passed' }],
      }),
    ).toBe(true);
  });
  it('rejects raw transcript fields and prematurely completed jobs', () => {
    expect(validateLiveReport({ ...report, stdout: 'private transcript' })).toBe(false);
    expect(
      validateLiveJob({
        schema: 'stroq-live-job/1',
        id: 'job',
        agent: 'claude-code',
        maxRequests: 3,
        status: 'completed',
        startedAt: '2026-10-23T01:00:00.000Z',
        result: report,
      }),
    ).toBe(false);
  });
  it('binds consent disclosure to an actual capped request budget', () => {
    const preview = {
      schema: 'stroq-live-preview/1',
      id: 'preview',
      agent: 'claude-code',
      maxRequests: 3,
      createdAt: '2026-10-23T01:00:00.000Z',
      expiresAt: '2026-10-23T01:02:00.000Z',
      engineVersion: '0.28.0',
      hostVersion: '1.0',
      policySha256: 'a'.repeat(64),
      target: 'isolated-host',
      supported: true,
      canStart: true,
      disclosure: {
        usesSubscription: true,
        maxRequests: 3,
        externalRequests: true,
        temporaryProject: true,
        checks: ['allow', 'deny', 'control'],
        optionalSecretEgress: false,
      },
    };
    expect(validateLivePreview(preview)).toBe(true);
    expect(
      validateLivePreview({ ...preview, disclosure: { ...preview.disclosure, maxRequests: 6 } }),
    ).toBe(false);
    expect(validateLivePreview({ ...preview, maxRequests: 100 })).toBe(false);
  });
});
