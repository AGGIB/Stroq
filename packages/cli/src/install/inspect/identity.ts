// What an artifact calls itself: its name and its version, as it declares them.
//
// A skill says so in the front matter of its SKILL.md, a server in its package.json (or the pyproject.toml
// of a Python one), a plugin in its manifest. When the artifact says nothing, the name is the one of
// the source (the label of a folder, the name of a package, the repository of a project, the host of an
// address), so that a passport always names what it is about, and never by a path of this machine.
import type { ArtifactKind, SourceRef } from '../types.js';
import type { InspectInput } from './input.js';
import { ownString, parseJsonObject } from './json.js';
import { showable } from './safe-text.js';

export interface Identity {
  readonly name: string;
  readonly version: string | null;
}

const NAME_MAX = 100;
const VERSION_MAX = 64;
/** A line of a TOML table header or a string value, read as a line and not as TOML (the parts of the file read here are that simple). */
const TABLE_HEADER = /^\s*\[([^\]]{1,64})\]\s*(?:#.*)?$/;
const STRING_VALUE = /^\s*(name|version)\s*=\s*(?:"([^"]{1,200})"|'([^']{1,200})')/;

/** What the source calls the artifact, for an artifact that does not say. */
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
    const text = value?.[2] ?? value?.[3];
    if ((key === 'name' || key === 'version') && text !== undefined && found[key] === undefined) {
      found[key] = text;
    }
  }
  return found;
}

function manifestIdentity(input: InspectInput, path: string): Partial<Identity> {
  const manifest = parseJsonObject(input.byPath.get(path)?.text ?? '');
  if (manifest === null) return {};
  const name = ownString(manifest, 'name');
  const version = ownString(manifest, 'version');
  return { ...(name === null ? {} : { name }), ...(version === null ? {} : { version }) };
}

/** What the files declare, for the kind of artifact, before anything is made safe to show. */
function declared(
  kind: ArtifactKind,
  input: InspectInput,
  fromFrontMatter: Partial<Identity>,
): Partial<Identity> {
  if (kind === 'skill') return fromFrontMatter;
  if (kind === 'plugin') return manifestIdentity(input, '.claude-plugin/plugin.json');
  const fromPackage = manifestIdentity(input, 'package.json');
  if (fromPackage.name !== undefined) return fromPackage;
  return pyprojectIdentity(input.byPath.get('pyproject.toml')?.text ?? '');
}

export function identify(
  kind: ArtifactKind,
  input: InspectInput,
  source: SourceRef,
  fromFrontMatter: Partial<Identity> = {},
): Identity {
  const says = declared(kind, input, fromFrontMatter);
  const name = showable(says.name ?? '', NAME_MAX);
  const version = showable(says.version ?? '', VERSION_MAX);
  return {
    name: name === '' ? showable(sourceName(source), NAME_MAX) || 'artifact' : name,
    version: version === '' ? null : version,
  };
}
