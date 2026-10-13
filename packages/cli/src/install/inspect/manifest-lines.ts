// The manifests of a plugin and of an MCP server: how its servers are started, what they are given,
// and the hooks it declares.
//
// `.mcp.json` lists servers: a command and its arguments for one the host starts, or an address for one
// it reaches. The `env` of a server names the variables it is given, and `${NAME}` in any of its
// strings is a variable the host fills in, so both are `cred.env` lines. `hooks/hooks.json` and the
// manifest of a plugin declare hooks. All of it is `declared`: the artifact says so about itself.
import type { Findings } from './findings.js';
import { addHookLines, withHostVariables } from './hook-lines.js';
import type { InspectInput } from './input.js';
import {
  entriesOf,
  isObject,
  own,
  ownObject,
  ownString,
  parseJsonObject,
  type JsonObject,
} from './json.js';
import { addressOf } from './addresses.js';
import { looksLikeCredential } from './credential-names.js';
import type { ShellQueue } from './shell-queue.js';
import type { TextFile } from './text-files.js';

const MAX_SERVERS = 100;
const MAX_ARGS = 50;
const SERVER_DETECTOR =
  'a server in a manifest: how the host starts it, as the artifact declares it';
const ADDRESS_DETECTOR = 'the address of a server in a manifest, as the artifact declares it';
const ENV_DETECTOR =
  'a variable a server in a manifest is given or that its configuration expands, as the artifact declares it';
const UNREADABLE_DETECTOR =
  'the file could not be parsed as a manifest, so what it declares is not known; a signal to look at, not a verdict';
/** `${NAME}` and `${NAME:-default}`, the way a host expands a variable in a configuration. */
const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]{0,99})(?::-[^}]{0,200})?\}/g;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The line of a key in a file, by the first place it is written; 1 when it cannot be found. */
function lineOfKey(file: TextFile, key: string): number {
  const at = file.text.indexOf(JSON.stringify(key));
  return at === -1 ? 1 : file.lines.lineAt(at);
}

/** An argument as a shell would be given it, quoted when it has a blank or a quote in it. */
const quoted = (arg: string): string =>
  /[\s"'\\]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;

/** The strings of a server's configuration, which a host may expand variables in. */
function stringsOf(server: JsonObject): string[] {
  const out: string[] = [];
  for (const key of ['command', 'url']) {
    const value = ownString(server, key);
    if (value !== null) out.push(value);
  }
  const args = own(server, 'args');
  if (Array.isArray(args)) out.push(...args.filter((a): a is string => typeof a === 'string'));
  for (const key of ['env', 'headers']) {
    const group = ownObject(server, key);
    if (group !== null) {
      for (const [, value] of entriesOf(group)) if (typeof value === 'string') out.push(value);
    }
  }
  return out.slice(0, 4 * MAX_ARGS);
}

function envLine(file: TextFile, name: string, line: number, findings: Findings): void {
  findings.line({
    kind: 'cred.env',
    subject: name,
    basis: 'declared',
    sensitive: looksLikeCredential(name),
    file: file.path,
    line,
    detector: ENV_DETECTOR,
  });
}

function serverLines(
  file: TextFile,
  name: string,
  server: JsonObject,
  findings: Findings,
  shell: ShellQueue,
): void {
  const line = lineOfKey(file, name);
  const command = ownString(server, 'command');
  if (command !== null) {
    const args = own(server, 'args');
    const parts = Array.isArray(args)
      ? args.filter((a): a is string => typeof a === 'string').slice(0, MAX_ARGS)
      : [];
    findings.line({
      kind: 'exec',
      subject: [command, ...parts].join(' '),
      basis: 'declared',
      sensitive: true,
      file: file.path,
      line,
      detector: SERVER_DETECTOR,
    });
    shell.add({
      file: file.path,
      line,
      text: withHostVariables([command, ...parts.map(quoted)].join(' ')),
      origin: 'launch',
    });
  }
  const address = ownString(server, 'url');
  const parsed = address === null ? null : addressOf(address);
  if (parsed?.host != null) {
    findings.line({
      kind: 'net',
      subject: parsed.host,
      basis: 'declared',
      sensitive: true,
      file: file.path,
      line,
      detector: ADDRESS_DETECTOR,
    });
  }
  const env = ownObject(server, 'env');
  if (env !== null) for (const [key] of entriesOf(env)) envLine(file, key, line, findings);
  for (const text of stringsOf(server)) {
    for (const match of text.matchAll(EXPANSION)) {
      if (match[1] !== undefined) envLine(file, match[1], line, findings);
    }
  }
}

/** Servers written under `mcpServers`, or at the top of the file when every entry of it looks like one. */
export function serversIn(manifest: JsonObject): JsonObject | null {
  const wrapped = ownObject(manifest, 'mcpServers');
  if (wrapped !== null) return wrapped;
  const entries = entriesOf(manifest);
  const looksLikeServers =
    entries.length > 0 &&
    entries.every(
      ([, value]) =>
        isObject(value) && (own(value, 'command') !== undefined || own(value, 'url') !== undefined),
    );
  return looksLikeServers ? manifest : null;
}

function addServers(
  file: TextFile,
  servers: JsonObject,
  findings: Findings,
  shell: ShellQueue,
): void {
  const named = entriesOf(servers);
  if (named.length > MAX_SERVERS) findings.tally('list-cut');
  for (const [name, server] of named.slice(0, MAX_SERVERS)) {
    if (isObject(server)) serverLines(file, name, server, findings, shell);
  }
}

function unreadable(file: TextFile, findings: Findings): void {
  findings.tally('unreadable-manifest');
  findings.signal({
    ruleId: 'manifest-unreadable',
    file: file.path,
    line: 1,
    sensitive: false,
    detail: basename(file.path),
    detector: UNREADABLE_DETECTOR,
  });
}

export function inspectManifests(input: InspectInput, findings: Findings, shell: ShellQueue): void {
  for (const file of input.texts) {
    const name = basename(file.path);
    const isMcp = name === '.mcp.json';
    const isHooks = name === 'hooks.json';
    const isPlugin = file.path === '.claude-plugin/plugin.json';
    if (!isMcp && !isHooks && !isPlugin) continue;
    const manifest = parseJsonObject(file.text);
    if (manifest === null) {
      unreadable(file, findings);
      continue;
    }
    if (isMcp) {
      const servers = serversIn(manifest);
      if (servers !== null) addServers(file, servers, findings, shell);
    }
    if (isPlugin) {
      const servers = ownObject(manifest, 'mcpServers');
      if (servers !== null) addServers(file, servers, findings, shell);
    }
    if (isHooks || isPlugin) {
      const hooks = own(manifest, 'hooks');
      if (isObject(hooks)) {
        addHookLines(file.path, hooks, lineOfKey(file, 'hooks'), 'a manifest', findings, shell);
      } else if (isHooks && hooks === undefined) {
        addHookLines(file.path, manifest, 1, 'a manifest', findings, shell);
      }
    }
  }
}
