import { isPlainObject } from '../commands/config-file.js';
import {
  firstEntries,
  hookEntries,
  MAX_HOOKS,
  serverFields,
  serverKind,
  tooMany,
} from './agent-json.js';
import { boundedJson, digestOf, hit, type AgentHit } from './agent-kinds.js';
import { lineOf } from './jsonc.js';
import { parseToml, type Obj, type Toml } from './toml-lite.js';

/**
 * Codex's `config.toml`, read for what it runs: `[mcp_servers.*]`, hooks written as tables or
 * inline, and `notify`. A file the TOML reader cannot follow fails: Codex reads it with a full
 * parser, and a key can be spelled in quotes and escapes (`"comm\u0061nd"`) that no word search
 * finds.
 */

/** The text with its comments blanked, to find lines in without finding a commented-out entry. */
const withoutComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');

const firstWord = (command: string): string => command.split(' ')[0] ?? command;

/**
 * The line to show for `key` of a server: where the reader saw it set, else where its words
 * first stand in the text (a key set by a table header has no `=` of its own).
 */
const serverLine = (toml: Toml, text: string, entry: Obj, name: string, key: string): number =>
  toml.keyLine(entry, key) ?? lineOf(text, ['mcp_servers', name, key]);

function serverHits(path: string, text: string, toml: Toml): AgentHit[] {
  const servers = Object.hasOwn(toml.doc, 'mcp_servers') ? toml.doc['mcp_servers'] : undefined;
  if (!isPlainObject(servers)) return [];
  const list = firstEntries(path, 'servers', Object.entries(servers));
  return [
    ...list.cut,
    ...list.items.flatMap(([name, entry]): AgentHit[] => {
      if (!isPlainObject(entry)) return [];
      const command = Object.hasOwn(entry, 'command') ? entry['command'] : undefined;
      const url = Object.hasOwn(entry, 'url') ? entry['url'] : undefined;
      const args = Array.isArray(entry['args'])
        ? entry['args'].filter((a): a is string => typeof a === 'string')
        : [];
      if (typeof command === 'string') {
        const line = serverLine(toml, text, entry, name, 'command');
        const value = `${[command, ...args].join(' ')}${serverFields(entry)}`;
        return [hit(serverKind(command, args, entry), path, line, name, value)];
      }
      if (command !== undefined)
        return [hit('unreadable-config', path, 1, `mcp_servers.${name}`, boundedJson(command))];
      if (typeof url === 'string') {
        const line = serverLine(toml, text, entry, name, 'url');
        return [hit('mcp-server', path, line, name, `${url}${serverFields(entry)}`)];
      }
      return [];
    }),
  ];
}

function hookHitsOf(path: string, text: string, doc: Obj): AgentHit[] {
  const hits: AgentHit[] = [];
  const notify = Object.hasOwn(doc, 'notify') ? doc['notify'] : undefined;
  const notifyText = Array.isArray(notify) ? notify.filter((n) => typeof n === 'string') : [];
  if (notifyText.length > 0)
    hits.push(hit('agent-hook', path, lineOf(text, ['notify']), 'notify', notifyText.join(' ')));
  const hooks = Object.hasOwn(doc, 'hooks') ? doc['hooks'] : undefined;
  const { entries, cut } = hookEntries(hooks);
  for (const e of entries.slice(0, MAX_HOOKS)) {
    const line = lineOf(text, [...e.path, firstWord(e.command)]);
    hits.push(hit('agent-hook', path, line, e.event, e.runs));
  }
  return cut ? [...hits, tooMany(path, 'hooks', MAX_HOOKS, hooks)] : hits;
}

/** Words that point at the line to show for a file this reader could not follow. */
const RUN_WORDS = /\b(?:command|notify|mcp_servers|hooks)\b/;

export function codexConfig(path: string, text: string): AgentHit[] {
  const toml = parseToml(text);
  const clean = withoutComments(text);
  if (toml === undefined) {
    // Fails whatever words it holds: the same keys can be spelled so that no word is there.
    const mention = RUN_WORDS.exec(clean);
    return [
      mention === null
        ? hit('unreadable-config', path, 1, 'stopped', digestOf(text))
        : hit('unreadable-config', path, lineOf(clean, [mention[0]]), 'unparsed', digestOf(text)),
    ];
  }
  return [...serverHits(path, clean, toml), ...hookHitsOf(path, clean, toml.doc)];
}
