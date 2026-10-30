import { closed, count, list, member, stamp, text } from './local-guards';

/**
 * Threats that match this project, from pwn.watch: a public list of breaches, attacks on packages and
 * urgent patches, kept by a third party. Off until you turn it on in Settings. When on, the console's
 * own server downloads the whole list (the same for everyone) and compares it on this machine with the
 * packages this project lists, the ecosystems it uses and the coding agents set up here. Nothing about
 * the project is sent. A match means pwn.watch names something you use, not that you are affected:
 * the versions it gives are prose, so they are left to you to check.
 */

export const THREAT_FEED_SCHEMA = 'stroq-threat-feed/1';
export const THREAT_SOURCE = 'pwn.watch';
export const THREAT_SOURCE_HOME = 'https://pwn.watch/';
/** The most matches one answer lists; the rest are counted. */
export const MAX_THREATS = 5;

export const ECOSYSTEMS = [
  'npm',
  'pypi',
  'github-actions',
  'docker',
  'go',
  'rust',
  'ruby',
  'php',
  'wordpress',
  'java',
  'dotnet',
] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export const THREAT_AGENTS = ['claude-code', 'cursor', 'codex'] as const;
export type ThreatAgent = (typeof THREAT_AGENTS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const THREAT_CATEGORIES = ['patch', 'breach', 'supply-chain'] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];
export const PATCH_STATES = [
  'patched',
  'partial',
  'no-fix-needed',
  'unpatched',
  'unknown',
] as const;
export type PatchState = (typeof PATCH_STATES)[number];

/** The project files whose packages or presence are compared; nothing the browser sends picks one. */
export const STACK_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Dockerfile',
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'wp-config.php',
] as const;
export type StackFile = (typeof STACK_FILES)[number];

export type ThreatWhy =
  | { readonly kind: 'package'; readonly name: string; readonly ecosystem: 'npm' | 'pypi' }
  | { readonly kind: 'agent'; readonly agent: ThreatAgent }
  | { readonly kind: 'ecosystem'; readonly ecosystem: Ecosystem };

export interface ThreatMatch {
  readonly slug: string;
  readonly title: string;
  readonly category: ThreatCategory;
  readonly severity: Severity;
  /** pwn.watch still follows it. */
  readonly live: boolean;
  readonly patch: PatchState;
  /** `YYYY-MM-DD`, the day it began. */
  readonly startedAt: string;
  readonly why: ThreatWhy;
}

export type ThreatProblem = 'network' | 'timeout' | 'too-large' | 'invalid';

export interface ThreatFeed {
  readonly schema: typeof THREAT_FEED_SCHEMA;
  readonly source: typeof THREAT_SOURCE;
  readonly generatedAt: string;
  /** `unavailable`: no copy of the list could be had. */
  readonly state: 'ready' | 'unavailable';
  /** Why the latest download failed; with `ready`, the copy compared is an older one. */
  readonly problem: ThreatProblem | null;
  /** When the copy compared was downloaded, or null when there is none. */
  readonly fetchedAt: string | null;
  readonly compared: {
    readonly incidents: number;
    readonly packages: number;
    readonly ecosystems: readonly Ecosystem[];
    readonly agents: readonly ThreatAgent[];
    /** Project files that are there but could not be read, so what they list was not compared. */
    readonly unread: readonly StackFile[];
    /** Incidents of the list that did not fit the expected fields, so they were not compared. */
    readonly skipped: number;
  };
  readonly matches: readonly ThreatMatch[];
  /** Matches past those listed. */
  readonly more: number;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Characters that change how text reads without being seen, or that show as nothing: format and
 * default-ignorable characters, bidi controls, and the blank letters of Hangul and Braille. They never
 * reach the page.
 */
export const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}ᅟᅠ⠀ㅤﾠ]/u;
/** Text shown on the page has at least one letter or digit to see. */
const VISIBLE = /[\p{L}\p{N}]/u;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const isSlug = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 160 && SLUG.test(v);

/** A package name as the matcher keeps it: npm's in lower case, PyPI's in its normalized form. */
export function packageName(v: unknown, ecosystem: 'npm' | 'pypi'): v is string {
  if (typeof v !== 'string') return false;
  return ecosystem === 'npm'
    ? v.length <= 214 && NPM_NAME.test(v)
    : v.length <= 100 && PYPI_NAME.test(v);
}

/** The page of one incident on pwn.watch, or null for anything that is not a slug. */
export function threatUrl(slug: string): string | null {
  return isSlug(slug) ? `https://pwn.watch/i/${slug}` : null;
}

const shown = (v: unknown, max: number): v is string =>
  text(v, max) &&
  !INVISIBLE.test(v as string) &&
  VISIBLE.test(v as string) &&
  (v as string) === (v as string).trim();

const day = (v: unknown): v is string =>
  typeof v === 'string' &&
  DAY.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) &&
  new Date(`${v}T00:00:00.000Z`).toISOString().startsWith(v);

function validWhy(v: unknown): v is ThreatWhy {
  if (closed(v, ['kind', 'name', 'ecosystem']) && v.kind === 'package')
    return (
      (v.ecosystem === 'npm' || v.ecosystem === 'pypi') &&
      packageName(v.name, v.ecosystem as 'npm' | 'pypi')
    );
  if (closed(v, ['kind', 'agent']) && v.kind === 'agent') return member(v.agent, THREAT_AGENTS);
  if (closed(v, ['kind', 'ecosystem']) && v.kind === 'ecosystem')
    return member(v.ecosystem, ECOSYSTEMS);
  return false;
}

function validMatch(v: unknown): v is ThreatMatch {
  return (
    closed(v, ['slug', 'title', 'category', 'severity', 'live', 'patch', 'startedAt', 'why']) &&
    isSlug(v.slug) &&
    shown(v.title, 200) &&
    member(v.category, THREAT_CATEGORIES) &&
    member(v.severity, SEVERITIES) &&
    typeof v.live === 'boolean' &&
    member(v.patch, PATCH_STATES) &&
    day(v.startedAt) &&
    validWhy(v.why)
  );
}

const unique = (values: readonly unknown[]): boolean => new Set(values).size === values.length;

function validCompared(v: unknown): v is ThreatFeed['compared'] {
  return (
    closed(v, ['incidents', 'packages', 'ecosystems', 'agents', 'unread', 'skipped']) &&
    count(v.incidents, 20_000) &&
    count(v.skipped, 20_000) &&
    count(v.packages, 10_000) &&
    list(v.ecosystems, ECOSYSTEMS.length, (item): item is Ecosystem => member(item, ECOSYSTEMS)) &&
    unique(v.ecosystems) &&
    list(v.agents, THREAT_AGENTS.length, (item): item is ThreatAgent =>
      member(item, THREAT_AGENTS),
    ) &&
    unique(v.agents) &&
    list(v.unread, STACK_FILES.length, (item): item is StackFile => member(item, STACK_FILES)) &&
    unique(v.unread)
  );
}

export function validateThreatFeedRequest(v: unknown): v is { source: typeof THREAT_SOURCE } {
  return closed(v, ['source']) && v.source === THREAT_SOURCE;
}

export function validateThreatFeed(v: unknown): v is ThreatFeed {
  if (
    !closed(v, [
      'schema',
      'source',
      'generatedAt',
      'state',
      'problem',
      'fetchedAt',
      'compared',
      'matches',
      'more',
    ])
  )
    return false;
  const ready = v.state === 'ready';
  return (
    v.schema === THREAT_FEED_SCHEMA &&
    v.source === THREAT_SOURCE &&
    stamp(v.generatedAt) &&
    member(v.state, ['ready', 'unavailable']) &&
    (v.problem === null || member(v.problem, ['network', 'timeout', 'too-large', 'invalid'])) &&
    // Without a copy there is a reason and nothing to show; with one there is a time.
    (ready ? stamp(v.fetchedAt) : v.fetchedAt === null && v.problem !== null) &&
    validCompared(v.compared) &&
    list(v.matches, MAX_THREATS, validMatch) &&
    unique(v.matches.map((match) => match.slug)) &&
    count(v.more, 20_000) &&
    (ready || (v.matches.length === 0 && v.more === 0)) &&
    (v.more === 0 || v.matches.length === MAX_THREATS)
  );
}
