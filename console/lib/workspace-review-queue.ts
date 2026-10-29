import {
  deriveWorkspaceReviewComparison,
  type WorkspaceReviewCapture,
  type WorkspaceReviewEntry,
  type WorkspaceReviewRun,
  type WorkspaceReviewSource,
  type WorkspaceReviewState,
} from './workspace-review';
import { workspaceReviewHref } from './workspace-review-navigation';
import { WORKSPACE_REVIEW_LABELS } from './workspace-review-labels';
import type { ProtectionEvidenceRow } from './protection-evidence';

export const WORKSPACE_ERROR_ATTENTION_LIMIT = 6;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const orderedRuns = (state: WorkspaceReviewState) =>
  state.runs.toSorted((a, b) => compare(b.startedAt, a.startedAt) || compare(a.id, b.id));
function workspaceReviewNotices(
  state: WorkspaceReviewState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  const row = (
    key: string,
    title: string,
    detail: string,
    tone: ProtectionEvidenceRow['tone'] = 'orange',
    runId: string | null = null,
  ): ProtectionEvidenceRow[] => [
    {
      key: `workspace-review-${key}`,
      title,
      detail,
      href: workspaceReviewHref(runId, workspaceId),
      action: 'Review workspace',
      tone,
    },
  ];
  if (!state || !workspaceId || state.workspaceId !== workspaceId)
    return row(
      'unavailable',
      'Workspace-check history unavailable',
      'No completed workspace capture was inferred.',
    );
  if (state.history.status !== 'ready')
    return row(
      'history',
      'Workspace-check history could not be verified',
      'Open saved checks to review this coverage gap.',
    );
  if (state.baseline.status === 'invalid')
    return row(
      'baseline',
      'Reviewed workspace baseline unavailable',
      'Saved review evidence could not be verified.',
    );
  if (!state.engine.available)
    return row(
      'runtime',
      'Workspace analysis runtime unavailable',
      'A fresh workspace check cannot start. Saved captures remain historical.',
    );
  const latest = orderedRuns(state)[0];
  if (!latest)
    return row(
      'first',
      'Check this workspace before opening it',
      'Capture startup actions and agent instructions without running them.',
      'muted',
    );
  if (latest.status === 'running')
    return row(
      'running',
      'Workspace check is running',
      `Started ${latest.startedAt}. No completed capture is available.`,
      'muted',
      latest.id,
    );
  if (latest.status !== 'completed' || !latest.result)
    return row(
      'incomplete',
      'Latest workspace check did not finish',
      `Recorded ${latest.finishedAt ?? latest.startedAt}. No completed capture is available.`,
      'orange',
      latest.id,
    );
  const capture = latest.result.capture;
  if (!capture.complete)
    return row(
      'partial',
      'Workspace capture has coverage gaps',
      `Captured ${capture.capturedAt}. ${capture.coverage.gaps.length} gaps · ${capture.coverage.omittedSources} sources and ${capture.coverage.omittedEntries} signals omitted.`,
      'orange',
      latest.id,
    );
  const comparison = deriveWorkspaceReviewComparison(capture, state.baseline);
  if (comparison.status === 'unavailable')
    return row(
      'comparison',
      'Workspace changes could not be compared',
      `Captured ${capture.capturedAt}. The reviewed capture and analysis profile cannot establish comparable coverage.`,
      'orange',
      latest.id,
    );
  if (comparison.status === 'missing')
    return row(
      'unreviewed',
      capture.entries.length === 0
        ? 'Workspace capture awaiting first review'
        : `${capture.entries.length} workspace signals awaiting first review`,
      `Captured ${capture.capturedAt}. No reviewed baseline has been recorded.`,
      'muted',
      latest.id,
    );
  if (
    comparison.sources.length ||
    comparison.entries.added.length ||
    comparison.entries.removed.length
  )
    return row(
      'changes',
      'Workspace changed since recorded review',
      `Captured ${capture.capturedAt}. ${comparison.sources.length} source fingerprints · ${comparison.entries.added.length} signals added · ${comparison.entries.removed.length} removed.`,
      'orange',
      latest.id,
    );
  if (capture.captureSha256 !== state.baseline.capture?.captureSha256)
    return row(
      'version',
      'Captured workspace version differs from recorded review',
      `Captured ${capture.capturedAt}. No source or signal differences were identified. Open the exact capture before recording review.`,
      'orange',
      latest.id,
    );
  return [];
}

type Observation = {
  run: WorkspaceReviewRun;
  capture: WorkspaceReviewCapture;
  source: WorkspaceReviewSource;
  entry: WorkspaceReviewEntry;
  profile: string;
};
const profileKey = (capture: WorkspaceReviewCapture) =>
  JSON.stringify([
    capture.profile.id,
    capture.profile.engineVersion,
    capture.profile.runtimeSha256,
    capture.profile.scopeSha256,
  ]);
/** Retained observations only. Partial or incompatible analysis cannot establish absence. */
function workspaceErrorRows(
  state: WorkspaceReviewState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  if (
    !state ||
    !workspaceId ||
    state.workspaceId !== workspaceId ||
    state.history.status !== 'ready'
  )
    return [];
  const runs = orderedRuns(state);
  const completed = runs.filter(
    (run) =>
      run.status === 'completed' &&
      run.workspaceId === workspaceId &&
      run.result?.capture.workspaceId === workspaceId,
  );
  const latestProfile = completed[0]?.result ? profileKey(completed[0].result.capture) : null;
  const sealed = new Set<string>(),
    observed = new Map<string, Observation>();
  for (const run of completed) {
    const capture = run.result!.capture,
      profile = profileKey(capture);
    if (sealed.has(profile)) continue;
    const sources = new Map(capture.sources.map((source) => [source.id, source]));
    for (const entry of capture.entries) {
      if (entry.severity !== 'error') continue;
      const source = sources.get(entry.sourceId);
      if (!source) continue;
      const version = JSON.stringify([
        profile,
        source.id,
        source.kind,
        source.role,
        source.sha256,
        source.mode,
        entry.id,
        entry.semanticSha256,
      ]);
      if (!observed.has(version)) observed.set(version, { run, capture, source, entry, profile });
    }
    if (capture.complete) sealed.add(profile);
  }
  const severity = { error: 0, warning: 1, notice: 2 };
  const all = [...observed.values()].toSorted(
    (a, b) =>
      severity[a.entry.severity] - severity[b.entry.severity] ||
      compare(a.source.label, b.source.label) ||
      compare(a.source.id, b.source.id) ||
      (a.entry.line ?? Number.MAX_SAFE_INTEGER) - (b.entry.line ?? Number.MAX_SAFE_INTEGER) ||
      compare(a.entry.kind, b.entry.kind) ||
      compare(a.entry.id, b.entry.id) ||
      compare(a.profile, b.profile) ||
      compare(a.source.kind, b.source.kind) ||
      compare(a.source.role, b.source.role) ||
      compare(a.source.sha256, b.source.sha256) ||
      a.source.mode - b.source.mode ||
      compare(a.run.id, b.run.id),
  );
  const historical = (item: Observation) => item.run.id !== runs[0]?.id || !state.engine.available;
  const rows: ProtectionEvidenceRow[] = all
    .slice(0, WORKSPACE_ERROR_ATTENTION_LIMIT)
    .map((item) => {
      const { run, capture, source, entry } = item;
      const stamp = `${historical(item) ? 'Historical capture' : 'Captured'} ${capture.capturedAt}`;
      const visibleStamp = `${historical(item) ? 'Historical' : 'Captured'} ${new Date(capture.capturedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`;
      const location = `${source.label}${entry.line === null ? '' : ` · line ${entry.line}`}`;
      return {
        key: `workspace-signal:${run.id}:${entry.id}`,
        title: WORKSPACE_REVIEW_LABELS[entry.kind],
        context: `${location} · ${visibleStamp}`,
        detail: `${location}. ${stamp}. Error-level static signal${entry.count > 1 ? ` · ${entry.count} occurrences` : ''}. Review does not resolve this signal or change execution permissions.${!capture.complete ? ' Partial capture; absence cannot be established.' : ''}${item.profile !== latestProfile ? ' Analysis scope or runtime differs from the latest capture; resolution is unverified.' : ''}`,
        href: workspaceReviewHref(run.id, workspaceId),
        action: 'Inspect signal',
        tone: 'orange',
      };
    });
  const omitted = all.slice(WORKSPACE_ERROR_ATTENTION_LIMIT);
  if (omitted.length) {
    const omittedRuns = new Set(omitted.map((item) => item.run.id));
    rows.push({
      key: 'workspace-signals-overflow',
      title: `${omitted.length} more workspace error ${omitted.length === 1 ? 'signal' : 'signals'}`,
      detail: `Additional error observations in retained reports. Whole-version review does not resolve them.${omitted.some(historical) ? ' Historical captures remain separate from the latest attempt.' : ''}`,
      href:
        omittedRuns.size === 1
          ? workspaceReviewHref(omitted[0]!.run.id, workspaceId)
          : workspaceReviewHref(),
      action: omittedRuns.size === 1 ? 'Inspect all signals' : 'Inspect saved checks',
      tone: 'orange',
    });
  }
  return rows;
}

/** Saved captures only. Reading this projection never scans or accepts a baseline. */
export function workspaceReviewRows(
  state: WorkspaceReviewState | null,
  workspaceId: string | null,
): ProtectionEvidenceRow[] {
  return [...workspaceReviewNotices(state, workspaceId), ...workspaceErrorRows(state, workspaceId)];
}
