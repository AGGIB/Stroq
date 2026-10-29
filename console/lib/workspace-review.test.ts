import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceReviewComparison,
  validateWorkspaceReviewCapture,
  validateWorkspaceReviewResult,
  validateWorkspaceReviewRun,
  validateWorkspaceReviewState,
  type WorkspaceReviewBaseline,
  type WorkspaceReviewCapture,
  type WorkspaceReviewRun,
} from './workspace-review';

const sha = 'a'.repeat(64),
  other = 'b'.repeat(64);
const ws = `workspace-${'a'.repeat(24)}`;
const at = '2026-10-24T00:00:03.000Z';
function capture(): WorkspaceReviewCapture {
  return {
    schema: 'stroq-workspace-capture/1',
    workspaceId: ws,
    capturedAt: at,
    captureSha256: sha,
    profile: {
      id: 'stroq-workspace-surface/1',
      engineVersion: '0.28.0',
      runtimeSha256: sha,
      scopeSha256: sha,
    },
    complete: true,
    coverage: { omittedSources: 0, omittedEntries: 0, exclusions: [], gaps: [] },
    sources: [
      {
        id: `source-${sha}`,
        kind: 'file',
        role: 'workspace',
        label: 'package.json',
        labelHidden: false,
        sha256: sha,
        mode: 420,
      },
    ],
    entries: [
      {
        id: `entry-${sha}`,
        sourceId: `source-${sha}`,
        kind: 'package-install-script',
        stage: 'on-open',
        severity: 'warning',
        line: 1,
        count: 1,
        semanticSha256: sha,
      },
    ],
  };
}
function baseline(
  value = { ...capture(), capturedAt: '2026-10-24T00:00:01.000Z' },
): WorkspaceReviewBaseline {
  return {
    status: 'available',
    revision: other,
    reviewedAt: '2026-10-24T00:00:02.000Z',
    capture: value,
  };
}
function run(): WorkspaceReviewRun {
  const current = capture(),
    reviewed = baseline();
  return {
    schema: 'stroq-workspace-review-run/1',
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: ws,
    status: 'completed',
    startedAt: at,
    finishedAt: at,
    result: {
      capture: current,
      baseline: reviewed,
      comparison: deriveWorkspaceReviewComparison(current, reviewed),
      canReview: true,
    },
  };
}

describe('workspace review public evidence boundary', () => {
  it('rejects raw source data, path escapes, unknown signals and disconnected entries', () => {
    expect(validateWorkspaceReviewCapture(capture())).toBe(true);
    const cases: unknown[] = [
      { ...capture(), rawCommand: 'private fixture' },
      { ...capture(), sources: [{ ...capture().sources[0], label: '/private/profile' }] },
      { ...capture(), sources: [{ ...capture().sources[0], label: '../profile' }] },
      { ...capture(), entries: [{ ...capture().entries[0], kind: 'execute-custom-command' }] },
      { ...capture(), entries: [{ ...capture().entries[0], sourceId: `source-${other}` }] },
      { ...capture(), sources: [...capture().sources, capture().sources[0]] },
      { ...capture(), complete: false },
      { ...capture(), coverage: { ...capture().coverage, omittedSources: 1 } },
    ];
    for (const value of cases) expect(validateWorkspaceReviewCapture(value)).toBe(false);
  });

  it('accepts a repository the capture did not read as a gap of an incomplete capture only', () => {
    const gaps = [
      { code: 'enclosing-repository', sourceId: null, label: null, labelHidden: false },
      {
        code: 'nested-repository',
        sourceId: `source-${other}`,
        label: 'vendor/tool/.git',
        labelHidden: false,
      },
    ];
    const partial = { ...capture(), complete: false, coverage: { ...capture().coverage, gaps } };
    expect(validateWorkspaceReviewCapture(partial)).toBe(true);
    expect(validateWorkspaceReviewCapture({ ...partial, complete: true })).toBe(false);
    for (const code of ['parent-repository', 'nested-repo', 'Nested-repository'])
      expect(
        validateWorkspaceReviewCapture({
          ...partial,
          coverage: { ...partial.coverage, gaps: [{ ...gaps[0], code }] },
        }),
      ).toBe(false);
  });

  it('does not establish removals from incomplete captures, runtime changes or scope changes', () => {
    const reviewed = baseline();
    for (const current of [
      { ...capture(), complete: false, coverage: { ...capture().coverage, omittedEntries: 1 } },
      { ...capture(), profile: { ...capture().profile, runtimeSha256: other } },
      { ...capture(), profile: { ...capture().profile, scopeSha256: other } },
    ]) {
      const result = deriveWorkspaceReviewComparison(current, reviewed);
      expect(result.status).toBe('unavailable');
      expect(result.sources).toEqual([]);
      expect(result.entries).toEqual({ added: [], removed: [], unchanged: 0 });
    }
  });

  it('separates file-only edits from changed signals and includes source kind transitions', () => {
    const reviewed = baseline(),
      current = capture();
    current.sources[0]!.sha256 = other;
    const formatted = deriveWorkspaceReviewComparison(current, reviewed);
    expect(formatted.sources).toHaveLength(1);
    expect(formatted.entries).toEqual({ added: [], removed: [], unchanged: 1 });
    const changedKind = capture();
    changedKind.sources[0]!.kind = 'link';
    expect(deriveWorkspaceReviewComparison(changedKind, reviewed).sources).toHaveLength(1);
    current.entries[0] = { ...current.entries[0]!, id: `entry-${other}`, semanticSha256: other };
    const changed = deriveWorkspaceReviewComparison(current, reviewed);
    expect(changed.entries.added).toHaveLength(1);
    expect(changed.entries.removed).toHaveLength(1);
  });

  it('rejects foreign reviewed captures inside a historical result', () => {
    const value = run();
    expect(validateWorkspaceReviewRun(value)).toBe(true);
    value.result!.baseline.capture!.workspaceId = `workspace-${'b'.repeat(24)}`;
    value.result!.comparison = deriveWorkspaceReviewComparison(
      value.result!.capture,
      value.result!.baseline,
    );
    expect(validateWorkspaceReviewResult(value.result)).toBe(false);
    expect(validateWorkspaceReviewRun(value)).toBe(false);
  });

  it('requires a completed capture timestamp to be within its recorded check', () => {
    for (const capturedAt of ['2026-10-24T00:00:00.000Z', '2026-10-24T00:00:04.000Z']) {
      const value = run();
      value.result!.capture.capturedAt = capturedAt;
      expect(validateWorkspaceReviewRun(value)).toBe(false);
    }
  });

  it('checks result consistency, contradictory history and foreign current baselines', () => {
    const item = run();
    const state = {
      schema: 'stroq-workspace-review/1',
      workspaceId: ws,
      engine: { available: true, version: '0.28.0' },
      history: { status: 'ready' },
      baseline: baseline(),
      runs: [item],
    };
    expect(validateWorkspaceReviewState(state)).toBe(true);
    expect(validateWorkspaceReviewResult({ ...item.result, canReview: false })).toBe(false);
    expect(validateWorkspaceReviewState({ ...state, runs: [item, item] })).toBe(false);
    expect(
      validateWorkspaceReviewState({
        ...state,
        baseline: {
          ...baseline(),
          capture: { ...capture(), workspaceId: `workspace-${'b'.repeat(24)}` },
        },
      }),
    ).toBe(false);
    expect(
      validateWorkspaceReviewState({
        ...state,
        history: { status: 'ready', error: 'read-failed' },
      }),
    ).toBe(false);
  });
});
