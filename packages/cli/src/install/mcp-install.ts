import { entrypointOf } from '../mcp/entrypoint.js';
import { posix, resolve } from 'node:path';
import { labelOf } from '../commands/vet-flow.js';
import { readJsonObject, isPlainObject } from '../commands/config-file.js';
import { hasValidMcpServers, isMcpClient, mcpConfigPath } from '../commands/mcp-config.js';
import type { McpConfigJson } from '../commands/mcp-config.js';
import { renderPassport } from '../commands/vet-render.js';
import { confirm, confirmTyped } from '../ui/prompt.js';
import { outsideLine } from '../ui/layout.js';
import { styleFor } from '../ui/style.js';
import type { Terminal } from '../ui/terminal.js';
import { stroqVersion } from '../version.js';
import { inspectTree, INSPECT_RULES_ID, passportIsIncomplete } from './inspect/index.js';
import { readPassports, SKILL_NAME, withPassports, writePassports } from './lock.js';
import type { Passports, Receipt } from './lock.js';
import { readArchiveFile } from './archive-file.js';
import { commitMcpConfig } from './mcp-config-transaction.js';
import { auditReceipt } from './receipt.js';
import { readDirTree } from './read-dir.js';
import { sourceTypeOf } from './read-source.js';
import { collectMcpStore } from './store-gc.js';
import {
  assertWritableTree,
  assertInstallablePlatform,
  putStore,
  readStoredTree,
  storePath,
} from './store.js';
import type { Passport, Tree } from './types.js';

export interface McpInstallOptions {
  readonly project: string;
  readonly stroqHome: string;
  readonly terminal: Terminal;
  /** The node binary, as `init --agent mcp` writes it. */
  readonly node: string;
  /** The arguments between the node binary and `mcp`: the Stroq entry, with `--import tsx` in development. */
  readonly entryArgv: readonly string[];
  readonly client?: string;
  readonly config?: string;
  readonly entrypoint?: string;
  readonly passEnv?: readonly string[];
  readonly name?: string;
  readonly cwd?: string;
  readonly force?: boolean;
  readonly user?: boolean;
  readonly restore?: boolean;
}

/** What `add --kind mcp` records beside the pin; the proxy reads only kind, status, digest and grant. */
export interface McpRecord {
  readonly kind: 'mcp';
  readonly status: 'confirmed';
  readonly digest: string;
  readonly grant: { readonly pin: string };
  readonly source: string;
  readonly config: string;
  readonly client: string;
  readonly entrypoint: string;
  readonly passEnv: readonly string[];
  readonly passport: Passport;
  /** The entry as Stroq wrote it, to tell a later outside edit from its own work. */
  readonly written: Record<string, unknown>;
  /** The entry that stood under this name before Stroq took it, or null when there was none. */
  readonly original: Record<string, unknown> | null;
  readonly history: readonly Receipt[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requirePerson(options: McpInstallOptions): void {
  if (!options.terminal.interactive)
    throw new Error(
      'add and remove need a person at a terminal; use stroq vet --from <path> to read without installing',
    );
}

function nameOf(name: string): string {
  if (!SKILL_NAME.test(name))
    throw new Error(
      'a server name must be 1-64 lower-case letters, digits, underscores or hyphens',
    );
  return name;
}

function target(options: McpInstallOptions): { file: string; label: string } {
  if ((options.client === undefined) === (options.config === undefined))
    throw new Error('give exactly one of --client <name> or --config <path>');
  if (options.config !== undefined) {
    const file = resolve(options.config);
    return { file, label: posix.basename(file.replaceAll('\\', '/')) };
  }
  const client = options.client!;
  if (!isMcpClient(client)) throw new Error('unknown MCP client');
  return {
    file: mcpConfigPath(client, options.user === true ? 'user' : 'project', options.project),
    label: client,
  };
}

function loadConfig(file: string): McpConfigJson {
  const config = readJsonObject<McpConfigJson>(file);
  if (!hasValidMcpServers(config))
    throw new Error('mcpServers in the client config is not an object');
  return config;
}

function serversOf(config: McpConfigJson): Record<string, unknown> {
  return isPlainObject(config.mcpServers) ? config.mcpServers : {};
}

function withServer(
  config: McpConfigJson,
  name: string,
  entry: Record<string, unknown> | undefined,
): McpConfigJson {
  const servers = { ...serversOf(config) };
  if (entry === undefined) delete servers[name];
  else servers[name] = entry;
  return { ...config, mcpServers: servers };
}

function plainEntry(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export { entrypointOf } from '../mcp/entrypoint.js';

function entryFor(
  name: string,
  record: Pick<McpRecord, 'digest' | 'entrypoint' | 'passEnv'>,
  options: McpInstallOptions,
  label: string,
  original: Record<string, unknown> | null,
): Record<string, unknown> {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return {
    ...(original ?? {}),
    command: options.node,
    args: [
      ...options.entryArgv,
      'mcp',
      '--server',
      name,
      '--client',
      label,
      '--pin',
      `sha256:${record.digest}`,
      '--cwd',
      resolve(options.cwd ?? options.project),
      '--pass-env',
      record.passEnv.join(','),
      '--',
      'node',
      `${storePath(options.stroqHome, record.digest)}${sep}tree${sep}${record.entrypoint}`,
    ],
  };
}

async function inspectSource(source: string): Promise<{ tree: Tree; passport: Passport }> {
  const type = await sourceTypeOf(source);
  const { tree, blindSpots } =
    type === 'dir'
      ? await readDirTree(source, { rejectNestedRepositories: true })
      : await readArchiveFile(source);
  const passport = inspectTree(tree, {
    kind: 'mcp',
    source: { type, label: labelOf(source, type) },
    extraBlindSpots: blindSpots,
    stroqVersion: stroqVersion(),
    rulesId: INSPECT_RULES_ID,
  });
  if (passportIsIncomplete(passport))
    throw new Error('the passport is incomplete; refusing to install');
  assertWritableTree(tree, passport.artifact.digest);
  assertInstallablePlatform(tree, process.platform);
  return { tree, passport };
}

function recordOf(lock: Passports, name: string): McpRecord | undefined {
  const raw = Object.hasOwn(lock.mcp ?? {}, name) ? lock.mcp![name] : undefined;
  return isPlainObject(raw) &&
    raw['kind'] === 'mcp' &&
    raw['status'] === 'confirmed' &&
    isPlainObject(raw['written'])
    ? (raw as unknown as McpRecord)
    : undefined;
}

export async function addMcp(sourceOrName: string, options: McpInstallOptions): Promise<McpRecord> {
  requirePerson(options);
  const initial = await readPassports(options.stroqHome);
  const named = recordOf(initial, sourceOrName);
  if (options.restore && named === undefined)
    throw new Error('--restore needs the name of an installed MCP server');
  const source = named?.source ?? resolve(sourceOrName);
  const made = options.restore
    ? {
        tree: await readStoredTree(storePath(options.stroqHome, named!.digest), named!.digest),
        passport: named!.passport,
      }
    : await inspectSource(source);
  const name = nameOf(
    options.name ?? (named === undefined ? made.passport.artifact.name : sourceOrName),
  );
  const previous = recordOf(initial, name);
  const prior = initial.mcp?.[name];
  const history =
    isPlainObject(prior) && Array.isArray(prior['history']) ? (prior['history'] as Receipt[]) : [];
  if (previous !== undefined)
    await readStoredTree(storePath(options.stroqHome, previous.digest), previous.digest);
  if (previous !== undefined && resolve(previous.source) !== source)
    throw new Error(`this path is not ${name}'s recorded source; remove it first`);
  const entrypoint = entrypointOf(made.tree, options.entrypoint ?? previous?.entrypoint);
  const passEnv = [...new Set(options.passEnv ?? previous?.passEnv ?? [])];
  if (passEnv.some((variable) => !ENV_NAME.test(variable)))
    throw new Error('--pass-env takes variable names: letters, digits and underscores');
  const { file, label } = target(
    previous !== undefined && options.client === undefined && options.config === undefined
      ? { ...options, config: previous.config }
      : options,
  );
  if (previous !== undefined && resolve(previous.config) !== file)
    throw new Error('the server is installed in another client config; remove it first');
  const config = loadConfig(file);
  const current = plainEntry(serversOf(config)[name]);
  if (previous !== undefined && !jsonEqual(current, previous.written) && options.force !== true)
    throw new Error('the client config entry changed outside Stroq; use remove --force first');
  if (previous === undefined && current !== null)
    throw new Error('the client config already has a server by this name; refusing to replace it');
  const digest = made.passport.artifact.digest;
  const original = previous === undefined ? current : previous.original;
  const written = entryFor(name, { digest, entrypoint, passEnv }, options, label, original);
  const material =
    options.restore === true ||
    previous === undefined ||
    previous.digest !== digest ||
    previous.entrypoint !== entrypoint ||
    !jsonEqual(previous.passEnv, passEnv) ||
    !jsonEqual(previous.written, written);
  options.terminal.write(
    `${previous === undefined ? 'Install' : 'Update'} MCP server ${name} in ${outsideLine(JSON.stringify(file))}\n`,
  );
  if (previous !== undefined) options.terminal.write(`Previous sha256:${previous.digest}\n`);
  options.terminal.write(
    `Starts node ${outsideLine(JSON.stringify(entrypoint))} from a verified private copy; environment passed: ${passEnv.length === 0 ? 'none' : passEnv.join(', ')}\n`,
  );
  options.terminal.write(renderPassport(made.passport));
  options.terminal.write(`Client entry: ${outsideLine(JSON.stringify(written))}\n`);
  const yes = material
    ? await confirmTyped(options.terminal, digest)
    : await confirm(
        options.terminal,
        styleFor(options.terminal),
        'Nothing changed; re-apply?',
        false,
      );
  if (!yes) throw new Error('not confirmed; nothing was changed');
  return withPassports(options.stroqHome, async (lock) => {
    if (!jsonEqual(lock.mcp?.[name], initial.mcp?.[name]))
      throw new Error('the lock changed while confirming; read and confirm again');
    const fresh = loadConfig(file);
    if (!jsonEqual(plainEntry(serversOf(fresh)[name]), current))
      throw new Error('the client config changed while confirming; read and confirm again');
    if (previous !== undefined)
      await readStoredTree(storePath(options.stroqHome, previous.digest), previous.digest);
    await putStore(options.stroqHome, made.tree, digest);
    const receipt: Receipt = {
      v: 1,
      at: new Date().toISOString(),
      name,
      action: options.restore ? 'restore' : previous === undefined ? 'add' : 'update',
      from: previous?.digest ?? null,
      to: digest,
      material,
      confirmed: true,
      stroq: stroqVersion(),
    };
    const record: McpRecord = {
      kind: 'mcp',
      status: 'confirmed',
      digest,
      grant: { pin: `sha256:${digest}` },
      source,
      config: file,
      client: label,
      entrypoint,
      passEnv,
      passport: made.passport,
      written,
      original,
      history: [...history, receipt],
    };
    const next = { ...lock, mcp: { ...(lock.mcp ?? {}), [name]: record } };
    await commitMcpConfig(file, withServer(fresh, name, written), () =>
      writePassports(options.stroqHome, next),
    );
    await auditReceipt(options.stroqHome, receipt, 'mcp');
    if (previous !== undefined) await collectMcpStore(options.stroqHome, next, previous.digest);
    return record;
  });
}

export async function removeMcp(name: string, options: McpInstallOptions): Promise<void> {
  requirePerson(options);
  nameOf(name);
  const initial = await readPassports(options.stroqHome);
  const previous = recordOf(initial, name);
  if (previous === undefined) throw new Error('the MCP server is not installed');
  await readStoredTree(storePath(options.stroqHome, previous.digest), previous.digest);
  const file = resolve(previous.config);
  const current = plainEntry(serversOf(loadConfig(file))[name]);
  const drifted = !jsonEqual(current, previous.written);
  if (drifted && options.force !== true)
    throw new Error(
      'the client config entry changed outside Stroq; it was kept (use --force to remove it)',
    );
  options.terminal.write(
    `Remove MCP server ${name} from ${outsideLine(JSON.stringify(file))}\nPrevious sha256:${previous.digest}\n${previous.original === null ? 'The entry is deleted.' : 'The original entry is restored.'}\n`,
  );
  const yes = await confirm(
    options.terminal,
    styleFor(options.terminal),
    `Remove ${name}${drifted ? ' including outside edits' : ''}?`,
    false,
  );
  if (!yes) throw new Error('removal not confirmed');
  await withPassports(options.stroqHome, async (lock) => {
    if (!jsonEqual(lock.mcp?.[name], initial.mcp?.[name]))
      throw new Error('the lock changed while confirming; read and confirm again');
    const fresh = loadConfig(file);
    if (!jsonEqual(plainEntry(serversOf(fresh)[name]), current))
      throw new Error('the client config changed while confirming; read and confirm again');
    await readStoredTree(storePath(options.stroqHome, previous.digest), previous.digest);
    const receipt: Receipt = {
      v: 1,
      at: new Date().toISOString(),
      name,
      action: 'remove',
      from: previous.digest,
      to: null,
      material: false,
      confirmed: true,
      stroq: stroqVersion(),
    };
    const rest = {
      ...(lock.mcp ?? {}),
      [name]: { kind: 'mcp', status: 'revoked', history: [...previous.history, receipt] },
    };
    const next = { ...lock, mcp: rest };
    await commitMcpConfig(file, withServer(fresh, name, previous.original ?? undefined), () =>
      writePassports(options.stroqHome, next),
    );
    await auditReceipt(options.stroqHome, receipt, 'mcp');
    await collectMcpStore(options.stroqHome, next, previous.digest);
  });
}
