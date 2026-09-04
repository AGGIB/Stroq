import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionClass, Atom, AtomKind, ProvenanceHit } from '../types.js';
import { extractAtoms, normalizePackageName } from './atoms.js';

// Actions whose hosts/URLs are worth attributing: a URL copied from content
// into curl/ssh/git push (or a pipe-to-shell) is evidence; a URL copied into
// WebFetch is just the agent following a link.
const NETWORK_CLASSES: readonly ActionClass[] = [
  'shell.network',
  'git.push_external',
  'shell.exec_encoded',
];
const ALWAYS_COUNTED: readonly AtomKind[] = ['pkg', 'pipe_shell', 'encoded'];
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const REQUIREMENT_LINE = /^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)/;
const PYPROJECT_DEP = /["']([A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*(?:[<>=!~;]|["'])/g;
// `dependencies = [...]` assignments anywhere in the file (e.g. under `[project]`). The
// bracket body is bounded to 4,000 chars: given no closing "]" ahead, an unbounded `[^\]]*`
// scans to end-of-string and backtracks one char at a time — O(remaining length) per match
// attempt, O(n^2) over every `dependencies=[` occurrence in an adversarial file. A real
// dependency array is nowhere near 4,000 chars, so a longer one is simply truncated.
const PYPROJECT_DEPS_ARRAY = /dependencies\s*=\s*\[([^\]]{0,4000})\]/g;
// Any `key = [...]` assignment, scoped to the `[project.optional-dependencies]` table body.
// Same bound, same reason.
const PYPROJECT_KEYED_ARRAY = /=\s*\[([^\]]{0,4000})\]/g;
const OPTIONAL_DEPS_HEADER = '[project.optional-dependencies]';
// A manifest bigger than this contributes no names: reading (and then regex-scanning) an
// arbitrarily large planted file would itself be the slow part `knownPackages` must avoid,
// since it runs on every Bash PreToolUse.
const MAX_MANIFEST_BYTES = 262_144;

function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_MANIFEST_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function packageJsonNames(cwd: string): string[] {
  const raw = readText(join(cwd, 'package.json'));
  if (raw === null) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return [];
  const manifest = pkg as Record<string, unknown>;
  const deps = DEPENDENCY_SECTIONS.flatMap((section) => {
    const value = manifest[section];
    return value && typeof value === 'object' ? Object.keys(value as object) : [];
  });
  return typeof manifest['name'] === 'string' ? [...deps, manifest['name']] : deps;
}

function binNames(cwd: string): string[] {
  try {
    return readdirSync(join(cwd, 'node_modules', '.bin'));
  } catch {
    return [];
  }
}

/** The `[project.optional-dependencies]` table body: its header line up to the next `[…]` header, or EOF. */
function optionalDependenciesSection(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === OPTIONAL_DEPS_HEADER);
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && line.trimStart().startsWith('['));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/**
 * Bracket bodies of `pyproject.toml` dependency arrays only: top-level
 * `dependencies = [...]` assignments, plus every keyed array inside the
 * `[project.optional-dependencies]` table. The rest of the file (name,
 * version, readme, license, …) is quoted text too, but none of it names a
 * dependency, so it must never reach `PYPROJECT_DEP`.
 */
function pyprojectDependencyBodies(text: string): string[] {
  const direct = [...text.matchAll(PYPROJECT_DEPS_ARRAY)].map((m) => m[1] ?? '');
  const optional = [...optionalDependenciesSection(text).matchAll(PYPROJECT_KEYED_ARRAY)].map(
    (m) => m[1] ?? '',
  );
  return [...direct, ...optional];
}

function pythonNames(cwd: string): string[] {
  const fromRequirements = ['requirements.txt', 'requirements-dev.txt'].flatMap((file) =>
    (readText(join(cwd, file)) ?? '')
      .split('\n')
      .map((line) => REQUIREMENT_LINE.exec(line)?.[1] ?? '')
      .filter((name) => name.length > 0),
  );
  const pyprojectText = readText(join(cwd, 'pyproject.toml')) ?? '';
  const dependencyBodies = pyprojectDependencyBodies(pyprojectText).join('\n');
  const fromPyproject = [...dependencyBodies.matchAll(PYPROJECT_DEP)]
    .map((m) => m[1] ?? '')
    .filter((name) => name.length > 0);
  return [...fromRequirements, ...fromPyproject];
}

/**
 * Package names the project already depends on or has installed. Running
 * one of these is not "an unknown package copied from tool output", so
 * `npx tsc` after reading the project's own README stays silent.
 */
export function knownPackages(cwd: string): ReadonlySet<string> {
  return new Set(
    [...packageJsonNames(cwd), ...binNames(cwd), ...pythonNames(cwd)]
      .map(normalizePackageName)
      .filter((name) => name.length > 0),
  );
}

/** Atoms of a proposed action that could have been copied from earlier tool output. */
export function atomsForAction(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): Atom[] {
  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    if (command === '') return [];
    const known = knownPackages(cwd);
    return extractAtoms(command).filter((atom) => atom.kind !== 'pkg' || !known.has(atom.value));
  }
  if (toolName.startsWith('mcp__')) return extractAtoms(JSON.stringify(toolInput));
  return [];
}

export interface OriginClassification {
  readonly classes: readonly ActionClass[];
  /** The hits that contributed to `classes`, for evidence. */
  readonly counted: readonly ProvenanceHit[];
}

export function originClasses(
  hits: readonly ProvenanceHit[],
  classes: readonly ActionClass[],
): OriginClassification {
  const network = classes.some((c) => NETWORK_CLASSES.includes(c));
  const counted = hits.filter((h) => ALWAYS_COUNTED.includes(h.atom.kind) || network);
  const out: ActionClass[] = [];
  if (counted.length > 0) out.push('origin.untrusted');
  if (counted.some((h) => h.record.suspect)) out.push('origin.suspect');
  return { classes: out, counted };
}
