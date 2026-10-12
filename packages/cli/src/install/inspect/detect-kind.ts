// What kind of artifact a tree is, from the files that say so.
//
// A skill has a SKILL.md at its root. A plugin has a manifest in `.claude-plugin/`. An MCP server is a
// package that can be started (a `bin` or a `main`) and looks like one (it is named for the protocol or
// depends on its SDK), a `.mcp.json`, or a Python project that depends on `mcp`. A plugin may hold a
// `.mcp.json` and skills, so a plugin manifest wins. A tree that looks like two of the others is not
// guessed at: the person who vets it says which it is.
import type { ArtifactKind } from '../types.js';
import type { InspectInput } from './input.js';
import { own, ownObject, ownString, parseJsonObject, type JsonObject } from './json.js';

const MCP_SCOPE = '@modelcontextprotocol/';
/** `mcp` as a word of a package name (`my-mcp-server`, `mcp_tools`), and not a part of one (`mcpherson`). */
const MCP_WORD = /(?:^|[^a-z0-9])mcp(?:[^a-z0-9]|$)/i;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
/** A requirement of Python that is the `mcp` package or `fastmcp`, written as `mcp>=1.0` or `"mcp"`. */
const PYTHON_MCP = /(?:^|[\s"'\[,])(?:mcp|fastmcp)(?:[\s"'\],<>=~!;[]|$)/im;

function dependsOnMcp(manifest: JsonObject): boolean {
  return DEPENDENCY_FIELDS.some((field) => {
    const group = ownObject(manifest, field);
    return group !== null && Object.keys(group).some((name) => name.startsWith(MCP_SCOPE));
  });
}

function isMcpPackage(text: string): boolean {
  const manifest = parseJsonObject(text);
  if (manifest === null) return false;
  const launches = own(manifest, 'bin') !== undefined || own(manifest, 'main') !== undefined;
  if (!launches) return false;
  const name = ownString(manifest, 'name') ?? '';
  return name.startsWith(MCP_SCOPE) || MCP_WORD.test(name) || dependsOnMcp(manifest);
}

function isPythonMcp(input: InspectInput): boolean {
  const pyproject = input.byPath.get('pyproject.toml')?.text ?? '';
  const requirements = input.byPath.get('requirements.txt')?.text ?? '';
  return PYTHON_MCP.test(pyproject) || PYTHON_MCP.test(requirements);
}

/** The kinds a tree could be, in the order skill, mcp, plugin. */
export function candidateKinds(input: InspectInput): ArtifactKind[] {
  const kinds: ArtifactKind[] = [];
  if (input.paths.has('SKILL.md')) kinds.push('skill');
  const manifest = input.byPath.get('package.json');
  if (
    input.paths.has('.mcp.json') ||
    (manifest !== undefined && isMcpPackage(manifest.text)) ||
    isPythonMcp(input)
  ) {
    kinds.push('mcp');
  }
  if (input.paths.has('.claude-plugin/plugin.json')) kinds.push('plugin');
  return kinds;
}

export type KindResult =
  { readonly kind: ArtifactKind } | { readonly problem: 'none' | 'more-than-one' };

/** The kind of a tree, or why it cannot be told. */
export function detectKind(input: InspectInput): KindResult {
  const kinds = candidateKinds(input);
  if (kinds.includes('plugin')) return { kind: 'plugin' };
  const [only, ...rest] = kinds;
  if (only === undefined) return { problem: 'none' };
  return rest.length === 0 ? { kind: only } : { problem: 'more-than-one' };
}
