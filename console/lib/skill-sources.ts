import { closed, count, member } from './local-guards';

/** Filesystem origins, not evidence that a host has loaded or enabled a skill. */
export const SKILL_SOURCES = {
  'claude-skills': {
    agent: 'claude-code',
    label: 'Claude skills',
    projectLabel: '.claude/skills',
    userLabel: '~/.claude/skills',
  },
  'agents-skills': {
    agent: 'shared',
    label: 'Shared skills',
    projectLabel: '.agents/skills',
    userLabel: '~/.agents/skills',
  },
  'codex-skills': {
    agent: 'codex',
    label: 'Codex local skills',
    projectLabel: '.codex/skills',
    userLabel: '~/.codex/skills',
  },
  'cursor-skills': {
    agent: 'cursor',
    label: 'Cursor skills',
    projectLabel: '.cursor/skills',
    userLabel: '~/.cursor/skills',
  },
  'windsurf-skills': {
    agent: 'windsurf',
    label: 'Windsurf skills',
    projectLabel: '.windsurf/skills',
    userLabel: '~/.codeium/windsurf/skills',
  },
  'devin-skills': {
    agent: 'windsurf',
    label: 'Devin skills',
    projectLabel: '.devin/skills',
    userLabel: '~/.config/devin/skills',
  },
} as const;
export const SKILL_SOURCE_IDS = Object.keys(SKILL_SOURCES) as (keyof typeof SKILL_SOURCES)[];
export type SkillSourceId = keyof typeof SKILL_SOURCES;
export type SkillAgent = (typeof SKILL_SOURCES)[SkillSourceId]['agent'];
export interface SkillSourceCoverage {
  id: SkillSourceId;
  scope: 'project' | 'user';
  status: 'complete' | 'absent' | 'partial';
  candidates: number;
}
export function isSkillSourceId(value: unknown): value is SkillSourceId {
  return typeof value === 'string' && Object.hasOwn(SKILL_SOURCES, value);
}
export function skillSourceOf(value: {
  kind: string;
  agent: string;
  skillSource?: unknown;
}): SkillSourceId | null {
  if (value.kind !== 'skill') return null;
  if (value.skillSource === undefined)
    return value.agent === 'claude-code' ? 'claude-skills' : null;
  return isSkillSourceId(value.skillSource) &&
    SKILL_SOURCES[value.skillSource].agent === value.agent
    ? value.skillSource
    : null;
}
export function validateSkillSourceCoverage(value: unknown): value is SkillSourceCoverage {
  return (
    closed(value, ['id', 'scope', 'status', 'candidates']) &&
    isSkillSourceId(value.id) &&
    member(value.scope, ['project', 'user']) &&
    member(value.status, ['complete', 'absent', 'partial']) &&
    count(value.candidates, 256) &&
    (value.status !== 'absent' || value.candidates === 0)
  );
}
