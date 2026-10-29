import { createHash } from 'node:crypto';
import { redact, stableStringify } from '@stroq/core';
import {
  captureWorkspaceSurface,
  recheckWorkspaceSurface,
} from '../../packages/cli/src/exposure/workspace-surface.js';
import {
  isWorkspaceReviewLabel,
  validateWorkspaceReviewCapture,
  WORKSPACE_REVIEW_KINDS,
  type WorkspaceReviewCapture,
  type WorkspaceReviewEntry,
  type WorkspaceReviewSource,
} from '../lib/workspace-review.js';

export const workspaceHash = (v: string | Uint8Array): string =>
  createHash('sha256').update(v).digest('hex');
type Captured = ReturnType<typeof captureWorkspaceSurface>;
type Profile = WorkspaceReviewCapture['profile'];
const safeLabel = (raw: string, id: string) =>
  isWorkspaceReviewLabel(raw) &&
  redact(raw) === raw &&
  !/(?:[A-Za-z0-9_-]{25}|(?:password|credential|secret|token|private[_-]?key)[^/]*)/i.test(raw)
    ? { label: raw, labelHidden: false }
    : { label: `Source ${id.slice(-8)}`, labelHidden: true };
const sourceKey = (role: string, path: string) => `${role}\0${path}`;
const sourceId = (role: string, path: string) => `source-${workspaceHash(sourceKey(role, path))}`;

/** Project fixed classifications and hashes only. Raw hit labels/values/commands never escape. */
export function projectWorkspaceCapture(
  raw: Captured,
  workspaceId: string,
  capturedAt: string,
  profile: Profile,
): WorkspaceReviewCapture {
  const sources: WorkspaceReviewSource[] = [],
    entries = new Map<string, WorkspaceReviewEntry>();
  const coverage: WorkspaceReviewCapture['coverage'] = {
    omittedSources: 0,
    omittedEntries: 0,
    gaps: [],
    exclusions: profile.scopeSha256 === workspaceHash('[]') ? [] : ['stroq-state'],
  };
  const locations = new Map<string, WorkspaceReviewSource>();
  const gap = (
    code: WorkspaceReviewCapture['coverage']['gaps'][number]['code'],
    path?: string,
    role = 'workspace',
  ) => {
    if (coverage.gaps.length < 1023) {
      const id = path === undefined || path === '.' ? null : sourceId(role, path);
      coverage.gaps.push({
        code,
        sourceId: id,
        ...(id === null
          ? { label: null, labelHidden: false }
          : safeLabel(role === 'git-metadata' ? `git-metadata/${path}` : path!, id)),
      });
    }
  };
  for (const source of raw.sources) {
    if (sources.length === 512) {
      coverage.omittedSources++;
      continue;
    }
    const id = sourceId(source.role, source.path);
    const kind = (source as typeof source & { kind: WorkspaceReviewSource['kind'] }).kind;
    if (!['file', 'directory', 'link'].includes(kind)) throw new Error('invalid-report');
    const label = source.role === 'git-metadata' ? `git-metadata/${source.path}` : source.path;
    const projected: WorkspaceReviewSource = {
      id,
      kind,
      role: source.role,
      ...safeLabel(label, id),
      sha256: source.sha256,
      mode: source.mode & 0o777,
    };
    sources.push(projected);
    locations.set(label, projected);
  }
  for (const observation of raw.observations)
    gap(observation.code, observation.path, observation.role);
  function add(
    kind: string,
    file: string,
    stage: WorkspaceReviewEntry['stage'],
    severity: WorkspaceReviewEntry['severity'],
    semantic: unknown,
    line: number | null,
  ) {
    const source = locations.get(file);
    if (!source || !WORKSPACE_REVIEW_KINDS.includes(kind as WorkspaceReviewEntry['kind'])) {
      coverage.omittedEntries++;
      return;
    }
    const semanticSha256 = workspaceHash(stableStringify({ kind, stage, semantic }));
    const id = `entry-${workspaceHash(`${source.id}\0${semanticSha256}`)}`;
    const previous = entries.get(id);
    if (previous) {
      entries.set(id, { ...previous, count: previous.count + 1 });
      return;
    }
    if (entries.size === 1024) {
      coverage.omittedEntries++;
      return;
    }
    entries.set(id, {
      id,
      sourceId: source.id,
      kind: kind as WorkspaceReviewEntry['kind'],
      stage,
      severity,
      line:
        line !== null && Number.isSafeInteger(line) && line > 0 && line <= 10000000 ? line : null,
      count: 1,
      semanticSha256,
    });
  }
  for (const hit of raw.repo.preTrust)
    add(hit.kind, hit.file, 'pre-trust', 'error', hit.what, null);
  for (const hit of raw.repo.onOpen) add(hit.kind, hit.file, 'on-open', 'warning', hit.what, null);
  for (const hit of raw.agent.hits)
    add(
      hit.kind,
      hit.file,
      hit.kind === 'instruction-file' || hit.kind === 'instruction-hidden-text'
        ? 'instructions'
        : 'on-open',
      hit.severity,
      { name: hit.name, value: hit.value, protection: hit.protection === true },
      hit.line,
    );
  if (!recheckWorkspaceSurface(raw.privateBinding)) gap('source-changed');
  if (raw.repo.capped || raw.agent.capped) gap('limit');
  if (
    coverage.omittedSources ||
    coverage.omittedEntries ||
    raw.observations.length > coverage.gaps.length
  )
    gap('projection-limit');
  if (!raw.complete && coverage.gaps.length === 0) gap('source-changed');
  coverage.gaps = [
    ...new Map(coverage.gaps.map((g) => [`${g.code}\0${g.sourceId}`, g])).values(),
  ].sort((a, b) => `${a.code}:${a.sourceId}`.localeCompare(`${b.code}:${b.sourceId}`));
  sources.sort((a, b) => a.id.localeCompare(b.id));
  const result: WorkspaceReviewCapture = {
    schema: 'stroq-workspace-capture/1',
    workspaceId,
    capturedAt,
    captureSha256: workspaceHash(
      stableStringify({ workspaceId, profile, manifestSha256: raw.manifestSha256, coverage }),
    ),
    profile,
    complete:
      coverage.gaps.length === 0 && coverage.omittedSources === 0 && coverage.omittedEntries === 0,
    coverage,
    sources,
    entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  if (!validateWorkspaceReviewCapture(result)) throw new Error('invalid-report');
  return result;
}
