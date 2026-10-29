import { closed, count, hash, member, stamp, text } from './local-guards';
import { validateSkillLocation, type SkillLocation } from './skill-location';

export const CODEX_SKILL_SOURCE_LIMITS = {
  ancestors: 32,
  sources: 64,
  candidates: 128,
  directories: 1024,
  entries: 4096,
  depth: 8,
  entrypointBytes: 65536,
  bytes: 8 * 1024 * 1024,
  configBytes: 256 * 1024,
  responseBytes: 512 * 1024,
  rules: 512,
  matches: 32,
  gaps: 128,
} as const;
export const CODEX_SKILL_SOURCE_GAPS = [
  'marker-unreadable',
  'marker-unsafe',
  'changed-context',
  'ancestor-limit',
  'source-limit',
  'custom-profile-unsupported',
  'config-invalid',
  'config-unavailable',
  'source-path-refused',
  'source-unreadable',
  'item-path-refused',
  'item-unreadable',
  'item-limit',
  'bytes-limit',
  'deadline',
  'metadata-invalid',
  'hidden-sources-skipped',
  'compatibility-uninspected',
  'system-uninspected',
  'admin-uninspected',
  'plugins-uninspected',
  'session-overrides-unverified',
  'managed-config-unverified',
] as const;
export type CodexSkillSourceGapCode = (typeof CODEX_SKILL_SOURCE_GAPS)[number];
export type CodexSkillDeclaredState = 'not-specified' | 'enabled' | 'disabled' | 'unknown';
export interface CodexSkillSourceRow {
  id: string;
  family: 'agents' | 'codex-legacy' | 'system' | 'admin' | 'plugins';
  scope: 'cwd' | 'ancestor' | 'user' | 'system' | 'admin' | 'plugins';
  distance: number | null;
  label: string;
  status: 'complete' | 'absent' | 'partial' | 'uninspected';
  candidates: number;
}
export interface CodexSkillSourceItem {
  id: string;
  sourceId: string;
  name: string;
  location: SkillLocation;
  entrypointSha256: string | null;
  bytes: number;
  declaredState: CodexSkillDeclaredState;
  metadata: 'valid' | 'invalid';
  scan: {
    status: 'clean' | 'suspect' | 'incomplete';
    findings: number;
    matches: {
      ruleId: string;
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      title: string;
    }[];
    omitted: number;
  };
  capabilities?: { kind: string; count: number }[];
}
export interface CodexSkillSourcesReport {
  schema: 'stroq-codex-skill-sources/1';
  source: 'local';
  workspaceId: string;
  generatedAt: string;
  runtimeSha256: string;
  capture: { startedAt: string; completedAt: string; atomicSnapshot: false };
  context: {
    boundary: 'marker' | 'cwd-only' | 'unverifiable' | 'limit';
    ancestorCount: number;
    markerPolicy: 'default' | 'user-config' | 'unverified';
    profile: 'default' | 'custom' | 'unverified';
    controlContextId?: string;
  };
  settings: {
    status: 'ready' | 'missing' | 'invalid' | 'unavailable' | 'unsupported';
    sha256: string | null;
    rules: number;
    unmatchedRules: number;
  };
  sources: CodexSkillSourceRow[];
  items: CodexSkillSourceItem[];
  gaps: { code: CodexSkillSourceGapCode; sourceId?: string }[];
  omitted: { sources: number; items: number };
}
const exact = (value: unknown, keys: string[]) =>
  closed(value, keys) && Reflect.ownKeys(value as object).length === keys.length;
const sourceId = (v: unknown): v is string =>
  typeof v === 'string' && /^source-[a-f0-9]{24}$/.test(v);
const candidateId = (v: unknown): v is string =>
  typeof v === 'string' && /^candidate-[a-f0-9]{24}$/.test(v);
const bounded = (v: unknown, max: number) => Array.isArray(v) && v.length <= max;
const nullableHash = (v: unknown) => v === null || hash(v);
const capabilityKinds = [
  'fs.read',
  'fs.write',
  'net',
  'cred.env',
  'cred.file',
  'exec',
  'hook',
  'install-script',
  'tool',
  'allowed-tools',
  'signal',
];
function validSource(value: unknown): value is CodexSkillSourceRow {
  if (!exact(value, ['id', 'family', 'scope', 'distance', 'label', 'status', 'candidates']))
    return false;
  const v = value as CodexSkillSourceRow;
  return (
    sourceId(v.id) &&
    member(v.family, ['agents', 'codex-legacy', 'system', 'admin', 'plugins']) &&
    member(v.scope, ['cwd', 'ancestor', 'user', 'system', 'admin', 'plugins']) &&
    (v.scope === 'cwd'
      ? v.distance === 0
      : v.scope === 'ancestor'
        ? count(v.distance, CODEX_SKILL_SOURCE_LIMITS.ancestors) && v.distance > 0
        : v.distance === null) &&
    text(v.label, 200) &&
    !/^(?:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(v.label) &&
    (['agents', 'codex-legacy'].includes(v.family)
      ? ['cwd', 'ancestor', 'user'].includes(v.scope)
      : v.scope === v.family && v.status === 'uninspected') &&
    member(v.status, ['complete', 'absent', 'partial', 'uninspected']) &&
    count(v.candidates, CODEX_SKILL_SOURCE_LIMITS.candidates) &&
    (!['absent', 'uninspected'].includes(v.status) || v.candidates === 0)
  );
}
function validItem(value: unknown): value is CodexSkillSourceItem {
  if (
    !closed(value, [
      'id',
      'sourceId',
      'name',
      'location',
      'entrypointSha256',
      'bytes',
      'declaredState',
      'metadata',
      'scan',
      'capabilities',
    ])
  )
    return false;
  const v = value as unknown as CodexSkillSourceItem;
  if (
    !candidateId(v.id) ||
    !sourceId(v.sourceId) ||
    !text(v.name, 200) ||
    !validateSkillLocation(v.location) ||
    !nullableHash(v.entrypointSha256) ||
    !count(v.bytes, CODEX_SKILL_SOURCE_LIMITS.entrypointBytes) ||
    !member(v.declaredState, ['not-specified', 'enabled', 'disabled', 'unknown']) ||
    !member(v.metadata, ['valid', 'invalid']) ||
    !exact(v.scan, ['status', 'findings', 'matches', 'omitted'])
  )
    return false;
  const s = v.scan;
  if (
    !member(s.status, ['clean', 'suspect', 'incomplete']) ||
    !count(s.findings, 10000) ||
    !count(s.omitted, 10000) ||
    !bounded(s.matches, CODEX_SKILL_SOURCE_LIMITS.matches) ||
    !s.matches.every(
      (m) =>
        exact(m, ['ruleId', 'severity', 'title']) &&
        text(m.ruleId, 200) &&
        /^[A-Za-z0-9_.:-]+$/.test(m.ruleId) &&
        member(m.severity, ['critical', 'high', 'medium', 'low', 'info']) &&
        text(m.title, 240),
    ) ||
    s.findings !== s.matches.length + s.omitted ||
    (s.status === 'clean' && s.findings !== 0) ||
    (s.status === 'suspect' && s.findings === 0) ||
    (v.entrypointSha256 === null && s.status !== 'incomplete') ||
    ((v.metadata === 'invalid' || v.entrypointSha256 === null) && v.declaredState !== 'unknown')
  )
    return false;
  return (
    v.capabilities === undefined ||
    (bounded(v.capabilities, capabilityKinds.length) &&
      v.capabilities.every(
        (c) =>
          exact(c, ['kind', 'count']) && member(c.kind, capabilityKinds) && count(c.count, 10000),
      ) &&
      new Set(v.capabilities.map((c) => c.kind)).size === v.capabilities.length)
  );
}
/** Derived entrypoint evidence only; selectors and source labels never authorize paths or writes. */
export function validateCodexSkillSourcesReport(value: unknown): value is CodexSkillSourcesReport {
  if (
    !exact(value, [
      'schema',
      'source',
      'workspaceId',
      'generatedAt',
      'runtimeSha256',
      'capture',
      'context',
      'settings',
      'sources',
      'items',
      'gaps',
      'omitted',
    ])
  )
    return false;
  const v = value as CodexSkillSourcesReport;
  if (
    v.schema !== 'stroq-codex-skill-sources/1' ||
    v.source !== 'local' ||
    typeof v.workspaceId !== 'string' ||
    !/^workspace-[a-f0-9]{24}$/.test(v.workspaceId) ||
    !stamp(v.generatedAt) ||
    !hash(v.runtimeSha256) ||
    !exact(v.capture, ['startedAt', 'completedAt', 'atomicSnapshot']) ||
    !stamp(v.capture.startedAt) ||
    !stamp(v.capture.completedAt) ||
    v.capture.completedAt < v.capture.startedAt ||
    v.generatedAt < v.capture.completedAt ||
    v.capture.atomicSnapshot !== false ||
    !closed(v.context, [
      'boundary',
      'ancestorCount',
      'markerPolicy',
      'profile',
      'controlContextId',
    ]) ||
    (v.context.controlContextId !== undefined &&
      !/^codex-context-[a-f0-9]{64}$/.test(v.context.controlContextId)) ||
    !member(v.context.boundary, ['marker', 'cwd-only', 'unverifiable', 'limit']) ||
    !count(v.context.ancestorCount, CODEX_SKILL_SOURCE_LIMITS.ancestors) ||
    !member(v.context.markerPolicy, ['default', 'user-config', 'unverified']) ||
    !member(v.context.profile, ['default', 'custom', 'unverified']) ||
    !exact(v.settings, ['status', 'sha256', 'rules', 'unmatchedRules']) ||
    !member(v.settings.status, ['ready', 'missing', 'invalid', 'unavailable', 'unsupported']) ||
    !nullableHash(v.settings.sha256) ||
    !count(v.settings.rules, CODEX_SKILL_SOURCE_LIMITS.rules) ||
    !count(v.settings.unmatchedRules, v.settings.rules) ||
    (v.settings.status === 'missing' && v.settings.sha256 !== null) ||
    (v.settings.status === 'ready' && !hash(v.settings.sha256)) ||
    (v.settings.status !== 'ready' && v.settings.rules !== 0) ||
    !bounded(v.sources, CODEX_SKILL_SOURCE_LIMITS.sources) ||
    !v.sources.every(validSource) ||
    !bounded(v.items, CODEX_SKILL_SOURCE_LIMITS.candidates) ||
    !v.items.every(validItem) ||
    !bounded(v.gaps, CODEX_SKILL_SOURCE_LIMITS.gaps) ||
    !v.gaps.every(
      (g) =>
        closed(g, ['code', 'sourceId']) &&
        member(g.code, CODEX_SKILL_SOURCE_GAPS) &&
        (g.sourceId === undefined || sourceId(g.sourceId)),
    ) ||
    !exact(v.omitted, ['sources', 'items']) ||
    !count(v.omitted.sources, 1000000) ||
    !count(v.omitted.items, 1000000)
  )
    return false;
  const ids = new Set(v.sources.map((s) => s.id));
  const changedContext = v.gaps.some((gap) => gap.code === 'changed-context');
  return (
    (v.context.boundary === 'marker' || v.context.ancestorCount === 0) &&
    v.sources.every(
      (source) =>
        (source.scope !== 'ancestor' ||
          (v.context.boundary === 'marker'
            ? source.distance! <= v.context.ancestorCount
            : v.context.boundary === 'unverifiable' &&
              changedContext &&
              source.status === 'partial' &&
              v.items
                .filter((item) => item.sourceId === source.id)
                .every(
                  (item) => item.scan.status === 'incomplete' && item.declaredState === 'unknown',
                ))) &&
        !(
          v.context.profile === 'unverified' &&
          source.family === 'codex-legacy' &&
          source.scope === 'user' &&
          source.status !== 'uninspected'
        ),
    ) &&
    ids.size === v.sources.length &&
    new Set(v.items.map((i) => i.id)).size === v.items.length &&
    v.items.every(
      (i) =>
        ids.has(i.sourceId) &&
        v.sources.some(
          (source) => source.id === i.sourceId && ['complete', 'partial'].includes(source.status),
        ) &&
        (v.settings.status === 'ready' ||
          (v.settings.status === 'missing'
            ? ['not-specified', 'unknown'].includes(i.declaredState)
            : i.declaredState === 'unknown')),
    ) &&
    v.gaps.every((g) => g.sourceId === undefined || ids.has(g.sourceId)) &&
    v.sources.every((s) => s.candidates === v.items.filter((i) => i.sourceId === s.id).length)
  );
}
