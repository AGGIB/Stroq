import { isPlainObject } from '../commands/config-file.js';
import {
  firstEntries,
  own,
  ownObject,
  ownString,
  quoted,
  serverFields,
  serverKind,
  strings,
  type JsonFile,
  type Obj,
} from './agent-json.js';
import { digestOf, hit, otherFields, type AgentHit } from './agent-kinds.js';
import { lineOf } from './jsonc.js';

/**
 * Readers for the configs of agents and editors whose shape is their own: opencode, which starts
 * a local server from an array and loads plugins by name or from `.opencode/plugin/`, and Zed,
 * whose context servers and language servers start from its settings.
 */

/** A server that starts `parts`, the program first, with the entry's other fields. */
function serverHit(f: JsonFile, line: number, name: string, parts: readonly string[], entry: Obj) {
  const [command = '', ...args] = parts;
  const value = `${parts.join(' ')}${serverFields(entry)}`;
  return hit(serverKind(command, args, entry), f.path, line, name, value);
}

/** opencode's `mcp` servers (a local one's `command` is an array) and its `plugin` list. */
export function opencodeConfig(f: JsonFile): AgentHit[] {
  const servers = firstEntries(f.path, 'servers', Object.entries(ownObject(f.value, 'mcp') ?? {}));
  const hits: AgentHit[] = [...servers.cut];
  for (const [name, entry] of servers.items) {
    if (!isPlainObject(entry)) continue;
    const line = lineOf(f.text, ['"mcp"', quoted(name)]);
    const command = own(entry, 'command');
    const parts = typeof command === 'string' ? [command] : strings(command);
    const url = ownString(entry, 'url');
    if (parts.length > 0) hits.push(serverHit(f, line, name, parts, entry));
    else if (url !== undefined)
      hits.push(hit('mcp-server', f.path, line, name, `${url}${serverFields(entry)}`));
  }
  const plugins = firstEntries(f.path, 'plugins', strings(own(f.value, 'plugin')));
  return [
    ...hits,
    ...plugins.cut,
    ...plugins.items.map((p) =>
      hit('agent-plugin', f.path, lineOf(f.text, ['"plugin"', quoted(p)]), 'plugin', p),
    ),
  ];
}

/** A file of `.opencode/plugin/`: code opencode loads and runs when it starts. */
export const pluginCode = (path: string, text: string): AgentHit[] => [
  hit('agent-plugin', path, 1, 'plugin code', digestOf(text)),
];

/** A Zed context server: `command` is a program with `args`, or `{ path, args, env }`. */
function zedServer(f: JsonFile, name: string, entry: Obj): AgentHit | undefined {
  const line = lineOf(f.text, ['"context_servers"', quoted(name)]);
  const command = own(entry, 'command');
  if (typeof command === 'string')
    return serverHit(f, line, name, [command, ...strings(own(entry, 'args'))], entry);
  if (isPlainObject(command)) {
    const path = ownString(command, 'path');
    if (path === undefined) return undefined;
    const parts = [path, ...strings(own(command, 'args'))];
    const fields = otherFields(command, (key) => key === 'path' || key === 'args');
    const found = serverHit(f, line, name, parts, command);
    return { ...found, value: `${parts.join(' ')}${fields}${serverFields(entry)}` };
  }
  const url = ownString(entry, 'url');
  return url === undefined
    ? undefined
    : hit('mcp-server', f.path, line, name, `${url}${serverFields(entry)}`);
}

/** Zed's settings: its context servers, and the binary each language server starts from. */
export function zedSettings(f: JsonFile): AgentHit[] {
  const servers = firstEntries(
    f.path,
    'servers',
    Object.entries(ownObject(f.value, 'context_servers') ?? {}),
  );
  const hits: AgentHit[] = [...servers.cut];
  for (const [name, entry] of servers.items) {
    const found = isPlainObject(entry) ? zedServer(f, name, entry) : undefined;
    if (found !== undefined) hits.push(found);
  }
  const languages = firstEntries(
    f.path,
    'language servers',
    Object.entries(ownObject(f.value, 'lsp') ?? {}),
  );
  hits.push(...languages.cut);
  for (const [language, entry] of languages.items) {
    const binary = isPlainObject(entry) ? ownObject(entry, 'binary') : undefined;
    const path = binary === undefined ? undefined : ownString(binary, 'path');
    if (binary === undefined || path === undefined) continue;
    const parts = [path, ...strings(own(binary, 'arguments'))];
    const rest = otherFields(binary, (key) => key === 'path' || key === 'arguments');
    hits.push(
      hit(
        'agent-helper-command',
        f.path,
        lineOf(f.text, ['"lsp"', quoted(language), '"binary"']),
        `lsp.${language}.binary`,
        `${parts.join(' ')}${rest}`,
      ),
    );
  }
  return hits;
}
