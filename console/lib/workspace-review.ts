import { closed, count, hash, member, stamp, text } from './local-guards';

export const WORKSPACE_REVIEW_LIMITATIONS = [
  'This is a bounded static reading of captured workspace configuration, not an execution or native workspace-trust decision.',
  'Commands, hooks, tasks, dependencies and MCP servers were not started, installed, fetched or sent to a model.',
  'Review records derived source fingerprints and execution-surface signals only. It does not trust the folder, enable execution or establish host enforcement.',
  'Only complete captures with the same analysis profile and runtime can establish source and semantic differences. Refresh never accepts a new baseline.',
  'File fingerprints include raw bytes and modes; structural fingerprints cover relevant directory markers or link targets. Ordinary source-code changes outside the inspected surface do not change this capture.',
  'A capture is not an atomic filesystem snapshot or a guarantee about later changes. Read gaps, unsafe metadata and limits remain explicit.',
  'History retains at most 32 local attempts within 8 MiB; older reports can be evicted. The explicit reviewed baseline is retained separately.',
  'Server-selected Stroq storage strictly inside the workspace is excluded from execution-surface traversal; the declared exclusion scope is fingerprinted and must match for comparison.',
] as const;
export const WORKSPACE_REVIEW_ERRORS = [
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'workspace-review-busy',
  'history-unavailable',
  'baseline-unavailable',
  'stale-capture',
  'stale-baseline',
  'incomplete-capture',
  'deadline-exceeded',
  'output-limit',
  'invalid-report',
  'server-stopped',
  'cancelled',
  'write-unconfirmed',
  'workspace-review-failed',
] as const;
export type WorkspaceReviewError = (typeof WORKSPACE_REVIEW_ERRORS)[number];
export const WORKSPACE_REVIEW_GAPS = [
  'unreadable',
  'invalid-utf8',
  'not-regular',
  'too-large',
  'limit',
  'outside-root',
  'source-changed',
  'unparsed',
  'git-metadata-unverified',
  'enclosing-repository',
  'nested-repository',
  'projection-limit',
] as const;
export const WORKSPACE_REVIEW_KINDS = [
  'agent-hook',
  'agent-helper-command',
  'agent-api-redirect',
  'agent-env',
  'agent-permission-bypass',
  'agent-broad-allow',
  'agent-plugin',
  'mcp-auto-approve',
  'mcp-server-runs-code',
  'mcp-server',
  'editor-autorun-task',
  'agent-definition-hook',
  'instruction-hidden-text',
  'instruction-file',
  'binary-file',
  'devcontainer-host-command',
  'devcontainer-command',
  'devcontainer-setting',
  'package-script-agent-path',
  'package-script',
  'nested-bare-repo',
  'unreadable-config',
  'config-link-outside',
  'config-submodule',
  'agent-run-file-changed',
  'git-hook-file',
  'git-config-exec',
  'git-config-include',
  'gitattributes-driver',
  'git-hook-routine',
  'git-hook',
  'husky-hook',
  'envrc',
  'package-install-script',
] as const;
export type WorkspaceReviewKind = (typeof WORKSPACE_REVIEW_KINDS)[number];
export interface WorkspaceReviewSource {
  id: string;
  kind: 'file' | 'directory' | 'link';
  role: 'workspace' | 'git-metadata';
  label: string;
  labelHidden: boolean;
  sha256: string;
  mode: number;
}
export interface WorkspaceReviewEntry {
  id: string;
  sourceId: string;
  kind: WorkspaceReviewKind;
  stage: 'pre-trust' | 'on-open' | 'instructions';
  severity: 'error' | 'warning' | 'notice';
  line: number | null;
  count: number;
  semanticSha256: string;
}
export interface WorkspaceReviewCapture {
  schema: 'stroq-workspace-capture/1';
  workspaceId: string;
  capturedAt: string;
  captureSha256: string;
  profile: {
    id: 'stroq-workspace-surface/1';
    engineVersion: string;
    runtimeSha256: string;
    scopeSha256: string;
  };
  complete: boolean;
  coverage: {
    omittedSources: number;
    omittedEntries: number;
    exclusions: 'stroq-state'[];
    gaps: {
      code: (typeof WORKSPACE_REVIEW_GAPS)[number];
      sourceId: string | null;
      label: string | null;
      labelHidden: boolean;
    }[];
  };
  sources: WorkspaceReviewSource[];
  entries: WorkspaceReviewEntry[];
}
export interface WorkspaceReviewBaseline {
  status: 'missing' | 'available' | 'invalid';
  revision: string | null;
  reviewedAt: string | null;
  capture: WorkspaceReviewCapture | null;
}
export interface WorkspaceReviewSourceDelta {
  id: string;
  label: string;
  labelHidden: boolean;
  state: 'added' | 'removed' | 'changed';
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeMode: number | null;
  afterMode: number | null;
}
export interface WorkspaceReviewComparison {
  status: 'comparable' | 'missing' | 'unavailable';
  reason: null | 'no-baseline' | 'baseline-unavailable' | 'incomplete' | 'profile-changed';
  sources: WorkspaceReviewSourceDelta[];
  entries: { added: WorkspaceReviewEntry[]; removed: WorkspaceReviewEntry[]; unchanged: number };
}
export interface WorkspaceReviewResult {
  capture: WorkspaceReviewCapture;
  baseline: WorkspaceReviewBaseline;
  comparison: WorkspaceReviewComparison;
  canReview: boolean;
}
export interface WorkspaceReviewRun {
  schema: 'stroq-workspace-review-run/1';
  id: string;
  workspaceId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  result?: WorkspaceReviewResult;
  error?: WorkspaceReviewError;
}
export interface WorkspaceReviewState {
  schema: 'stroq-workspace-review/1';
  workspaceId: string;
  engine: { available: boolean; version: string | null };
  history: { status: 'ready' | 'error'; error?: string };
  baseline: WorkspaceReviewBaseline;
  runs: WorkspaceReviewRun[];
}
export interface WorkspaceReviewReceipt {
  schema: 'stroq-workspace-review-receipt/1';
  workspaceId: string;
  runId: string;
  captureSha256: string;
  revision: string;
  reviewedAt: string;
  reviewOnly: true;
  hostEnforcement: false;
}

const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const workspace = (v: unknown) => typeof v === 'string' && /^workspace-[a-f0-9]{24}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const id = (v: unknown, prefix: string) =>
  typeof v === 'string' && v.startsWith(prefix) && hash(v.slice(prefix.length));
export const isWorkspaceReviewLabel = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 160 &&
  v.split('/').every((p) => p !== '.' && p !== '..' && /^[A-Za-z0-9_. -]{1,80}$/.test(p));
export function validateWorkspaceReviewSource(v: unknown): v is WorkspaceReviewSource {
  return (
    exact(v, ['id', 'kind', 'role', 'label', 'labelHidden', 'sha256', 'mode']) &&
    id(v.id, 'source-') &&
    member(v.kind, ['file', 'directory', 'link']) &&
    member(v.role, ['workspace', 'git-metadata']) &&
    isWorkspaceReviewLabel(v.label) &&
    typeof v.labelHidden === 'boolean' &&
    hash(v.sha256) &&
    count(v.mode, 511)
  );
}
export function validateWorkspaceReviewEntry(v: unknown): v is WorkspaceReviewEntry {
  return (
    exact(v, ['id', 'sourceId', 'kind', 'stage', 'severity', 'line', 'count', 'semanticSha256']) &&
    id(v.id, 'entry-') &&
    id(v.sourceId, 'source-') &&
    member(v.kind, WORKSPACE_REVIEW_KINDS) &&
    member(v.stage, ['pre-trust', 'on-open', 'instructions']) &&
    member(v.severity, ['error', 'warning', 'notice']) &&
    (v.line === null || (count(v.line, 10000000) && v.line > 0)) &&
    count(v.count, 1000000) &&
    v.count > 0 &&
    hash(v.semanticSha256)
  );
}
export function validateWorkspaceReviewCapture(v: unknown): v is WorkspaceReviewCapture {
  if (
    !exact(v, [
      'schema',
      'workspaceId',
      'capturedAt',
      'captureSha256',
      'profile',
      'complete',
      'coverage',
      'sources',
      'entries',
    ]) ||
    v.schema !== 'stroq-workspace-capture/1' ||
    !workspace(v.workspaceId) ||
    !stamp(v.capturedAt) ||
    !hash(v.captureSha256) ||
    !exact(v.profile, ['id', 'engineVersion', 'runtimeSha256', 'scopeSha256']) ||
    v.profile.id !== 'stroq-workspace-surface/1' ||
    !text(v.profile.engineVersion, 100) ||
    !hash(v.profile.runtimeSha256) ||
    !hash(v.profile.scopeSha256) ||
    typeof v.complete !== 'boolean' ||
    !exact(v.coverage, ['omittedSources', 'omittedEntries', 'gaps', 'exclusions']) ||
    !Array.isArray(v.coverage.exclusions) ||
    v.coverage.exclusions.length > 1 ||
    !v.coverage.exclusions.every((e) => e === 'stroq-state') ||
    !count(v.coverage.omittedSources, 1000000) ||
    !count(v.coverage.omittedEntries, 1000000) ||
    !Array.isArray(v.coverage.gaps) ||
    v.coverage.gaps.length > 1024 ||
    !v.coverage.gaps.every(
      (g) =>
        exact(g, ['code', 'sourceId', 'label', 'labelHidden']) &&
        member(g.code, WORKSPACE_REVIEW_GAPS) &&
        typeof g.labelHidden === 'boolean' &&
        (g.sourceId === null
          ? g.label === null && g.labelHidden === false
          : id(g.sourceId, 'source-') && isWorkspaceReviewLabel(g.label)),
    ) ||
    !Array.isArray(v.sources) ||
    v.sources.length > 512 ||
    !v.sources.every(validateWorkspaceReviewSource) ||
    !Array.isArray(v.entries) ||
    v.entries.length > 1024 ||
    !v.entries.every(validateWorkspaceReviewEntry)
  )
    return false;
  const sourceIds = new Set(v.sources.map((s) => s.id));
  return (
    sourceIds.size === v.sources.length &&
    new Set(v.entries.map((e) => e.id)).size === v.entries.length &&
    v.entries.every((e) => sourceIds.has(e.sourceId)) &&
    v.complete ===
      (v.coverage.omittedSources === 0 &&
        v.coverage.omittedEntries === 0 &&
        v.coverage.gaps.length === 0) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= 1048576
  );
}
export function validateWorkspaceReviewBaseline(v: unknown): v is WorkspaceReviewBaseline {
  if (
    !exact(v, ['status', 'revision', 'reviewedAt', 'capture']) ||
    !member(v.status, ['missing', 'available', 'invalid'])
  )
    return false;
  return v.status === 'available'
    ? hash(v.revision) &&
        stamp(v.reviewedAt) &&
        validateWorkspaceReviewCapture(v.capture) &&
        v.capture.complete &&
        v.capture.capturedAt <= v.reviewedAt
    : v.revision === null && v.reviewedAt === null && v.capture === null;
}
export function deriveWorkspaceReviewComparison(
  capture: WorkspaceReviewCapture,
  baseline: WorkspaceReviewBaseline,
): WorkspaceReviewComparison {
  const empty = { sources: [], entries: { added: [], removed: [], unchanged: 0 } };
  if (baseline.status === 'missing') return { status: 'missing', reason: 'no-baseline', ...empty };
  if (baseline.status !== 'available' || baseline.capture === null)
    return { status: 'unavailable', reason: 'baseline-unavailable', ...empty };
  const before = baseline.capture;
  if (!capture.complete || !before.complete)
    return { status: 'unavailable', reason: 'incomplete', ...empty };
  if (
    capture.workspaceId !== before.workspaceId ||
    capture.profile.id !== before.profile.id ||
    capture.profile.engineVersion !== before.profile.engineVersion ||
    capture.profile.runtimeSha256 !== before.profile.runtimeSha256 ||
    capture.profile.scopeSha256 !== before.profile.scopeSha256
  )
    return { status: 'unavailable', reason: 'profile-changed', ...empty };
  const old = new Map(before.sources.map((s) => [s.id, s])),
    current = new Map(capture.sources.map((s) => [s.id, s]));
  const sources: WorkspaceReviewSourceDelta[] = [];
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const a = old.get(key),
      b = current.get(key),
      label = b ?? a!;
    if (a && b && a.sha256 === b.sha256 && a.mode === b.mode && a.kind === b.kind) continue;
    sources.push({
      id: key,
      label: label.label,
      labelHidden: label.labelHidden,
      state: !a ? 'added' : !b ? 'removed' : 'changed',
      beforeSha256: a?.sha256 ?? null,
      afterSha256: b?.sha256 ?? null,
      beforeMode: a?.mode ?? null,
      afterMode: b?.mode ?? null,
    });
  }
  const oldEntries = new Map(before.entries.map((e) => [e.id, e])),
    newEntries = new Map(capture.entries.map((e) => [e.id, e]));
  const added = capture.entries.filter(
    (e) => !oldEntries.has(e.id) || oldEntries.get(e.id)!.count !== e.count,
  );
  const removed = before.entries.filter(
    (e) => !newEntries.has(e.id) || newEntries.get(e.id)!.count !== e.count,
  );
  const unchanged = capture.entries.filter((e) => oldEntries.get(e.id)?.count === e.count).length;
  return { status: 'comparable', reason: null, sources, entries: { added, removed, unchanged } };
}
export function validateWorkspaceReviewResult(v: unknown): v is WorkspaceReviewResult {
  return (
    exact(v, ['capture', 'baseline', 'comparison', 'canReview']) &&
    validateWorkspaceReviewCapture(v.capture) &&
    validateWorkspaceReviewBaseline(v.baseline) &&
    (v.baseline.capture === null || v.baseline.capture.workspaceId === v.capture.workspaceId) &&
    typeof v.canReview === 'boolean' &&
    v.canReview === (v.capture.complete && v.baseline.status !== 'invalid') &&
    JSON.stringify(v.comparison) ===
      JSON.stringify(deriveWorkspaceReviewComparison(v.capture, v.baseline))
  );
}
export function validateWorkspaceReviewRun(v: unknown): v is WorkspaceReviewRun {
  if (
    !closed(v, [
      'schema',
      'id',
      'workspaceId',
      'status',
      'startedAt',
      'finishedAt',
      'result',
      'error',
    ]) ||
    v.schema !== 'stroq-workspace-review-run/1' ||
    !uuid(v.id) ||
    !workspace(v.workspaceId) ||
    !member(v.status, ['running', 'completed', 'failed', 'cancelled']) ||
    !stamp(v.startedAt)
  )
    return false;
  if (v.status === 'running')
    return (
      !Object.hasOwn(v, 'finishedAt') && !Object.hasOwn(v, 'result') && !Object.hasOwn(v, 'error')
    );
  if (!stamp(v.finishedAt) || v.finishedAt < v.startedAt) return false;
  return v.status === 'completed'
    ? validateWorkspaceReviewResult(v.result) &&
        v.result.capture.workspaceId === v.workspaceId &&
        v.result.capture.capturedAt >= v.startedAt &&
        v.result.capture.capturedAt <= v.finishedAt &&
        !Object.hasOwn(v, 'error')
    : !Object.hasOwn(v, 'result') && member(v.error, WORKSPACE_REVIEW_ERRORS);
}
export function validateWorkspaceReviewState(v: unknown): v is WorkspaceReviewState {
  return (
    exact(v, ['schema', 'workspaceId', 'engine', 'history', 'baseline', 'runs']) &&
    v.schema === 'stroq-workspace-review/1' &&
    workspace(v.workspaceId) &&
    exact(v.engine, ['available', 'version']) &&
    typeof v.engine.available === 'boolean' &&
    (v.engine.available ? text(v.engine.version, 100) : v.engine.version === null) &&
    closed(v.history, ['status', 'error']) &&
    member(v.history.status, ['ready', 'error']) &&
    (v.history.status === 'ready'
      ? !Object.hasOwn(v.history, 'error')
      : member(v.history.error, [
          'unavailable',
          'unsafe-path',
          'invalid-history',
          'read-failed',
          'write-failed',
        ])) &&
    validateWorkspaceReviewBaseline(v.baseline) &&
    (v.baseline.capture === null || v.baseline.capture.workspaceId === v.workspaceId) &&
    Array.isArray(v.runs) &&
    v.runs.length <= 32 &&
    v.runs.every(validateWorkspaceReviewRun) &&
    v.runs.every((r) => r.workspaceId === v.workspaceId) &&
    new Set(v.runs.map((r) => r.id)).size === v.runs.length &&
    v.runs.filter((r) => r.status === 'running').length <= 1
  );
}
export function validateWorkspaceReviewReceipt(v: unknown): v is WorkspaceReviewReceipt {
  return (
    exact(v, [
      'schema',
      'workspaceId',
      'runId',
      'captureSha256',
      'revision',
      'reviewedAt',
      'reviewOnly',
      'hostEnforcement',
    ]) &&
    v.schema === 'stroq-workspace-review-receipt/1' &&
    workspace(v.workspaceId) &&
    uuid(v.runId) &&
    hash(v.captureSha256) &&
    hash(v.revision) &&
    stamp(v.reviewedAt) &&
    v.reviewOnly === true &&
    v.hostEnforcement === false
  );
}
