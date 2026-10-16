import { entrypointOf } from '../mcp/entrypoint.js';
import { homedir } from 'node:os';
import { basename, dirname, posix, resolve } from 'node:path';
import { labelOf } from '../commands/vet-flow.js';
import { readConfigText, parseConfigJson, isPlainObject } from '../commands/config-file.js';
import {
  hasValidMcpServers,
  isMcpClient,
  mcpConfigPath,
  wrapperIndex,
} from '../commands/mcp-config.js';
import type { McpClient, McpConfigJson } from '../commands/mcp-config.js';
import { confirmationScreen } from '../commands/vet-render.js';
import { confirm, confirmTyped } from '../ui/prompt.js';
import { outsideLine } from '../ui/layout.js';
import { styleFor } from '../ui/style.js';
import type { Terminal } from '../ui/terminal.js';
import { assertWriteAllowed } from '../harden/atomic.js';
import { stroqVersion } from '../version.js';
import { inspectTree, INSPECT_RULES_ID, passportIsIncomplete } from './inspect/index.js';
import { readPassports, SKILL_NAME, withPassports, writePassports } from './lock.js';
import type { Passports, Receipt } from './lock.js';
import { readArchiveFile } from './archive-file.js';
import { commitMcpConfig } from './mcp-config-transaction.js';
import { assertSelfContained } from './mcp-outside-imports.js';
import { updateDiffLines } from './update-diff.js';
import { auditReceipt } from './receipt.js';
import { readDirTree } from './read-dir.js';
import { sourceTypeOf } from './read-source.js';
import { collectMcpStore } from './store-gc.js';
import {
  assertWritableTree,
  assertInstallablePlatform,
  putStore,
  readStoredTreeOf,
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
  /** Automatic targets retain their project/home boundary; explicit --config targets have none. */
  readonly configRoot?: string | null;
  readonly client: string;
  /** Optional for records written before the installer recorded the wrapper's context separately. */
  readonly cwd?: string;
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

interface McpTarget {
  readonly file: string;
  readonly label: string;
  readonly root: string | null;
}

function clientRoot(
  client: McpClient,
  options: Pick<McpInstallOptions, 'project' | 'user'>,
): string {
  if (client === 'claude-code' || (client === 'cursor' && options.user !== true))
    return resolve(options.project);
  // Windows may deliberately redirect the user's roaming application data outside their home.
  if (client === 'claude-desktop' && process.platform === 'win32')
    return resolve(process.env['APPDATA'] ?? homedir());
  return resolve(homedir());
}

function target(options: McpInstallOptions): McpTarget {
  if ((options.client === undefined) === (options.config === undefined))
    throw new Error('give exactly one of --client <name> or --config <path>');
  if (options.config !== undefined) {
    const file = resolve(options.config);
    return { file, label: posix.basename(file.replaceAll('\\', '/')), root: null };
  }
  const client = options.client!;
  if (!isMcpClient(client)) throw new Error('unknown MCP client');
  return {
    file: resolve(
      mcpConfigPath(client, options.user === true ? 'user' : 'project', options.project),
    ),
    label: client,
    root: clientRoot(client, options),
  };
}

function recordedTarget(record: McpRecord): McpTarget {
  const file = resolve(record.config);
  let root = record.configRoot;
  // Older records have only the selected client and its conventional config path.
  if (root === undefined) {
    root = null;
    if (record.client === 'claude-code' && basename(file) === '.mcp.json') root = dirname(file);
    else if (
      record.client === 'cursor' &&
      basename(file) === 'mcp.json' &&
      basename(dirname(file)) === '.cursor'
    )
      root = dirname(dirname(file));
    else if (record.client === 'windsurf' && basename(file) === 'mcp_config.json') {
      const parent = dirname(file);
      // Windsurf discovery can switch paths after installation; both layouts retain the same home.
      if (basename(parent) === '.codeium') root = dirname(parent);
      else if (basename(parent) === 'windsurf' && basename(dirname(parent)) === '.codeium')
        root = dirname(dirname(parent));
    } else if (isMcpClient(record.client) && file === resolve(mcpConfigPath(record.client, 'user')))
      root = clientRoot(record.client, { project: process.cwd(), user: true });
  }
  return { file, label: record.client, root };
}

function targetRules(target: McpTarget): { root?: string; initRule: false } {
  return { ...(target.root === null ? {} : { root: target.root }), initRule: false };
}

function recordedCwd(record: McpRecord): string {
  if (record.cwd !== undefined) return resolve(record.cwd);
  const args = record.written['args'];
  const at = Array.isArray(args) ? wrapperIndex(args) : null;
  if (Array.isArray(args) && at !== null) {
    const end = args.indexOf('--', at);
    const flag = args.indexOf('--cwd', at);
    if (flag !== -1 && flag + 1 < end && typeof args[flag + 1] === 'string')
      return resolve(args[flag + 1]);
  }
  throw new Error('the installed MCP wrapper has no recorded working directory');
}

function loadConfig(file: string): { config: McpConfigJson; text: string | null } {
  const text = readConfigText(file, { strict: true });
  const config: McpConfigJson =
    text === null || text.trim().length === 0 ? {} : parseConfigJson(file, text);
  if (!isPlainObject(config) || !hasValidMcpServers(config))
    throw new Error('mcpServers in the client config is not an object');
  return { config, text };
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

function currentEntry(config: McpConfigJson, name: string): unknown {
  const servers = serversOf(config);
  return Object.hasOwn(servers, name) ? servers[name] : undefined;
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
  cwd: string,
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
      cwd,
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
        tree: await readStoredTreeOf(options.stroqHome, named!.digest, {
          kind: 'mcp',
          name: sourceOrName,
          source: named!.source,
        }),
        passport: named!.passport,
      }
    : await inspectSource(source);
  assertSelfContained(made.tree);
  const name = nameOf(
    options.name ?? (named === undefined ? made.passport.artifact.name : sourceOrName),
  );
  const previous = recordOf(initial, name);
  const prior = initial.mcp?.[name];
  const history =
    isPlainObject(prior) && Array.isArray(prior['history']) ? (prior['history'] as Receipt[]) : [];
  const oldTree =
    previous === undefined
      ? undefined
      : await readStoredTreeOf(options.stroqHome, previous.digest, {
          kind: 'mcp',
          name,
          source: previous.source,
        });
  if (previous !== undefined && resolve(previous.source) !== source)
    throw new Error(`this path is not ${name}'s recorded source; remove it first`);
  const entrypoint = entrypointOf(made.tree, options.entrypoint ?? previous?.entrypoint);
  const passEnv = [...new Set(options.passEnv ?? previous?.passEnv ?? [])];
  if (passEnv.some((variable) => !ENV_NAME.test(variable)))
    throw new Error('--pass-env takes variable names: letters, digits and underscores');
  const selected =
    previous !== undefined && options.client === undefined && options.config === undefined
      ? recordedTarget(previous)
      : target(options);
  const { file, label, root } = selected;
  if (previous !== undefined && resolve(previous.config) !== file)
    throw new Error('the server is installed in another client config; remove it first');
  assertWriteAllowed(file, targetRules(selected));
  const { config } = loadConfig(file);
  const current = currentEntry(config, name);
  if (previous !== undefined && !jsonEqual(current, previous.written) && options.force !== true)
    throw new Error('the client config entry changed outside Stroq; use remove --force first');
  if (previous === undefined && Object.hasOwn(serversOf(config), name))
    throw new Error('the client config already has a server by this name; refusing to replace it');
  const digest = made.passport.artifact.digest;
  const original = previous === undefined ? null : previous.original;
  const cwd = resolve(
    options.cwd ?? (previous === undefined ? options.project : recordedCwd(previous)),
  );
  const written = entryFor(name, { digest, entrypoint, passEnv }, options, label, cwd, original);
  const material =
    options.restore === true ||
    previous === undefined ||
    previous.digest !== digest ||
    previous.entrypoint !== entrypoint ||
    !jsonEqual(previous.passEnv, passEnv) ||
    !jsonEqual(previous.written, written);
  // Before a word is written: an artifact whose sensitive lines do not all fit is not asked about.
  const screen = confirmationScreen(made.passport, source);
  options.terminal.write(
    `${previous === undefined ? 'Install' : 'Update'} MCP server ${name} in ${outsideLine(JSON.stringify(file))}\n`,
  );
  if (previous !== undefined) options.terminal.write(`Previous sha256:${previous.digest}\n`);
  if (oldTree !== undefined)
    for (const line of updateDiffLines(oldTree, made.tree)) options.terminal.write(`${line}\n`);
  options.terminal.write(
    `Starts node ${outsideLine(JSON.stringify(entrypoint))} from a verified private copy; environment passed: ${passEnv.length === 0 ? 'none' : passEnv.join(', ')}\n`,
  );
  options.terminal.write(
    'Self-contained: no dependency is listed and no import by name was found. That is a best-effort reading of the text, not a proof that nothing outside the tree is loaded; the pin is tamper-evident, not tamper-proof.\n',
  );
  options.terminal.write(screen);
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
    if (previous !== undefined)
      await readStoredTreeOf(options.stroqHome, previous.digest, {
        kind: 'mcp',
        name,
        source: previous.source,
      });
    await putStore(options.stroqHome, made.tree, digest);
    assertWriteAllowed(file, targetRules(selected));
    const fresh = loadConfig(file);
    if (!jsonEqual(currentEntry(fresh.config, name), current))
      throw new Error('the client config changed while confirming; read and confirm again');
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
      configRoot: root,
      client: label,
      cwd,
      entrypoint,
      passEnv,
      passport: made.passport,
      written,
      original,
      history: [...history, receipt],
    };
    const next = { ...lock, mcp: { ...(lock.mcp ?? {}), [name]: record } };
    await commitMcpConfig(
      file,
      withServer(fresh.config, name, written),
      () => writePassports(options.stroqHome, next),
      { ...targetRules(selected), before: fresh.text },
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
  // Removing needs the digest from the lock and the entry in the client config, never the stored bytes: a
  // damaged store must not make a server impossible to take out.
  const selected = recordedTarget(previous);
  const { file } = selected;
  assertWriteAllowed(file, targetRules(selected));
  const current = currentEntry(loadConfig(file).config, name);
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
    assertWriteAllowed(file, targetRules(selected));
    const fresh = loadConfig(file);
    if (!jsonEqual(currentEntry(fresh.config, name), current))
      throw new Error('the client config changed while confirming; read and confirm again');
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
    await commitMcpConfig(
      file,
      withServer(fresh.config, name, previous.original ?? undefined),
      () => writePassports(options.stroqHome, next),
      { ...targetRules(selected), before: fresh.text },
    );
    await auditReceipt(options.stroqHome, receipt, 'mcp');
    await collectMcpStore(options.stroqHome, next, previous.digest);
  });
}
