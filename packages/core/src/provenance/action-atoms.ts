import { readFileSync, readdirSync } from 'node:fs';
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

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function packageJsonNames(cwd: string): string[] {
  const raw = readText(join(cwd, 'package.json'));
  if (raw === null) return [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  const deps = DEPENDENCY_SECTIONS.flatMap((section) => {
    const value = pkg[section];
    return value && typeof value === 'object' ? Object.keys(value as object) : [];
  });
  return typeof pkg['name'] === 'string' ? [...deps, pkg['name']] : deps;
}

function binNames(cwd: string): string[] {
  try {
    return readdirSync(join(cwd, 'node_modules', '.bin'));
  } catch {
    return [];
  }
}

function pythonNames(cwd: string): string[] {
  const fromRequirements = ['requirements.txt', 'requirements-dev.txt'].flatMap((file) =>
    (readText(join(cwd, file)) ?? '')
      .split('\n')
      .map((line) => REQUIREMENT_LINE.exec(line)?.[1] ?? '')
      .filter((name) => name.length > 0),
  );
  const fromPyproject = [...(readText(join(cwd, 'pyproject.toml')) ?? '').matchAll(PYPROJECT_DEP)]
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
