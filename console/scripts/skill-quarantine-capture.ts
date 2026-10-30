import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { readDirTree } from '../../packages/cli/src/install/read-dir.ts';
import { checkEntryPath } from '../../packages/cli/src/install/safe-path.ts';
import { treeDigest } from '../../packages/cli/src/install/tree.ts';
import type { SkillSourceId } from '../lib/skill-sources.ts';
import {
  discoverSkillArtifacts,
  SKILL_DISCOVERY_LIMITS,
  validSkillLocator,
} from './skill-sources.ts';
import { publicArtifact } from './skill-quarantine-source.ts';
import { skillScopes } from './skill-quarantine-scopes.ts';
import {
  checkDeadline,
  hash,
  identity,
  inspectLocation,
  sameIdentity,
} from './skill-quarantine-paths.mjs';

export type Scope = 'project' | 'user';
export type Root = { path: string; ino: number; dev: number };
export const LIMITS = {
  maxEntries: 128,
  maxDepth: 8,
  maxFileBytes: 200_000,
  maxExpanded: 512 * 1024,
};
export const MAX_SKILL_DISCOVERY_ENTRIES = SKILL_DISCOVERY_LIMITS.entries;
export const sourcePath = (root: Root, name: string) => join(root.path, '.claude', 'skills', name);
export const artifactId = (scope: Scope, name: string) =>
  `item-${hash(`skill\0claude-code\0${scope}\0${name}`).slice(0, 24)}`;
export const validName = (name: unknown): name is string =>
  typeof name === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(name) &&
  !/^synced$/i.test(name) &&
  checkEntryPath(name).ok;
export const artifactOf = (
  scope: Scope,
  name: string,
  sha256: string,
  skillSource: SkillSourceId = 'claude-skills',
  locator = name,
) => publicArtifact(scope, { skillSource, locator }, sha256);
const directoryState = (stat: Awaited<ReturnType<typeof lstat>>) => [
  stat.dev,
  stat.ino,
  stat.mode,
  stat.uid,
  stat.nlink,
  stat.size,
  stat.mtimeMs,
  stat.ctimeMs,
];

/** Walk physical entries too: omitted dependencies/repositories must never ride an incomplete digest. */
async function physical(root: Root, folder: string, deadline: number) {
  const seen: [string, string, (number | bigint)[]][] = [];
  let visited = 0;
  let directories = 0;
  async function walk(at: string, relative: string, depth: number): Promise<void> {
    checkDeadline(deadline);
    if (depth >= 8 || ++directories > 128) throw new Error('quarantine-unsupported');
    const before = await inspectLocation(root, at);
    if (!before) throw new Error('quarantine-conflict');
    seen.push([relative, 'dir', directoryState(before)]);
    const dir = await opendir(at);
    const names: string[] = [];
    try {
      for await (const entry of dir) {
        if (++visited > 256) throw new Error('quarantine-unsupported');
        names.push(entry.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    for (const name of names.sort()) {
      checkDeadline(deadline);
      const rel = relative ? `${relative}/${name}` : name;
      if (
        !checkEntryPath(rel).ok ||
        /^(?:\.git|node_modules|\.claude-plugin)$/i.test(name) ||
        (!relative && /^(?:plugin\.json|marketplace\.json)$/i.test(name))
      )
        throw new Error('quarantine-unsupported');
      const path = join(at, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('quarantine-unsupported');
      if (stat.isDirectory()) await walk(path, rel, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) {
        if (stat.size > LIMITS.maxFileBytes) throw new Error('quarantine-unsupported');
        await inspectLocation(root, path, 'file');
        seen.push([rel, 'file', directoryState(stat)]);
      } else throw new Error('quarantine-unsupported');
    }
    const after = await inspectLocation(root, at);
    if (!after || !sameIdentity(before, after) || before.mtimeMs !== after.mtimeMs)
      throw new Error('quarantine-conflict');
  }
  await walk(folder, '', 0);
  return seen;
}
export async function captureSkill(root: Root, folder: string, deadline: number) {
  checkDeadline(deadline);
  const before = await inspectLocation(root, folder);
  if (!before) throw new Error('quarantine-conflict');
  const physicalBefore = await physical(root, folder, deadline);
  const captured = await readDirTree(folder, { limits: LIMITS, rejectNestedRepositories: true });
  const physicalAfter = await physical(root, folder, deadline);
  const after = await inspectLocation(root, folder);
  if (
    !after ||
    !sameIdentity(before, after) ||
    JSON.stringify(physicalBefore) !== JSON.stringify(physicalAfter)
  )
    throw new Error('quarantine-conflict');
  if (
    captured.blindSpots.length ||
    captured.tree.entries.some((entry) => entry.kind !== 'file' || !entry.bytes) ||
    captured.tree.entries.length < 1 ||
    !captured.tree.entries.some((entry) => entry.path === 'SKILL.md') ||
    captured.tree.entries.length !== physicalAfter.filter((entry) => entry[1] === 'file').length
  )
    throw new Error('quarantine-unsupported');
  checkDeadline(deadline);
  return {
    tree: captured.tree,
    sha256: treeDigest(captured.tree),
    identity: identity(after),
    sourceSha256: hash(JSON.stringify(physicalAfter)),
    directories: physicalAfter
      .filter((entry) => entry[1] === 'dir' && entry[0])
      .map((entry) => entry[0]),
    files: captured.tree.entries.length,
    bytes: captured.tree.entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}
export async function findSource(
  roots: { project: Root; user: Root },
  id: string,
  deadline: number,
) {
  checkDeadline(deadline);
  if (!/^item-[a-f0-9]{24}$/.test(id)) throw new Error('quarantine-conflict');
  for (const scope of skillScopes(roots.project.path, roots.user.path)) {
    checkDeadline(deadline);
    const root = roots[scope];
    const directory = join(root.path, '.claude', 'skills');
    // A refused legacy source is not authority over another finite discovery family.
    // The recursive lookup still refuses selecting an artifact from this unsafe root.
    let located;
    try {
      located = await inspectLocation(root, directory);
    } catch {
      continue;
    }
    if (!located) continue;
    const names: string[] = [];
    let dir;
    try {
      dir = await opendir(directory);
    } catch {
      continue;
    }
    try {
      for await (const entry of dir) {
        checkDeadline(deadline);
        if (names.length >= MAX_SKILL_DISCOVERY_ENTRIES) throw new Error('quarantine-unsupported');
        names.push(entry.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    checkDeadline(deadline);
    const after = await inspectLocation(root, directory);
    if (
      !after ||
      !sameIdentity(located, after) ||
      located.mtimeMs !== after.mtimeMs ||
      located.ctimeMs !== after.ctimeMs
    )
      throw new Error('quarantine-conflict');
    const name = names.sort().find((name) => artifactId(scope, name) === id);
    if (name !== undefined) {
      if (!validSkillLocator(name)) throw new Error('quarantine-unsupported');
      return {
        root,
        name,
        locator: name,
        skillSource: 'claude-skills' as const,
        scope,
        path: sourcePath(root, name),
      };
    }
  }
  checkDeadline(deadline);
  const discovered = await discoverSkillArtifacts({
    project: roots.project.path,
    userHome: roots.user.path,
    deadline,
  });
  const found = discovered.artifacts.find((artifact) => artifact.id === id);
  if (found) {
    if (!validSkillLocator(found.locator)) throw new Error('quarantine-unsupported');
    return {
      root: roots[found.scope],
      name: found.name,
      locator: found.locator,
      skillSource: found.skillSource,
      scope: found.scope,
      path: found.path,
    };
  }
  if (discovered.gaps.some((gap) => gap.code === 'limit'))
    throw new Error('quarantine-unsupported');
  throw new Error('quarantine-conflict');
}
