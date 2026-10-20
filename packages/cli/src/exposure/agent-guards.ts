import { isPlainObject } from '../commands/config-file.js';
import type { TaggedHit } from './agent-change.js';
import { guardsOf, type Guard } from './agent-json.js';
import { hit } from './agent-kinds.js';
import { stripJsonc } from './jsonc.js';

/**
 * What a change takes away from Claude Code's settings: a deny rule, or a server of `.mcp.json`
 * kept from starting by `disabledMcpjsonServers`. Neither runs anything, so no reader reports it;
 * taking one away lets the agent do what it was refused, so it fails like an allow rule a change
 * adds. Compared as a set of values, so moving a rule within the file changes nothing.
 */

/**
 * The guards of the head of a settings file, read as strictly as Claude Code reads it: as JSON with
 * no comment and no trailing comma, each list a list of strings. A file or a list that does not
 * read so refuses nothing, so everything the base refused counts as taken away.
 */
export function headGuardsOfText(text: string): readonly Guard[] {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? guardsOf(value, true) : [];
  } catch {
    return [];
  }
}

/**
 * The guards of the base, read leniently: comments and trailing commas read past, every entry
 * counted. Reading more there can only find more taken away. None when it does not parse at all.
 */
export function baseGuardsOfText(text: string): readonly Guard[] {
  try {
    const value: unknown = JSON.parse(stripJsonc(text));
    return isPlainObject(value) ? guardsOf(value, false) : [];
  } catch {
    return [];
  }
}

const key = (g: Guard): string => `${g.name}\u0000${g.value}`;

/** A failing entry for each guard of `base` that `head` no longer has. */
export function removedGuards(
  path: string,
  head: readonly Guard[],
  base: readonly Guard[],
): TaggedHit[] {
  const kept = new Set(head.map(key));
  const gone = new Map(base.filter((g) => !kept.has(key(g))).map((g) => [key(g), g]));
  return [...gone.values()].map((g) => ({
    ...hit('agent-permission-bypass', path, 1, g.name, g.value),
    status: 'changed',
  }));
}

/** The failing entry for a settings file whose base was not read, so what it refused is not known. */
export const guardsUnknown = (path: string, why: string): TaggedHit => ({
  ...hit(
    'unreadable-config',
    path,
    1,
    'deny rules',
    `whether the change took away a deny rule or a disabled server was not worked out: ${why}`,
  ),
  status: 'changed',
});
