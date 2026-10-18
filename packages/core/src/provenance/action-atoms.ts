import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isShellTool } from '../actions/shell-tools.js';
import { normalizeText } from '../normalize/normalizer.js';
import { DEFAULT_MAX_CHARS } from '../scan/scanner.js';
import type { ActionClass, Atom, AtomKind, ProvenanceHit } from '../types.js';
import { collectStringsDeep } from '../cloak/json-strings.js';
import { readRegularFile } from '../util/read-regular-file.js';
import { FLOOR_KINDS } from './atom-kinds.js';
import { extractActionAtoms, normalizePackageName } from './atoms.js';

// Actions whose hosts/URLs are worth attributing: a URL copied from content
// into curl/ssh/git push (or a pipe-to-shell) is evidence; a URL copied into
// WebFetch is just the agent following a link.
const NETWORK_CLASSES: readonly ActionClass[] = [
  'shell.network',
  'git.push_external',
  'shell.exec_encoded',
];
const ALWAYS_COUNTED: readonly AtomKind[] = FLOOR_KINDS;
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
// dependency array is nowhere near 4,000 chars; a longer one has no "]" within the bound,
// so the assignment does not match at all and that array contributes no names.
const PYPROJECT_DEPS_ARRAY = /dependencies\s*=\s*\[([^\]]{0,4000})\]/g;
// Any `key = [...]` assignment, scoped to the `[project.optional-dependencies]` table body.
// Same bound, same reason.
const PYPROJECT_KEYED_ARRAY = /=\s*\[([^\]]{0,4000})\]/g;
const OPTIONAL_DEPS_HEADER = '[project.optional-dependencies]';
// A manifest bigger than this contributes no names: reading (and then regex-scanning) an
// arbitrarily large planted file would itself be the slow part `knownPackages` must avoid,
// since it runs on every Bash PreToolUse.
const MAX_MANIFEST_BYTES = 262_144;

/**
 * A manifest's text, or `null` when there is none worth reading. Only a regular file
 * counts: `mkfifo package.json` once made every later Bash PreToolUse in that
 * directory wait on the pipe until the agent's own timeout, which Codex and Copilot
 * treat as an allow (docs/AGENTS.md).
 */
function readText(path: string): string | null {
  try {
    const read = readRegularFile(path, MAX_MANIFEST_BYTES);
    return read.kind === 'text' ? read.text : null;
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

/**
 * An MCP call's arguments as the text they carry: the string values, one to a line. Serialised,
 * a line break in a value is the two characters backslash and `n`, and a pattern that needs the
 * start of a line (`npx`, `npm install`) no longer finds its start. An argument with no string
 * in it is all there is to read, so it is serialised.
 */
function textOfInput(toolInput: Readonly<Record<string, unknown>>): string {
  const strings = collectStringsDeep(toolInput, 2 * DEFAULT_MAX_CHARS);
  if (strings.length > 0) return strings.join('\n');
  try {
    return JSON.stringify(toolInput);
  } catch {
    return '';
  }
}

/** The atoms of a proposed action, and whether some part of it could not be read (see `ActionExtraction`). */
export interface ReadAction {
  readonly atoms: Atom[];
  readonly unread: boolean;
}

const NOTHING_READ: ReadAction = { atoms: [], unread: false };

/**
 * Atoms of a proposed action that could have been copied from earlier tool output, and whether
 * the action could be read to its end. The action text is normalized first, exactly like the
 * scanned output it is matched against: otherwise a command carrying a zero-width space or a
 * homoglyph would hash differently from the very content it was copied from, and vice versa.
 */
export function readActionAtoms(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ReadAction {
  if (isShellTool(toolName)) {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    if (command === '') return NOTHING_READ;
    const known = knownPackages(cwd);
    const read = extractActionAtoms(normalizeText(command));
    return {
      atoms: read.atoms.filter((atom) => atom.kind !== 'pkg' || !known.has(atom.value)),
      unread: read.unread,
    };
  }
  if (toolName.startsWith('mcp__'))
    return extractActionAtoms(normalizeText(textOfInput(toolInput)));
  return NOTHING_READ;
}

/** The atoms alone: see `readActionAtoms`. */
export function atomsForAction(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): Atom[] {
  return readActionAtoms(toolName, toolInput, cwd).atoms;
}

export interface OriginClassification {
  readonly classes: readonly ActionClass[];
  /** The hits that contributed to `classes`, for evidence. */
  readonly counted: readonly ProvenanceHit[];
}

export const isNetworkShaped = (classes: readonly ActionClass[]): boolean =>
  classes.some((c) => NETWORK_CLASSES.includes(c));

/**
 * Whether an atom counts towards an action's origin: a package, a pipe-to-shell or an
 * encoded blob always, a URL or host only when the action is network-shaped.
 */
function counts(atom: Atom, networkShaped: boolean): boolean {
  return ALWAYS_COUNTED.includes(atom.kind) || networkShaped;
}

/**
 * The atoms that can raise the floor of a session whose records are incomplete: packages,
 * pipe-to-shell and encoded blobs. A URL or host never does, however network-shaped the
 * action: a flagged record that was lost has already tainted the session, and a tainted
 * session denies network commands, so the floor there would only ask about every `curl`
 * and `ssh` of an unflagged one.
 */
export function floorAtoms(atoms: readonly Atom[]): Atom[] {
  return atoms.filter((atom) => ALWAYS_COUNTED.includes(atom.kind));
}

/**
 * The `origin.*` classes of an action, from the records its atoms matched (`hits`) and
 * from `unverified`: atoms that can raise the floor, that no record holds, in a session
 * whose records are known to be incomplete (see `floorAtoms` for which can). `doubt` is
 * the same for what could not be checked: the part of the action that could not be read, a
 * package name that cannot be read from the command, a result that could not be scanned. It is
 * `origin.untrusted` too, for the same reasons.
 *
 * A record that matches keeps its class, `origin.suspect` included. An unverified atom is
 * `origin.untrusted` and never `origin.suspect`: the loss says the source cannot be ruled
 * out, not that it was flagged. So the floor asks, where a flagged record that is still on
 * hand denies. That also keeps it out of the task hard set (`HARD_CLASSES` holds
 * `origin.suspect`, deliberately not `origin.untrusted`): a task's policy ask is a refusal
 * its owner can lift for that one call, which is the right size for uncertainty, while a
 * hard class cannot be lifted by anything and would turn the first unrecorded package of
 * every long session into a dead end.
 */
export function originClasses(
  hits: readonly ProvenanceHit[],
  classes: readonly ActionClass[],
  unverified: readonly Atom[] = [],
  doubt = false,
): OriginClassification {
  const networkShaped = isNetworkShaped(classes);
  const counted = hits.filter((h) => counts(h.atom, networkShaped));
  const out: ActionClass[] = [];
  if (counted.length > 0 || unverified.length > 0 || doubt) out.push('origin.untrusted');
  if (counted.some((h) => h.record.suspect)) out.push('origin.suspect');
  return { classes: out, counted };
}
