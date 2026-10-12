// What an artifact is called, and what it says it is called.
//
// The title of a passport is the name of the thing that was taken, and that is a fact of where it was
// taken from and not of what it says: a package fetched as `npm:evil-pkg` that writes
// `"name": "@modelcontextprotocol/server-github"` in its package.json is `evil-pkg`. So where the source
// names the artifact (an npm package, a repository) the title is the name of the source, and never the
// declared one. What the artifact declares about itself (the front matter of a skill, a package.json, a
// pyproject.toml, a plugin manifest) is kept apart as a `DeclaredIdentity`, and `identity-lines.ts` puts
// it in the passport as a declaration, with a signal when it differs from the name of the source. Where
// the source names nothing (a folder, a tarball, an address) the declared name is the best there is, and
// is the title, but it is still shown as declared by the artifact, and no code treats it as verified.
import type { ArtifactKind, SourceRef } from '../types.js';
import type { InspectInput } from './input.js';
import { ownString, parseJsonObject } from './json.js';
import { showable } from './safe-text.js';

/** The name and version a passport is titled with. */
export interface Identity {
  readonly name: string;
  readonly version: string | null;
}

/** What an artifact says of itself, and the file it says it in. Not verified by anything. */
export interface DeclaredIdentity {
  readonly name: string | null;
  readonly version: string | null;
  readonly file: string;
}

/** What the reading of the front matter hands on: the declaration of the skill, if it made one. */
export interface DeclaredHint {
  readonly name?: string;
  readonly version?: string;
  readonly file?: string;
}

const NAME_MAX = 100;
const VERSION_MAX = 64;
/** A line of a TOML table header or a string value, read as a line and not as TOML (the parts of the file read here are that simple). */
const TABLE_HEADER = /^\s*\[([^\]]{1,64})\]\s*(?:#.*)?$/;
const STRING_VALUE = /^\s*(name|version)\s*=\s*(?:"([^"]{1,200})"|'([^']{1,200})')/;

/** What the source calls the artifact. */
export function sourceName(source: SourceRef): string {
  switch (source.type) {
    case 'dir':
    case 'tarball':
      return source.label;
    case 'npm':
      return source.name;
    case 'github':
      return source.repo;
    case 'url':
      return source.host;
  }
}

/** The `name` and `version` of the `[project]` table of a pyproject.toml. */
function pyprojectIdentity(text: string): { name?: string; version?: string } {
  const found: { name?: string; version?: string } = {};
  let inProject = false;
  for (const line of text.split('\n')) {
    const header = TABLE_HEADER.exec(line);
    if (header !== null) {
      inProject = header[1]?.trim() === 'project';
      continue;
    }
    const value = inProject ? STRING_VALUE.exec(line) : null;
    const key = value?.[1];
    const given = value?.[2] ?? value?.[3];
    if ((key === 'name' || key === 'version') && given !== undefined && found[key] === undefined) {
      found[key] = given;
    }
  }
  return found;
}

/** Text that says something: not missing, not blank. */
const said = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === '' ? null : value.trim();

function declaration(
  name: string | null,
  version: string | null,
  file: string,
): DeclaredIdentity | null {
  return name === null && version === null ? null : { name, version, file };
}

function manifestDeclared(input: InspectInput, path: string): DeclaredIdentity | null {
  const manifest = parseJsonObject(input.byPath.get(path)?.text ?? '');
  if (manifest === null) return null;
  return declaration(said(ownString(manifest, 'name')), said(ownString(manifest, 'version')), path);
}

function pyprojectDeclared(input: InspectInput): DeclaredIdentity | null {
  const found = pyprojectIdentity(input.byPath.get('pyproject.toml')?.text ?? '');
  return declaration(said(found.name), said(found.version), 'pyproject.toml');
}

/** What the files of the kind of artifact say it is called, or null when they say nothing. */
export function declaredIdentity(
  kind: ArtifactKind,
  input: InspectInput,
  hint: DeclaredHint,
): DeclaredIdentity | null {
  if (kind === 'skill') {
    return hint.file === undefined
      ? null
      : declaration(said(hint.name), said(hint.version), hint.file);
  }
  if (kind === 'plugin') return manifestDeclared(input, '.claude-plugin/plugin.json');
  return manifestDeclared(input, 'package.json') ?? pyprojectDeclared(input);
}

/** The names a repository can be given by an artifact that is its own: `repo`, `owner/repo` and `@owner/repo`. */
const repositoryNames = (owner: string, repo: string): readonly string[] =>
  [repo, `${owner}/${repo}`, `@${owner}/${repo}`].map((name) => name.toLowerCase());

/**
 * Whether the name an artifact declares is not the name of the source it was taken from. Only a source
 * that names the artifact (an npm package, a repository) has a name to differ from.
 */
export function declaredNameDiffers(source: SourceRef, declaredName: string): boolean {
  if (source.type === 'npm') return declaredName !== source.name;
  if (source.type === 'github') {
    return !repositoryNames(source.owner, source.repo).includes(declaredName.toLowerCase());
  }
  return false;
}

/**
 * The title of a passport: the name (and for a package the version) of the source where it names the
 * artifact, and otherwise the declared name, and otherwise the name of the source.
 */
export function identify(source: SourceRef, declared: DeclaredIdentity | null): Identity {
  const fallback = showable(sourceName(source), NAME_MAX) || 'artifact';
  switch (source.type) {
    case 'npm':
      return { name: fallback, version: showable(source.version, VERSION_MAX) || null };
    case 'github':
      return {
        name: showable(`${source.owner}/${source.repo}`, NAME_MAX) || fallback,
        version: null,
      };
    default: {
      const name = showable(declared?.name ?? '', NAME_MAX);
      const version = showable(declared?.version ?? '', VERSION_MAX);
      return { name: name === '' ? fallback : name, version: version === '' ? null : version };
    }
  }
}
