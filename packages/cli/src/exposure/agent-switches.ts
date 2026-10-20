import { isPlainObject } from '../commands/config-file.js';
import {
  allowRuleHits,
  firstEntries,
  hookHits,
  isHarmlessEnv,
  mcpServerHits,
  own,
  ownObject,
  ownString,
  quoted,
  ruleList,
  type JsonFile,
  type Obj,
} from './agent-json.js';
import { boundedJson, hit, secretHit, type AgentHit } from './agent-kinds.js';
import { lineOf } from './jsonc.js';

/**
 * The keys of Codex's and Gemini's project configs that do what Claude Code's `bypassPermissions`,
 * `ANTHROPIC_BASE_URL` and `env` do: run every command without asking or outside the sandbox,
 * send the model's traffic and its key to another address, send the prompts out as telemetry,
 * set variables for every command.
 */

/** The line of a key, by the path of keys to it. */
type Line = (keys: readonly string[]) => number;

/**
 * `approval_policy` and `sandbox_mode` in `table`, whatever they hold: `never` and
 * `danger-full-access` run every command without asking or outside the sandbox; any other value
 * is listed, and fails when a change sets it.
 */
function codexBypass(path: string, table: Obj, prefix: string, line: Line): AgentHit[] {
  const keys = prefix === '' ? [] : prefix.slice(0, -1).split('.');
  const found: AgentHit[] = [];
  for (const [key, open] of [
    ['approval_policy', 'never'],
    ['sandbox_mode', 'danger-full-access'],
  ] as const) {
    if (!Object.hasOwn(table, key)) continue;
    const value = table[key];
    const kind =
      typeof value === 'string' && value !== open ? 'agent-broad-allow' : 'agent-permission-bypass';
    const text = typeof value === 'string' ? value : boundedJson(value);
    found.push(hit(kind, path, line([...keys, key]), `${prefix}${key}`, text));
  }
  return found;
}

/** Codex's `config.toml`: the switches above, at the top and in each profile. */
/** Codex's tables that keep the agent from things, in `table`: listed, and any change fails. */
function codexProtections(path: string, table: Obj, prefix: string, line: Line): AgentHit[] {
  const keys = prefix === '' ? [] : prefix.slice(0, -1).split('.');
  return ['sandbox_workspace_write', 'shell_environment_policy']
    .filter((key) => Object.hasOwn(table, key))
    .map((key) =>
      hit(
        'agent-broad-allow',
        path,
        line([...keys, key]),
        `${prefix}${key}`,
        boundedJson(table[key], undefined, true),
      ),
    );
}

export function codexSwitches(path: string, doc: Obj, line: Line): AgentHit[] {
  const hits = [...codexBypass(path, doc, '', line), ...codexProtections(path, doc, '', line)];
  for (const key of ['openai_base_url', 'chatgpt_base_url']) {
    const url = ownString(doc, key);
    if (url !== undefined) hits.push(hit('agent-api-redirect', path, line([key]), key, url));
  }
  const providers = firstEntries(
    path,
    'model providers',
    Object.entries(ownObject(doc, 'model_providers') ?? {}),
  );
  hits.push(...providers.cut);
  for (const [name, provider] of providers.items) {
    const url = isPlainObject(provider) ? ownString(provider, 'base_url') : undefined;
    if (url === undefined || !isPlainObject(provider)) continue;
    const key = ownString(provider, 'env_key');
    const value = key === undefined ? url : `${url} (key from ${key})`;
    const where = ['model_providers', name, 'base_url'];
    hits.push(hit('agent-api-redirect', path, line(where), where.join('.'), value));
  }
  const exporters = firstEntries(
    path,
    'otel exporters',
    Object.entries(ownObject(doc, 'otel') ?? {}).filter(
      ([key, exporter]) => key.includes('exporter') && exporter !== 'none',
    ),
  );
  hits.push(...exporters.cut);
  for (const [key, exporter] of exporters.items)
    hits.push(
      hit('agent-api-redirect', path, line(['otel', key]), `otel.${key}`, boundedJson(exporter)),
    );
  const policy = ownObject(doc, 'shell_environment_policy');
  const set = policy === undefined ? undefined : ownObject(policy, 'set');
  const env = firstEntries(
    path,
    'env variables',
    Object.entries(set ?? {}).filter(([k]) => !isHarmlessEnv(k)),
  );
  hits.push(...env.cut);
  for (const [key, value] of env.items) {
    // Named `CODEX_ENV_PREFIX` and the key, which is how `envNameOf` reads it back.
    const where = ['shell_environment_policy', 'set', key];
    const text = typeof value === 'string' ? value : boundedJson(value);
    hits.push(secretHit('agent-env', path, line(where), where.join('.'), text));
  }
  const profiles = firstEntries(path, 'profiles', Object.entries(ownObject(doc, 'profiles') ?? {}));
  hits.push(...profiles.cut);
  for (const [name, profile] of profiles.items)
    if (isPlainObject(profile))
      hits.push(
        ...codexBypass(path, profile, `profiles.${name}.`, line),
        ...codexProtections(path, profile, `profiles.${name}.`, line),
      );
  return hits;
}

/** Gemini's (and Qwen Code's) settings, in the nested shape and the older flat one. */
export function geminiSwitches(f: JsonFile): AgentHit[] {
  const hits: AgentHit[] = [];
  const at = (keys: readonly string[]): number => lineOf(f.text, keys.map(quoted));
  const add = (kind: Parameters<typeof hit>[0], keys: readonly string[], value: string) =>
    hits.push(hit(kind, f.path, at(keys), keys.join('.'), value));
  const general = ownObject(f.value, 'general') ?? {};
  const tools = ownObject(f.value, 'tools') ?? {};
  // Every approval mode: `yolo` runs every tool without asking, `auto_edit` every edit, and a mode
  // this does not know may do either.
  const mode = own(general, 'defaultApprovalMode');
  if (mode !== undefined)
    add(
      typeof mode === 'string' && mode !== 'yolo' ? 'agent-broad-allow' : 'agent-permission-bypass',
      ['general', 'defaultApprovalMode'],
      typeof mode === 'string' ? mode : boundedJson(mode),
    );
  if (own(tools, 'autoAccept') === true)
    add('agent-permission-bypass', ['tools', 'autoAccept'], 'true');
  if (own(f.value, 'autoAccept') === true) add('agent-permission-bypass', ['autoAccept'], 'true');
  for (const keys of [['tools', 'allowed'], ['allowedTools']] as const) {
    const table = keys.length === 2 ? tools : f.value;
    const rules = ruleList(own(table, keys[keys.length - 1] as string));
    hits.push(...allowRuleHits(f, rules, keys.join('.'), () => at(keys)));
  }
  for (const [table, keys] of [
    [tools, ['tools', 'discoveryCommand']],
    [tools, ['tools', 'callCommand']],
    [f.value, ['toolDiscoveryCommand']],
    [f.value, ['toolCallCommand']],
  ] as const) {
    const command = ownString(table, keys[keys.length - 1] as string);
    if (command !== undefined) add('agent-helper-command', keys, command);
  }
  // What keeps the agent from tools or runs it in a sandbox: listed, and any change fails.
  for (const [table, keys] of [
    [tools, ['tools', 'exclude']],
    [f.value, ['excludeTools']],
    [tools, ['tools', 'sandbox']],
    [f.value, ['sandbox']],
  ] as const) {
    const key = keys[keys.length - 1] as string;
    if (Object.hasOwn(table, key))
      add('agent-broad-allow', keys, boundedJson(table[key], undefined, true));
  }
  const trust = ownObject(ownObject(f.value, 'security') ?? {}, 'folderTrust');
  if (trust !== undefined && own(trust, 'enabled') === false)
    add('agent-permission-bypass', ['security', 'folderTrust', 'enabled'], 'false');
  const endpoint = ownString(ownObject(f.value, 'telemetry') ?? {}, 'otlpEndpoint');
  if (endpoint !== undefined) add('agent-api-redirect', ['telemetry', 'otlpEndpoint'], endpoint);
  const servers = firstEntries(
    f.path,
    'servers',
    Object.entries(ownObject(f.value, 'mcpServers') ?? {}),
  );
  for (const [name, entry] of servers.items)
    if (isPlainObject(entry) && own(entry, 'trust') === true)
      add('mcp-auto-approve', ['mcpServers', name, 'trust'], name);
  return hits;
}

/** Gemini's (and Qwen Code's) settings: servers, hooks and the switches above. */
export const geminiSettings = (f: JsonFile): AgentHit[] => [
  ...mcpServerHits(f, f.value, 'mcpServers'),
  ...hookHits(f, own(f.value, 'hooks'), ['"hooks"']),
  ...geminiSwitches(f),
];
