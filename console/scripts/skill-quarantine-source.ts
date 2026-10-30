import { lstat, mkdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { SkillSourceId } from '../lib/skill-sources.ts';
import { skillLocation } from '../lib/skill-location.ts';
import {
  safeInventoryName,
  skillArtifactId,
  SKILL_DISCOVERY_SOURCES,
  validSkillLocator,
} from './skill-sources.ts';
import type { Root, Scope } from './skill-quarantine-capture.ts';
import {
  checkDeadline,
  identity,
  inspectLocation,
  sameIdentity,
} from './skill-quarantine-paths.mjs';

export type SourceSelection = { skillSource: SkillSourceId; locator: string };
export type SourceParents = { path: string; ino: number; dev: number }[];
export type QuarantineEligibility =
  'supported' | 'source-root' | 'overlapping-skill' | 'managed-source' | 'unsafe-location';
export function sourceDefinition(source: SkillSourceId) {
  const found = SKILL_DISCOVERY_SOURCES.find((item) => item.id === source);
  if (!found) throw new Error('quarantine-unsupported');
  return found;
}
export function sourceFolder(root: Root, scope: Scope, skillSource: SkillSourceId) {
  return join(root.path, sourceDefinition(skillSource)[scope]);
}
export function selectedPath(root: Root, scope: Scope, selected: SourceSelection) {
  if (!validSkillLocator(selected.locator)) throw new Error('quarantine-unsupported');
  return join(sourceFolder(root, scope, selected.skillSource), selected.locator);
}
export function publicArtifact(scope: Scope, selected: SourceSelection, sha256: string) {
  const id = skillArtifactId(selected.skillSource, scope, selected.locator);
  return {
    id,
    name: safeInventoryName(basename(selected.locator), `Skill ${id.slice(-8)}`),
    agent: sourceDefinition(selected.skillSource).agent,
    skillSource: selected.skillSource,
    scope,
    sha256,
    location: skillLocation(selected.locator),
  };
}
async function assertContainer(root: Root, path: string) {
  // Anything at these names is enough to refuse ownership of a plugin/container.
  for (const name of ['SKILL.md', '.claude-plugin', 'plugin.json', 'marketplace.json']) {
    try {
      await lstat(join(path, name));
      throw new Error('quarantine-unsupported');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await inspectLocation(root, path);
}
/** Catalog advisory only. Prepare/apply additionally pin and recapture the complete folder. */
export async function quarantineEligibility(
  root: string,
  locator: string,
  entries: readonly { path: string; kind?: string }[],
  deadline: number,
): Promise<QuarantineEligibility> {
  if (!locator) return 'source-root';
  const managed = locator
    .split('/')
    .some((part) => /^(?:synced|node_modules|\.claude-plugin|\.system)$/i.test(part));
  if (!validSkillLocator(locator)) return managed ? 'managed-source' : 'unsafe-location';
  if (entries.some((entry) => entry.path !== 'SKILL.md' && /(?:^|\/)SKILL\.md$/i.test(entry.path)))
    return 'overlapping-skill';
  if (
    entries.some((entry) =>
      /(?:^|\/)(?:\.claude-plugin|plugin\.json|marketplace\.json)(?:\/|$)/i.test(entry.path),
    )
  )
    return 'managed-source';
  let at = root;
  for (const part of ['', ...locator.split('/').slice(0, -1)]) {
    checkDeadline(deadline);
    if (part) at = join(at, part);
    try {
      const stat = await lstat(at);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe-location';
      for (const marker of ['SKILL.md', '.claude-plugin', 'plugin.json', 'marketplace.json']) {
        try {
          await lstat(join(at, marker));
          return marker === 'SKILL.md' ? 'overlapping-skill' : 'managed-source';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unsafe-location';
        }
      }
    } catch {
      return 'unsafe-location';
    }
  }
  return 'supported';
}
/** Pin every existing source parent; absent parents are allowed only for a restore plan. */
export async function inspectSourceParents(
  root: Root,
  scope: Scope,
  selected: SourceSelection,
  deadline: number,
  allowMissing = false,
): Promise<SourceParents> {
  const folder = selectedPath(root, scope, selected);
  const source = sourceFolder(root, scope, selected.skillSource);
  const parts = relative(root.path, folder).split('/').slice(0, -1);
  const parents: SourceParents = [];
  let at = root.path,
    missing = false;
  for (const part of parts) {
    checkDeadline(deadline);
    at = join(at, part);
    const located = await inspectLocation(root, at);
    if (!located) {
      if (!allowMissing) throw new Error('quarantine-conflict');
      missing = true;
      continue;
    }
    if (missing) throw new Error('quarantine-conflict');
    parents.push({ path: at, ...identity(located) });
    if (at === source || at.startsWith(`${source}/`)) await assertContainer(root, at);
  }
  return parents;
}
export async function assertSourceParents(
  root: Root,
  scope: Scope,
  selected: SourceSelection,
  parents: SourceParents,
  deadline: number,
  allowMissing = false,
) {
  const current = await inspectSourceParents(root, scope, selected, deadline, allowMissing);
  if (
    current.length !== parents.length ||
    current.some((item, index) => {
      const expected = parents[index];
      return !expected || item.path !== expected.path || !sameIdentity(item, expected);
    })
  )
    throw new Error('quarantine-preview-stale');
}
/** Create only fixed source/container ancestors, pinning and checking each one on publication. */
export async function restoreSourceParents(
  root: Root,
  scope: Scope,
  selected: SourceSelection,
  expected: SourceParents,
  deadline: number,
  commitGuard?: (strong?: boolean) => Promise<void>,
) {
  await assertSourceParents(root, scope, selected, expected, deadline, true);
  const folder = selectedPath(root, scope, selected);
  let parents = expected.map((parent) => ({ ...parent }));
  let at = root.path;
  for (const part of relative(root.path, folder).split('/').slice(0, -1)) {
    checkDeadline(deadline);
    await assertSourceParents(root, scope, selected, parents, deadline, true);
    at = join(at, part);
    if (parents.some((parent) => parent.path === at)) continue;
    await commitGuard?.(false);
    try {
      await mkdir(at, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('quarantine-preview-stale');
      throw error;
    }
    const created = await inspectLocation(root, at);
    if (!created) throw new Error('quarantine-preview-stale');
    parents = [...parents, { path: at, ...identity(created) }];
    await assertSourceParents(root, scope, selected, parents, deadline, true);
  }
  await assertSourceParents(root, scope, selected, parents, deadline);
  return parents;
}
