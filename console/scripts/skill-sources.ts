import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { redact } from '@stroq/core';
import { checkEntryPath } from '../../packages/cli/src/install/safe-path.ts';
import type { SkillSourceCoverage, SkillSourceId } from '../lib/skill-sources.ts';
import { safeLocation, safeNames } from './inventory-safe.mjs';
import { skillScopes } from './skill-quarantine-scopes.ts';

type Scope = 'project' | 'user';
type Agent = 'claude-code' | 'shared' | 'codex' | 'cursor' | 'windsurf';
export type SkillArtifact = {
  id: string;
  name: string;
  agent: Agent;
  scope: Scope;
  skillSource: SkillSourceId;
  root: string;
  path: string;
  locator: string;
};
export type SkillDiscoveryGap = {
  kind: 'skill';
  agent: Agent;
  scope: Scope;
  skillSource: SkillSourceId;
  code: 'limit' | 'path-refused' | 'unreadable';
};
export const SKILL_DISCOVERY_SOURCES: {
  id: SkillSourceId;
  agent: Agent;
  project: string;
  user: string;
}[] = [
  { id: 'claude-skills', agent: 'claude-code', project: '.claude/skills', user: '.claude/skills' },
  { id: 'agents-skills', agent: 'shared', project: '.agents/skills', user: '.agents/skills' },
  { id: 'codex-skills', agent: 'codex', project: '.codex/skills', user: '.codex/skills' },
  { id: 'cursor-skills', agent: 'cursor', project: '.cursor/skills', user: '.cursor/skills' },
  {
    id: 'windsurf-skills',
    agent: 'windsurf',
    project: '.windsurf/skills',
    user: '.codeium/windsurf/skills',
  },
  { id: 'devin-skills', agent: 'windsurf', project: '.devin/skills', user: '.config/devin/skills' },
];
export const SKILL_DISCOVERY_LIMITS = {
  candidates: 256,
  directories: 1024,
  entries: 4096,
  depth: 8,
} as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directClaude = (source: SkillSourceId, locator: string) =>
  source === 'claude-skills' && locator.length > 0 && !locator.includes('/');

/** Legacy direct Claude identities remain compatible with explicit reviews and quarantine. */
export function skillArtifactId(source: SkillSourceId, scope: Scope, locator: string) {
  const input = directClaude(source, locator)
    ? `skill\0claude-code\0${scope}\0${locator}`
    : `skill\0source\0${source}\0${scope}\0${locator}`;
  return `item-${hash(input).slice(0, 24)}`;
}

export function skillSourcePath(root: string, scope: Scope, source: SkillSourceId) {
  const found = SKILL_DISCOVERY_SOURCES.find((item) => item.id === source);
  if (!found) throw new Error('quarantine-unsupported');
  return join(root, found[scope]);
}

const sensitiveName = (value: string) =>
  /(?:^|[\/ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[\/ .-])/.test(value) ||
  /(?:^|\/)\.env|(?:^|[ \/_.-])(?:env|secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ \/_.-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
    value,
  );
export const safeInventoryName = (value: string, fallback: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(value) &&
  redact(value) === value &&
  !sensitiveName(value)
    ? value
    : fallback;

/** Only this finite projection may leave the engine; discovery paths stay internal. */
export function skillArtifactMeta(artifact: SkillArtifact) {
  return {
    id: artifact.id,
    kind: 'skill' as const,
    agent: artifact.agent,
    scope: artifact.scope,
    skillSource: artifact.skillSource,
    name: safeInventoryName(artifact.name, `Skill ${artifact.id.slice(-8)}`),
  };
}
export function skillQuarantineSupported(artifact: SkillArtifact) {
  return validSkillLocator(artifact.locator);
}

/** Private locator only: never a browser-selected path or a display label. */
export function validSkillLocator(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.split('/').length <= SKILL_DISCOVERY_LIMITS.depth &&
    value
      .split('/')
      .every((part) => !/^(?:synced|node_modules|\.claude-plugin|\.system)$/i.test(part)) &&
    checkEntryPath(value).ok
  );
}

/** Fixed server-selected roots only. Links are coverage gaps, never followed or treated as absence. */
export async function discoverSkillArtifacts({
  project,
  userHome,
  deadline,
}: {
  project: string;
  userHome: string;
  deadline: number;
}) {
  const artifacts: SkillArtifact[] = [];
  const sources: SkillSourceCoverage[] = [];
  const gaps: SkillDiscoveryGap[] = [];
  const budget = { directories: 0, entries: 0 };
  for (const source of SKILL_DISCOVERY_SOURCES) {
    for (const scope of skillScopes(project, userHome)) {
      const root = scope === 'project' ? project : userHome;
      const folder = join(root, source[scope]);
      const coverage: SkillSourceCoverage = {
        id: source.id,
        scope,
        status: 'complete',
        candidates: 0,
      };
      const gap = (code: SkillDiscoveryGap['code']) => {
        coverage.status = 'partial';
        if (
          !gaps.some(
            (item) => item.skillSource === source.id && item.scope === scope && item.code === code,
          )
        )
          gaps.push({ kind: 'skill', agent: source.agent, scope, skillSource: source.id, code });
      };
      sources.push(coverage);
      if (Date.now() >= deadline) {
        gap('limit');
        continue;
      }
      const located = await safeLocation(root, folder, true);
      if (located.kind === 'missing') {
        coverage.status = 'absent';
        continue;
      }
      if (located.kind !== 'ok') {
        gap('path-refused');
        continue;
      }

      async function walk(path: string, locator: string, depth: number): Promise<void> {
        if (
          Date.now() >= deadline ||
          depth > SKILL_DISCOVERY_LIMITS.depth ||
          budget.directories >= SKILL_DISCOVERY_LIMITS.directories ||
          budget.entries >= SKILL_DISCOVERY_LIMITS.entries
        ) {
          gap('limit');
          return;
        }
        budget.directories++;
        const before = await safeLocation(root, path, true);
        if (before.kind !== 'ok' || !before.stat) {
          gap('path-refused');
          return;
        }
        const listed = await safeNames(root, path, SKILL_DISCOVERY_LIMITS.entries - budget.entries);
        budget.entries += listed.names.length;
        if (listed.kind !== 'ok') gap(listed.kind === 'limit' ? 'limit' : 'path-refused');
        const directories: string[] = [];
        for (const name of listed.names) {
          if (Date.now() >= deadline) {
            gap('limit');
            break;
          }
          const child = join(path, name);
          let stat;
          try {
            stat = await lstat(child);
          } catch {
            gap('unreadable');
            continue;
          }
          if (stat.isSymbolicLink()) {
            gap('path-refused');
            continue;
          }
          if (stat.isDirectory()) {
            directories.push(name);
            continue;
          }
          if (name !== 'SKILL.md') continue;
          if ((await safeLocation(root, child)).kind !== 'ok') {
            gap('path-refused');
            continue;
          }
          if (artifacts.length >= SKILL_DISCOVERY_LIMITS.candidates) {
            gap('limit');
            continue;
          }
          artifacts.push({
            id: skillArtifactId(source.id, scope, locator),
            name: basename(path),
            agent: source.agent,
            scope,
            skillSource: source.id,
            root,
            path,
            locator,
          });
          coverage.candidates++;
        }
        for (const name of directories)
          await walk(join(path, name), locator ? `${locator}/${name}` : name, depth + 1);
        const after = await safeLocation(root, path, true);
        if (
          after.kind !== 'ok' ||
          !after.stat ||
          after.stat.ino !== before.stat.ino ||
          after.stat.dev !== before.stat.dev ||
          after.stat.mtimeMs !== before.stat.mtimeMs
        )
          gap('path-refused');
      }
      await walk(folder, '', 0);
    }
  }
  return { artifacts, sources, gaps };
}
