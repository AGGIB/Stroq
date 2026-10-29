import { describe, expect, it } from 'vitest';
import { workspaceReviewRows } from './workspace-review-queue';
import {
  deriveWorkspaceReviewComparison,
  validateWorkspaceReviewState,
  type WorkspaceReviewState,
  type WorkspaceReviewEntry,
} from './workspace-review';
const ws = `workspace-${'a'.repeat(24)}`,
  sha = 'a'.repeat(64),
  other = 'b'.repeat(64),
  id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(): WorkspaceReviewState {
  const baseline = { status: 'missing' as const, revision: null, reviewedAt: null, capture: null };
  const capture = {
    schema: 'stroq-workspace-capture/1' as const,
    workspaceId: ws,
    capturedAt: '2026-10-24T00:00:01.000Z',
    captureSha256: sha,
    profile: {
      id: 'stroq-workspace-surface/1' as const,
      engineVersion: '1.0.0',
      runtimeSha256: sha,
      scopeSha256: sha,
    },
    complete: true,
    coverage: { omittedSources: 0, omittedEntries: 0, exclusions: [], gaps: [] },
    sources: [],
    entries: [],
  };
  return {
    schema: 'stroq-workspace-review/1',
    workspaceId: ws,
    engine: { available: true, version: '1.0.0' },
    history: { status: 'ready' },
    baseline,
    runs: [
      {
        schema: 'stroq-workspace-review-run/1',
        id,
        workspaceId: ws,
        status: 'completed',
        startedAt: '2026-10-24T00:00:00.000Z',
        finishedAt: '2026-10-24T00:00:01.000Z',
        result: {
          capture,
          baseline,
          comparison: deriveWorkspaceReviewComparison(capture, baseline),
          canReview: true,
        },
      },
    ],
  };
}
describe('saved workspace evidence in work queue', () => {
  it('never treats missing/foreign or failed history as healthy empty evidence', () => {
    const state = fixture();
    expect(validateWorkspaceReviewState(state)).toBe(true);
    for (const value of [
      null,
      { ...state, workspaceId: `workspace-${'b'.repeat(24)}` },
      { ...state, history: { status: 'error' as const, error: 'read-failed' } },
    ])
      expect(workspaceReviewRows(value, ws)[0]?.tone).toBe('orange');
  });
  it('offers explicit first capture and first review without inventing a leak or scan', () => {
    const state = fixture();
    expect(workspaceReviewRows({ ...state, runs: [] }, ws)[0]).toMatchObject({
      tone: 'muted',
      href: '/protection/workspace/',
    });
    expect(workspaceReviewRows(state, ws)[0]).toMatchObject({
      tone: 'muted',
      title: 'Workspace capture awaiting first review',
      href: `/protection/workspace/?workspace=${ws}&run=${id}`,
    });
  });
  it('explains why a fresh check is unavailable without discarding historical reports', () => {
    const state = fixture();
    state.engine = { available: false, version: null };
    expect(validateWorkspaceReviewState(state)).toBe(true);
    expect(workspaceReviewRows(state, ws)[0]).toMatchObject({
      tone: 'orange',
      title: 'Workspace analysis runtime unavailable',
    });
  });
  it('compares the latest capture with the CURRENT reviewed baseline so recording review clears old deltas', () => {
    const state = fixture();
    state.baseline = {
      status: 'available',
      revision: other,
      reviewedAt: '2026-10-24T00:00:02.000Z',
      capture: structuredClone(state.runs[0]!.result!.capture),
    };
    expect(validateWorkspaceReviewState(state)).toBe(true);
    expect(workspaceReviewRows(state, ws)).toEqual([]);
    state.runs[0]!.result!.capture.sources = [
      {
        id: `source-${sha}`,
        role: 'workspace',
        kind: 'file',
        label: 'package.json',
        labelHidden: false,
        sha256: other,
        mode: 420,
      },
    ];
    expect(workspaceReviewRows(state, ws)[0]).toMatchObject({
      tone: 'orange',
      title: 'Workspace changed since recorded review',
    });
  });
  it('keeps partial captures and incompatible analysis profiles visible without removals or green protection claims', () => {
    const state = fixture(),
      capture = state.runs[0]!.result!.capture;
    capture.complete = false;
    capture.coverage.omittedSources = 1;
    expect(workspaceReviewRows(state, ws)[0]?.title).toMatch(/coverage gaps/);
    capture.complete = true;
    capture.coverage.omittedSources = 0;
    state.baseline = {
      status: 'available',
      revision: other,
      reviewedAt: '2026-10-24T00:00:02.000Z',
      capture: structuredClone(capture),
    };
    state.baseline.capture!.profile.runtimeSha256 = other;
    expect(workspaceReviewRows(state, ws)[0]?.title).toMatch(/could not be compared/);
  });
  it('keeps a different exact capture visible even when no source or signal delta is exposed', () => {
    const state = fixture();
    state.baseline = {
      status: 'available',
      revision: other,
      reviewedAt: '2026-10-24T00:00:02.000Z',
      capture: structuredClone(state.runs[0]!.result!.capture),
    };
    state.runs[0]!.result!.capture.captureSha256 = other;
    expect(workspaceReviewRows(state, ws)[0]).toMatchObject({
      tone: 'orange',
      title: 'Captured workspace version differs from recorded review',
      href: `/protection/workspace/?workspace=${ws}&run=${id}`,
    });
  });
  it('retains latest running or unsuccessful attempts instead of falling back to an older completed capture', () => {
    const state = fixture();
    state.runs.unshift({
      schema: 'stroq-workspace-review-run/1',
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: ws,
      status: 'running',
      startedAt: '2026-10-24T00:01:00.000Z',
    });
    expect(workspaceReviewRows(state, ws)[0]?.title).toMatch(/running/);
    state.runs[0] = {
      ...state.runs[0]!,
      status: 'failed',
      finishedAt: '2026-10-24T00:01:01.000Z',
      error: 'deadline-exceeded',
    };
    expect(workspaceReviewRows(state, ws)[0]?.title).toMatch(/did not finish/);
  });
});

function errorFixture(total = 1): WorkspaceReviewState {
  const state = fixture();
  const capture = state.runs[0]!.result!.capture;
  for (let n = 0; n < total; n++) {
    const digest = String(n + 1).padStart(64, '0');
    const kinds: WorkspaceReviewEntry['kind'][] = [
      'instruction-hidden-text',
      'editor-autorun-task',
      'agent-permission-bypass',
    ];
    capture.sources.push({
      id: `source-${digest}`,
      kind: 'file',
      role: 'workspace',
      label: ['AGENTS.md', '.vscode/tasks.json', '.claude/settings.json'][n % 3]!,
      labelHidden: false,
      sha256: digest,
      mode: 420,
    });
    capture.entries.push({
      id: `entry-${digest}`,
      sourceId: `source-${digest}`,
      kind: kinds[n % 3]!,
      stage: n % 3 === 0 ? 'instructions' : 'on-open',
      severity: 'error',
      line: n + 1,
      count: 1,
      semanticSha256: digest,
    });
  }
  state.baseline = {
    status: 'available',
    revision: other,
    reviewedAt: '2026-10-24T00:00:02.000Z',
    capture: structuredClone(capture),
  };
  return state;
}
const signals = (state: WorkspaceReviewState) =>
  workspaceReviewRows(state, ws).filter((row) => row.key.startsWith('workspace-signal:'));
describe('workspace error signals remain independent of whole-version review', () => {
  it('orders one source by numeric line with unknown lines last before kind and opaque identity ties', () => {
    const state = errorFixture(6),
      capture = state.runs[0]!.result!.capture,
      source = capture.sources[0]!;
    capture.sources = [source];
    const lines = [49, 97, 37, 25, null, 37];
    capture.entries.forEach((entry, index) => {
      entry.sourceId = source.id;
      entry.line = lines[index]!;
    });
    capture.entries[2]!.kind = 'agent-permission-bypass';
    capture.entries[5]!.kind = 'editor-autorun-task';
    state.baseline.capture = structuredClone(capture);
    expect(validateWorkspaceReviewState(state)).toBe(true);
    const rows = signals(state);
    expect(rows.map((row) => Number(row.context?.match(/line (\d+)/)?.[1]) || null)).toEqual([
      25,
      37,
      37,
      49,
      97,
      null,
    ]);
    expect(rows[1]?.title).toBe('Agent permission bypass');
    expect(rows[2]?.title).toBe('Editor automatic task');
    capture.entries.reverse();
    expect(signals(state)).toEqual(rows);
  });
  it('uses compact en-GB local date and minute in visible context while preserving exact ISO evidence', () => {
    const state = errorFixture(),
      run = state.runs[0]!,
      timestamp = '2026-10-24T10:00:28.713Z';
    run.startedAt = '2026-10-24T10:00:00.000Z';
    run.finishedAt = '2026-10-24T10:00:29.000Z';
    run.result!.capture.capturedAt = timestamp;
    state.baseline.capture = structuredClone(run.result!.capture);
    state.baseline.reviewedAt = '2026-10-24T10:01:00.000Z';
    const compact = new Date(timestamp).toLocaleString('en-GB', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    expect(signals(state)[0]).toMatchObject({
      context: `AGENTS.md · line 1 · Captured ${compact}`,
      detail: expect.stringContaining(timestamp),
    });
    expect(signals(state)[0]?.context).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:|\.713Z/);
    state.engine.available = false;
    expect(signals(state)[0]).toMatchObject({
      context: `AGENTS.md · line 1 · Historical ${compact}`,
      detail: expect.stringContaining(`Historical capture ${timestamp}`),
    });
  });
  it('retains error signals after exact baseline review with source, capture time and exact saved-run links', () => {
    const state = errorFixture(3),
      before = structuredClone(state);
    expect(validateWorkspaceReviewState(state)).toBe(true);
    const rows = signals(state);
    expect(rows).toHaveLength(3);
    for (const [label, source] of [
      ['Hidden instruction text', 'AGENTS.md'],
      ['Editor automatic task', '.vscode/tasks.json'],
      ['Agent permission bypass', '.claude/settings.json'],
    ]) {
      const row = rows.find((row) => row.title === label);
      expect(row).toMatchObject({
        context: expect.stringContaining(source!),
        href: `/protection/workspace/?workspace=${ws}&run=${id}`,
        action: 'Inspect signal',
        tone: 'orange',
      });
      expect(row?.detail).toContain('2026-10-24T00:00:01.000Z');
      expect(row?.detail).toContain('Review does not resolve');
      expect(row?.detail).not.toMatch(/protected|verified blocking|execution prevented/i);
    }
    expect(state).toEqual(before);
  });
  it('leaves reviewed warnings and notices routine without mandatory signal attention', () => {
    const state = errorFixture(2);
    state.runs[0]!.result!.capture.entries[0]!.severity = 'warning';
    state.runs[0]!.result!.capture.entries[1]!.severity = 'notice';
    state.baseline.capture = structuredClone(state.runs[0]!.result!.capture);
    expect(workspaceReviewRows(state, ws)).toEqual([]);
  });
  it('retains observed errors alongside partial-coverage and invalid-baseline notices', () => {
    const state = errorFixture();
    state.runs[0]!.result!.capture.complete = false;
    state.runs[0]!.result!.capture.coverage.omittedSources = 1;
    expect(
      workspaceReviewRows(state, ws).some(
        (row) => row.title === 'Workspace capture has coverage gaps',
      ),
    ).toBe(true);
    expect(signals(state)).toHaveLength(1);
    expect(signals(state)[0]?.detail).toContain('Partial capture');
    state.baseline = { status: 'invalid', revision: null, reviewedAt: null, capture: null };
    expect(
      workspaceReviewRows(state, ws).some(
        (row) => row.title === 'Reviewed workspace baseline unavailable',
      ),
    ).toBe(true);
    expect(signals(state)).toHaveLength(1);
  });
  it('keeps the first-review notice separate from error attention', () => {
    const state = errorFixture();
    state.baseline = { status: 'missing', revision: null, reviewedAt: null, capture: null };
    expect(
      workspaceReviewRows(state, ws).some(
        (row) => row.title === '1 workspace signals awaiting first review',
      ),
    ).toBe(true);
    expect(signals(state)).toHaveLength(1);
  });
  it('preserves exact older signals as historical when a newer attempt is running, failed or cancelled', () => {
    for (const status of ['running', 'failed', 'cancelled'] as const) {
      const state = errorFixture();
      state.runs.unshift({
        schema: 'stroq-workspace-review-run/1',
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        workspaceId: ws,
        status,
        startedAt: '2026-10-24T00:01:00.000Z',
        ...(status === 'running'
          ? {}
          : {
              finishedAt: '2026-10-24T00:01:01.000Z',
              error: status === 'failed' ? ('deadline-exceeded' as const) : ('cancelled' as const),
            }),
      });
      expect(validateWorkspaceReviewState(state)).toBe(true);
      expect(workspaceReviewRows(state, ws)).toHaveLength(2);
      expect(signals(state)[0]).toMatchObject({
        context: expect.stringContaining('Historical'),
        detail: expect.stringContaining('Historical capture'),
        href: `/protection/workspace/?workspace=${ws}&run=${id}`,
      });
    }
  });
  it('preserves historical signals alongside runtime-unavailable notice without trusting unreadable or foreign history', () => {
    const state = errorFixture();
    state.engine = { available: false, version: null };
    expect(
      workspaceReviewRows(state, ws).some(
        (row) => row.title === 'Workspace analysis runtime unavailable',
      ),
    ).toBe(true);
    expect(signals(state)[0]?.context).toContain('Historical');
    state.history = { status: 'error', error: 'read-failed' };
    expect(signals(state)).toEqual([]);
    state.history = { status: 'ready' };
    expect(
      workspaceReviewRows({ ...state, workspaceId: `workspace-${'f'.repeat(24)}` }, ws).some(
        (row) => row.key.startsWith('workspace-signal:'),
      ),
    ).toBe(false);
  });
  it('does not infer older errors absent from a newer partial capture and deduplicates reobserved signals', () => {
    const state = errorFixture(2),
      earlier = state.runs[0]!;
    const latest = structuredClone(earlier);
    latest.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    latest.startedAt = '2026-10-24T00:01:00.000Z';
    latest.finishedAt = '2026-10-24T00:01:01.000Z';
    latest.result!.capture.capturedAt = latest.finishedAt;
    latest.result!.capture.complete = false;
    latest.result!.capture.coverage.omittedSources = 1;
    latest.result!.capture.entries = [latest.result!.capture.entries[0]!];
    state.runs.unshift(latest);
    expect(signals(state)).toHaveLength(2);
    expect(signals(state).filter((row) => row.context?.includes('Historical'))).toHaveLength(1);
    expect(signals(state).find((row) => row.title === 'Hidden instruction text')?.href).toContain(
      latest.id,
    );
    latest.result!.capture.entries = [];
    expect(signals(state)).toHaveLength(2);
    expect(signals(state).every((row) => row.context?.includes('Historical'))).toBe(true);
  });
  it('uses a newer complete capture as the boundary instead of resurrecting older errors', () => {
    const state = errorFixture(),
      latest = structuredClone(state.runs[0]!);
    latest.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    latest.startedAt = '2026-10-24T00:01:00.000Z';
    latest.finishedAt = '2026-10-24T00:01:01.000Z';
    latest.result!.capture.capturedAt = latest.finishedAt;
    latest.result!.capture.entries = [];
    state.runs.unshift(latest);
    expect(signals(state)).toEqual([]);
  });
  it('does not collapse a repeated semantic ID across changed source fingerprints, modes or kinds', () => {
    for (const change of ['sha256', 'mode', 'kind'] as const) {
      const state = errorFixture(),
        latest = structuredClone(state.runs[0]!);
      latest.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      latest.startedAt = '2026-10-24T00:01:00.000Z';
      latest.finishedAt = '2026-10-24T00:01:01.000Z';
      latest.result!.capture.capturedAt = latest.finishedAt;
      latest.result!.capture.complete = false;
      latest.result!.capture.coverage.omittedSources = 1;
      const source = latest.result!.capture.sources[0]!;
      if (change === 'sha256') source.sha256 = other;
      else if (change === 'mode') source.mode = 493;
      else source.kind = 'link';
      state.runs.unshift(latest);
      const rows = signals(state);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.context?.includes('Historical'))).toHaveLength(1);
      expect(new Set(rows.map((row) => row.key)).size).toBe(2);
      expect(rows.find((row) => row.context?.includes('Historical'))?.href).toContain(id);
    }
  });
  it('preserves historical errors from another analysis profile after a complete clean capture and baseline review', () => {
    for (const field of ['runtimeSha256', 'scopeSha256', 'engineVersion'] as const) {
      const state = errorFixture(),
        latest = structuredClone(state.runs[0]!);
      latest.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      latest.startedAt = '2026-10-24T00:01:00.000Z';
      latest.finishedAt = '2026-10-24T00:01:01.000Z';
      latest.result!.capture.capturedAt = latest.finishedAt;
      latest.result!.capture.profile[field] = field === 'engineVersion' ? '2.0.0' : other;
      latest.result!.capture.entries = [];
      state.runs.unshift(latest);
      state.baseline.capture = structuredClone(latest.result!.capture);
      const rows = signals(state);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.context).toContain('Historical');
      expect(rows[0]?.detail).toContain('Analysis scope or runtime differs');
      expect(rows[0]?.href).toContain(id);
    }
  });
  it('bounds individual rows to six with deterministic source and opaque-ID ordering plus exact overflow handoff', () => {
    const state = errorFixture(9);
    const first = workspaceReviewRows(state, ws),
      ordered = signals(state);
    expect(ordered).toHaveLength(6);
    const overflow = first.find((row) => row.key === 'workspace-signals-overflow');
    expect(overflow).toMatchObject({
      title: '3 more workspace error signals',
      action: 'Inspect all signals',
      href: `/protection/workspace/?workspace=${ws}&run=${id}`,
    });
    state.runs[0]!.result!.capture.entries.reverse();
    state.runs[0]!.result!.capture.sources.reverse();
    expect(workspaceReviewRows(state, ws)).toEqual(first);
    expect(ordered.map((row) => row.context)).toEqual(
      [...ordered.map((row) => row.context)].sort(),
    );
  });
  it('sends multi-capture overflow to saved checks rather than claiming one run contains every omitted observation', () => {
    const state = errorFixture(9),
      latest = structuredClone(state.runs[0]!);
    latest.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    latest.startedAt = '2026-10-24T00:01:00.000Z';
    latest.finishedAt = '2026-10-24T00:01:01.000Z';
    latest.result!.capture.capturedAt = latest.finishedAt;
    latest.result!.capture.complete = false;
    latest.result!.capture.coverage.omittedSources = 1;
    latest.result!.capture.sources.forEach((source) => {
      source.sha256 = other;
    });
    state.runs.unshift(latest);
    expect(signals(state)).toHaveLength(6);
    expect(
      workspaceReviewRows(state, ws).find((row) => row.key === 'workspace-signals-overflow'),
    ).toMatchObject({
      title: '12 more workspace error signals',
      href: '/protection/workspace/',
      action: 'Inspect saved checks',
      detail: expect.stringContaining('Historical captures'),
    });
  });
});
