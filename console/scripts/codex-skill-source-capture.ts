import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CODEX_SKILL_SOURCE_LIMITS as limits,
  type CodexSkillSourceGapCode,
  type CodexSkillSourceItem,
  type CodexSkillSourceRow,
  type CodexSkillSourcesReport,
} from '../lib/codex-skill-sources.ts';
import { skillLocation } from '../lib/skill-location.ts';
import { snapshotFile, inspectPath } from './agent-setup-files.mjs';
import { safeLocation, safeNames } from './inventory-safe.mjs';
import { safeInventoryName } from './skill-sources.ts';
import { analyzeCodexSkillEntrypoint } from './codex-skill-source-entrypoint.ts';
import { captureCodexSkillSourceContext } from './codex-skill-source-context.ts';
import { codexSkillConfigSummary, declaredSkillState } from './codex-skill-source-config.ts';
import { boundCodexSkillSourcesReport } from './codex-skill-source-output.ts';

type Context = Awaited<ReturnType<typeof captureCodexSkillSourceContext>>;
type Source = Context['sources'][number];
export type PrivateCodexSkillCandidate = {
  id: string;
  sourceId: string;
  path: string;
  name: string | null;
  root: Context['userHome'];
  snapshot: Awaited<ReturnType<typeof snapshotFile>>;
};
type Options = {
  runtimeSha256: string;
  deadline: number;
  startedAt?: string;
  onPrivateCapture?: (candidates: PrivateCodexSkillCandidate[]) => void;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = isDeepStrictEqual;
const pin = (stat: {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}) => ({
  dev: stat.dev,
  ino: stat.ino,
  uid: stat.uid,
  mode: stat.mode,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
const sourceId = (value: string) => `source-${hash(`stroq-codex-source/1\0${value}`).slice(0, 24)}`;
const candidateId = (path: string, locator: string) =>
  `candidate-${hash(`stroq-codex-candidate/1\0${path}\0${locator}`).slice(0, 24)}`;

/** Fixed local sources only. No browser input, source execution, baseline access or writes. */
export async function captureCodexSkillSources(options: {
  project: string;
  userHome: string;
  codexEnvironment?: { CODEX_HOME?: string };
  deadline: number;
  runtimeSha256: string;
}) {
  const deadline = Math.min(options.deadline, Date.now() + 15000);
  const startedAt = new Date().toISOString();
  const context = await captureCodexSkillSourceContext({ ...options, deadline });
  return collectCodexSkillSources(context, {
    runtimeSha256: options.runtimeSha256,
    deadline,
    startedAt,
  });
}

/** Separately exported for isolated bounded collector tests; context remains server-owned. */
export async function collectCodexSkillSources(
  context: Context,
  options: Options,
): Promise<CodexSkillSourcesReport> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const sources: CodexSkillSourceRow[] = [],
    items: CodexSkillSourceItem[] = [];
  const gaps: CodexSkillSourcesReport['gaps'] = [];
  const omitted = { sources: 0, items: 0 };
  const budget = { directories: 0, entries: 0, bytes: 0 };
  const selected: PrivateCodexSkillCandidate[] = [];
  const checks: (() => Promise<void>)[] = [];
  const gap = (code: CodexSkillSourceGapCode, source?: CodexSkillSourceRow) => {
    if (source && source.status !== 'uninspected') source.status = 'partial';
    if (
      gaps.length < limits.gaps &&
      !gaps.some((g) => g.code === code && g.sourceId === source?.id)
    )
      gaps.push({ code, ...(source ? { sourceId: source.id } : {}) });
  };
  await context.assertCurrent();
  async function entry(
    source: Source,
    row: CodexSkillSourceRow,
    directory: string,
    locator: string,
  ) {
    if (items.length >= limits.candidates) {
      omitted.items++;
      gap('item-limit', row);
      return;
    }
    const id = candidateId(source.path, locator),
      path = join(directory, 'SKILL.md');
    const item: CodexSkillSourceItem = {
      id,
      sourceId: row.id,
      name: safeInventoryName(basename(directory), `Skill ${id.slice(-8)}`),
      location: skillLocation(locator),
      entrypointSha256: null,
      bytes: 0,
      declaredState: 'unknown',
      metadata: 'invalid',
      scan: { status: 'incomplete', findings: 0, matches: [], omitted: 0 },
      capabilities: [],
    };
    items.push(item);
    row.candidates++;
    if (Date.now() >= options.deadline) {
      gap('deadline', row);
      return;
    }
    try {
      const location = await safeLocation(source.root.path, path);
      if (location.kind !== 'ok' || !location.stat) {
        gap('item-path-refused', row);
        return;
      }
      if (
        location.stat.size > limits.entrypointBytes ||
        budget.bytes + location.stat.size > limits.bytes
      ) {
        gap('bytes-limit', row);
        return;
      }
      const captured = await snapshotFile(source.root, path, limits.entrypointBytes);
      if (captured.bytes === null) throw Error('entrypoint-disappeared');
      budget.bytes += captured.bytes.length;
      const sourcePin = { exists: true, file: captured.file, directories: captured.directories };
      checks.push(async () => {
        const current = await inspectPath(source.root, path);
        if (!same(current, sourcePin)) throw Error('changed-context');
      });
      item.entrypointSha256 = captured.sha256;
      item.bytes = captured.bytes.length;
      const document = {
        id,
        sourceId: row.id,
        path,
        name: null as string | null,
        root: source.root,
        snapshot: captured,
      };
      selected.push(document);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes);
      } catch {
        gap('item-unreadable', row);
        return;
      }
      const analysis = analyzeCodexSkillEntrypoint(text, options.deadline, basename(directory));
      item.metadata = analysis.metadata;
      if (analysis.metadata === 'valid' && analysis.declaredName !== null)
        item.name = safeInventoryName(analysis.declaredName, item.name);
      item.scan = analysis.scan;
      item.capabilities = analysis.capabilities;
      document.name = analysis.declaredName;
      if (item.metadata === 'invalid') gap('metadata-invalid', row);
      if (item.scan.status === 'incomplete')
        gap(Date.now() >= options.deadline ? 'deadline' : 'item-unreadable', row);
    } catch {
      gap('item-unreadable', row);
    }
  }
  async function walk(
    source: Source,
    row: CodexSkillSourceRow,
    directory: string,
    locator: string,
    depth: number,
  ): Promise<void> {
    if (Date.now() >= options.deadline) {
      gap('deadline', row);
      return;
    }
    if (
      depth > limits.depth ||
      budget.directories >= limits.directories ||
      budget.entries >= limits.entries
    ) {
      gap('item-limit', row);
      return;
    }
    budget.directories++;
    const location = await safeLocation(source.root.path, directory, true);
    if (location.kind !== 'ok' || !location.stat) {
      gap('source-path-refused', row);
      return;
    }
    const before = pin(location.stat),
      listing = await safeNames(source.root.path, directory, limits.entries - budget.entries);
    budget.entries += listing.names.length;
    if (listing.kind !== 'ok')
      gap(listing.kind === 'limit' ? 'item-limit' : 'source-unreadable', row);
    checks.push(async () => {
      const current = await safeLocation(source.root.path, directory, true);
      if (current.kind !== 'ok' || !current.stat || !same(pin(current.stat), before))
        throw Error('changed-context');
    });
    const children: string[] = [];
    for (const name of listing.names) {
      if (Date.now() >= options.deadline) {
        gap('deadline', row);
        break;
      }
      let stat;
      try {
        stat = await lstat(join(directory, name));
      } catch {
        gap('item-unreadable', row);
        continue;
      }
      if (stat.isSymbolicLink()) {
        gap('item-path-refused', row);
        continue;
      }
      if (stat.isDirectory()) {
        if (name.startsWith('.')) {
          gap('hidden-sources-skipped', row);
          continue;
        }
        children.push(name);
      } else if (name === 'SKILL.md') {
        if (!stat.isFile() || stat.nlink !== 1) gap('item-path-refused', row);
        else await entry(source, row, directory, locator);
      }
    }
    for (const name of children)
      await walk(
        source,
        row,
        join(directory, name),
        locator ? `${locator}/${name}` : name,
        depth + 1,
      );
  }
  const userSources = context.sources.filter((source) => source.scope === 'user');
  const uninspectedCount = context.profile.path === null ? 4 : 3;
  const repositorySlots = Math.max(0, limits.sources - uninspectedCount - userSources.length);
  let repositorySources = 0;
  for (const source of context.sources) {
    if (source.scope === 'repo' && repositorySources++ >= repositorySlots) {
      omitted.sources++;
      gap('source-limit');
      continue;
    }
    const row: CodexSkillSourceRow = {
      id: sourceId(source.path),
      family: source.family,
      scope: source.scope === 'user' ? 'user' : source.depth === 0 ? 'cwd' : 'ancestor',
      distance: source.scope === 'user' ? null : source.depth,
      label:
        source.scope === 'user'
          ? source.family === 'agents'
            ? 'User .agents/skills'
            : context.profile.status === 'custom'
              ? 'Selected Codex data directory skills'
              : 'User .codex/skills'
          : `${source.depth === 0 ? 'Selected folder' : `Ancestor ${source.depth}`} ${source.family === 'agents' ? '.agents' : '.codex'}/skills`,
      status: 'complete',
      candidates: 0,
    };
    sources.push(row);
    const location = await safeLocation(source.root.path, source.path, true);
    if (location.kind === 'missing') {
      row.status = 'absent';
      try {
        const before = await inspectPath(source.root, join(source.path, 'SKILL.md'));
        checks.push(async () => {
          if (!same(before, await inspectPath(source.root, join(source.path, 'SKILL.md'))))
            throw Error('changed-context');
        });
      } catch {
        gap('source-path-refused', row);
      }
    } else if (location.kind !== 'ok') gap('source-path-refused', row);
    else await walk(source, row, source.path, '', 0);
  }
  const uninspected: [
    CodexSkillSourceRow['family'],
    CodexSkillSourceRow['scope'],
    string,
    CodexSkillSourceGapCode,
  ][] = [
    ['system', 'system', 'Bundled Codex skills', 'system-uninspected'],
    ['admin', 'admin', 'Administrator skill sources', 'admin-uninspected'],
    ['plugins', 'plugins', 'Plugin skill sources', 'plugins-uninspected'],
  ];
  if (context.profile.path === null)
    uninspected.unshift([
      'codex-legacy',
      'user',
      'Selected Codex data directory skills (unverified)',
      'custom-profile-unsupported',
    ]);
  for (const [family, scope, label, code] of uninspected) {
    const row: CodexSkillSourceRow = {
      id: sourceId(`uninspected\0${family}\0${scope}`),
      family,
      scope,
      distance: scope === 'cwd' ? 0 : null,
      label,
      status: 'uninspected',
      candidates: 0,
    };
    sources.push(row);
    gap(code, row);
  }
  gap('session-overrides-unverified');
  gap('managed-config-unverified');
  const configuration = context.configuration;
  if (configuration.status === 'invalid') gap('config-invalid');
  if (configuration.status === 'unavailable') gap('config-unavailable');
  if (configuration.status === 'unsupported') gap('custom-profile-unsupported');
  if (context.ancestry.reason === 'marker-unsafe') gap('marker-unsafe');
  if (context.ancestry.reason === 'marker-unreadable') gap('marker-unreadable');
  if (context.ancestry.status === 'limit') gap('ancestor-limit');
  const knownPaths = new Set(selected.map((document) => document.path));
  for (const document of selected) {
    const item = items.find((item) => item.id === document.id)!;
    if (item.metadata === 'valid')
      item.declaredState = declaredSkillState(configuration, { ...document, knownPaths });
  }
  let changed = false,
    unverified = false;
  try {
    await context.assertCurrent();
    for (const check of checks) {
      if (Date.now() >= options.deadline) {
        unverified = true;
        gap('deadline');
        break;
      }
      await check();
    }
    await context.assertCurrent();
  } catch {
    changed = true;
    unverified = true;
    gap('changed-context');
  }
  if (unverified) {
    for (const source of sources) if (source.status !== 'uninspected') source.status = 'partial';
    for (const item of items) {
      item.scan.status = 'incomplete';
      item.declaredState = 'unknown';
    }
  }
  const settings = codexSkillConfigSummary(configuration);
  const unmatched = configuration.rules.filter(
    (rule) =>
      !selected.some((item) => rule.value === (rule.kind === 'path' ? item.path : item.name)),
  ).length;
  settings.unmatchedRules = Math.min(settings.rules, settings.unmatchedRules + unmatched);
  options.onPrivateCapture?.(selected);
  const completedAt = new Date().toISOString();
  return boundCodexSkillSourcesReport({
    schema: 'stroq-codex-skill-sources/1',
    source: 'local',
    workspaceId: `workspace-${hash(context.project.path).slice(0, 24)}`,
    generatedAt: completedAt,
    runtimeSha256: options.runtimeSha256,
    capture: { startedAt, completedAt, atomicSnapshot: false },
    context: {
      boundary:
        changed || context.ancestry.status === 'uncertain'
          ? 'unverifiable'
          : context.ancestry.status === 'bounded'
            ? 'marker'
            : context.ancestry.status === 'limit'
              ? 'limit'
              : 'cwd-only',
      ancestorCount:
        !changed && context.ancestry.status === 'bounded'
          ? Math.max(0, context.ancestry.parents.length - 1)
          : 0,
      markerPolicy:
        configuration.markerStatus === 'configured'
          ? 'user-config'
          : configuration.markerStatus === 'default'
            ? 'default'
            : 'unverified',
      profile: context.profile.status,
      ...(context.controlContextId ? { controlContextId: context.controlContextId } : {}),
    },
    settings,
    sources,
    items,
    gaps,
    omitted,
  });
}
