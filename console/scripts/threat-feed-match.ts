import {
  SEVERITIES,
  packageName,
  type Ecosystem,
  type ThreatAgent,
  type ThreatMatch,
  type ThreatWhy,
} from '../lib/threat-feed';
import type { Incident } from './threat-feed-source';
import { normalizePypi, type Stack } from './threat-feed-stack';

/**
 * Which of pwn.watch's incidents match this project, and why, most pressing first. Three ways only,
 * each one a name that pwn.watch gives and the project or this machine has:
 * - a package this project lists, named in the incident as a package (with a version, marked `(npm)`
 *   or `(PyPI)`, scoped, or in the list after "npm" or "PyPI"), within the last half year;
 * - a coding agent set up here, named in the incident's product or as a tag;
 * - a live supply-chain incident pwn.watch files first under an ecosystem this project uses.
 * Vendor tags are not used: pwn.watch tags a browser bug "anthropic" because Anthropic found it.
 */

const DAY_MS = 86_400_000;
/** A package named this long ago may still be pinned in a lockfile. */
const PACKAGE_DAYS = 180;
/** An incident pwn.watch closed is still shown this long after its last update. */
const RECENT_DAYS = 14;

/** The stacks pwn.watch files an ecosystem's incidents under. */
const ECOSYSTEM_STACKS: Readonly<Record<Ecosystem, readonly string[]>> = {
  npm: ['npm', 'node'],
  pypi: ['pypi', 'python'],
  'github-actions': ['github-actions'],
  docker: ['docker'],
  go: ['go'],
  rust: ['rust'],
  ruby: ['ruby'],
  php: ['php'],
  wordpress: ['wordpress'],
  java: ['java'],
  dotnet: ['dotnet'],
};

const AGENT_NAMES: Readonly<
  Record<ThreatAgent, { readonly product: RegExp; readonly tags: readonly string[] }>
> = {
  'claude-code': { product: /\bClaude Code\b/, tags: ['claude-code'] },
  // Capitalized: "cursor" is also a word.
  cursor: { product: /\bCursor\b/, tags: ['cursor'] },
  codex: { product: /\bCodex\b/, tags: ['codex', 'codex-cli'] },
};

/** Words that name an ecosystem or a vendor, never the package a project lists. */
const NOT_PACKAGES = new Set([
  'npm',
  'node',
  'nodejs',
  'python',
  'pypi',
  'pip',
  'go',
  'golang',
  'rust',
  'java',
  'php',
  'ruby',
  'docker',
  'github',
  'packages',
  'package',
  // Words of the prose around versions.
  'and',
  'or',
  'the',
  'to',
  'of',
  'in',
  'on',
  'for',
  'from',
  'with',
  'all',
  'version',
  'versions',
  'before',
  'through',
  'until',
  'prior',
  'up',
]);

const VERSION = /^v?\d/;
/** A token that is only a version (`1.0.137`, `v2`), never a name. */
const ONLY_VERSION = /^v?\d+(?:\.\d+)*$/;
const VERSION_WORDS = new Set(['before', 'through', 'to', 'until', 'prior']);
const GLUED = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*?)(?:==|@|>=|<=|~=)v?\d/;
const ECOSYSTEM_MARK = /^\((?:npm|pypi)\)/;
/** `npm ecosystem (keyv, cacheable, flat-cache, …)`: the list in brackets after the ecosystem. */
const LISTED = /\b(?:npm|pypi)\b[^()]{0,80}\(([^()]{1,400})\)/;

/** Longer than any npm name: no package. */
const MAX_NAME = 214;
const isAlnum = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 97 && code <= 122);

/** A token without the punctuation around it, read from both ends once (a pattern backtracked here). */
function trimmed(token: string): string {
  if (token.length > MAX_NAME + 8) return '';
  let start = 0;
  while (start < token.length && !isAlnum(token.charCodeAt(start)) && token.charAt(start) !== '@')
    start += 1;
  let end = token.length;
  while (end > start && !isAlnum(token.charCodeAt(end - 1))) end -= 1;
  return token.slice(start, end);
}

/** The names each incident gives, worked out once per downloaded list, not on every request. */
const NAMED = new WeakMap<Incident, Set<string>>();

/** The names an incident gives as packages, in lower case. */
export function namedPackages(incident: Incident): Set<string> {
  const known = NAMED.get(incident);
  if (known !== undefined) return known;
  const out = new Set<string>();
  const product = incident.product.toLowerCase();
  const productTokens = new Set(product.split(/[^a-z0-9@._~/-]+/).map(trimmed));
  // A tag counts for a patch, where it is the product's own name (`langflow` for "Langflow"), and only
  // where the product says it too. Elsewhere tags also name the companies hit (`openai`) and kinds of
  // attack; an attack on packages names them with a version, a mark or a scope.
  if (incident.category === 'patch')
    for (const tag of incident.tags) if (productTokens.has(tag)) out.add(tag);
  for (const text of [product, ...incident.affected.map((entry) => entry.toLowerCase())]) {
    const tokens = text.split(/[\s,;]+/).filter((token) => token !== '');
    tokens.forEach((raw, i) => {
      const token = trimmed(raw);
      const glued = GLUED.exec(token);
      if (glued !== null) out.add(glued[1] as string);
      if (token.startsWith('@') && token.includes('/')) out.add(token);
      const next = tokens[i + 1] ?? '';
      if (
        !ONLY_VERSION.test(token) &&
        (VERSION.test(next) ||
          ECOSYSTEM_MARK.test(next) ||
          (VERSION_WORDS.has(next) && VERSION.test(tokens[i + 2] ?? '')))
      )
        out.add(token);
    });
  }
  const listed = LISTED.exec(product);
  if (listed !== null)
    for (const part of (listed[1] as string).split(/,|\band\b/)) out.add(trimmed(part.trim()));
  for (const name of [...out])
    if (
      NOT_PACKAGES.has(name) ||
      !(packageName(name, 'npm') || packageName(normalizePypi(name), 'pypi'))
    )
      out.delete(name);
  NAMED.set(incident, out);
  return out;
}

const inEcosystem = (incident: Incident, ecosystem: 'npm' | 'pypi'): boolean =>
  incident.stacks.some((stack) => ECOSYSTEM_STACKS[ecosystem].includes(stack)) ||
  incident.product.toLowerCase().includes(`(${ecosystem})`) ||
  incident.product.toLowerCase().includes(ecosystem);

function packageHit(incident: Incident, stack: Stack): ThreatWhy | null {
  const named = namedPackages(incident);
  if (inEcosystem(incident, 'npm'))
    for (const name of named)
      if (packageName(name, 'npm') && stack.npm.has(name))
        return { kind: 'package', name, ecosystem: 'npm' };
  if (inEcosystem(incident, 'pypi'))
    for (const name of named) {
      const pypi = normalizePypi(name);
      if (packageName(pypi, 'pypi') && stack.pypi.has(pypi))
        return { kind: 'package', name: pypi, ecosystem: 'pypi' };
    }
  return null;
}

function agentHit(incident: Incident, stack: Stack): ThreatWhy | null {
  for (const agent of stack.agents) {
    const names = AGENT_NAMES[agent];
    if (names.product.test(incident.product) || incident.tags.some((t) => names.tags.includes(t)))
      return { kind: 'agent', agent };
  }
  return null;
}

function ecosystemHit(incident: Incident, stack: Stack): ThreatWhy | null {
  if (incident.category !== 'supply-chain') return null;
  // A WordPress plugin's incident is for a WordPress site, not for every PHP project.
  const wordpress = incident.stacks.includes('wordpress');
  // pwn.watch lists an incident's own ecosystem first (`node, npm`); one listed after it is touched on
  // the way (a PyPI compromise that went through a GitHub workflow), not where it happened.
  const own = incident.stacks.slice(0, 2);
  for (const ecosystem of stack.ecosystems) {
    if (ecosystem === 'php' && wordpress && !stack.ecosystems.has('wordpress')) continue;
    if (own.some((tag) => ECOSYSTEM_STACKS[ecosystem].includes(tag)))
      return { kind: 'ecosystem', ecosystem };
  }
  return null;
}

const RANK: Readonly<Record<ThreatWhy['kind'], number>> = { package: 0, agent: 1, ecosystem: 2 };
const severityRank = (severity: Incident['severity']): number => SEVERITIES.indexOf(severity);

/** Every incident that matches, most pressing first: by kind of match, live, severity, then newest. */
export function matchThreats(
  incidents: readonly Incident[],
  stack: Stack,
  now: Date,
): ThreatMatch[] {
  const since = (days: number): number => now.getTime() - days * DAY_MS;
  const found: Array<{ incident: Incident; why: ThreatWhy }> = [];
  for (const incident of incidents) {
    const touched = Math.max(incident.updatedAt, Date.parse(`${incident.startedAt}T00:00:00.000Z`));
    const current = incident.live || touched >= since(RECENT_DAYS);
    const why =
      (touched >= since(PACKAGE_DAYS) ? packageHit(incident, stack) : null) ??
      (current ? agentHit(incident, stack) : null) ??
      (current ? ecosystemHit(incident, stack) : null);
    if (why !== null) found.push({ incident, why });
  }
  found.sort(
    (a, b) =>
      RANK[a.why.kind] - RANK[b.why.kind] ||
      Number(b.incident.live) - Number(a.incident.live) ||
      severityRank(a.incident.severity) - severityRank(b.incident.severity) ||
      b.incident.updatedAt - a.incident.updatedAt,
  );
  return found.map(({ incident, why }) => ({
    slug: incident.slug,
    title: incident.title,
    category: incident.category,
    severity: incident.severity,
    live: incident.live,
    patch: incident.patch,
    startedAt: incident.startedAt,
    why,
  }));
}
