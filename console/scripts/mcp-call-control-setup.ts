import { opendir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { callControlProxy } from './mcp-call-control-proxy.ts';
import { parseMcpArgv } from '../../packages/cli/src/commands/mcp.ts';
import {
  isObject,
  parseJsonDocument,
  removeAt,
  deepEqual,
} from '../../packages/cli/src/harden/json-doc.ts';
import {
  validateMcpContainmentArtifact,
  type McpContainmentArtifact,
} from '../lib/mcp-containment.ts';
import {
  discoverMcpSources,
  readMcpSource,
  mcpEntryMetadata,
  type McpSource,
} from './mcp-sources.ts';
import {
  binding,
  hash,
  inspect,
  readPrivate,
  writeExclusive,
  writeManifest,
  ensureMarker,
  deadline,
  MAX_CONFIG,
} from './mcp-containment-files.mjs';
import type { Context } from './mcp-containment-vault.ts';
export const SETUP_MAX_BYTES = 17 * 1024 * 1024,
  SETUP_MAX_RECORDS = 32;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  SHA = /^[a-f0-9]{64}$/;
const vault = (ctx: Context) => join(ctx.user.path, '.stroq', 'console', 'mcp-call-control-setup');
const fail = (): never => {
  throw new Error('mcp-call-control-unavailable');
};
export type SetupData = {
  operationId: string;
  controlId: string;
  invocationSha256: string;
  contextId: string;
  proxyWorkspaceId: string;
  createdAt: string;
  artifact: McpContainmentArtifact;
  name: string;
  sourceType: McpSource['source'];
  relativePath: string;
  sourceRootBinding: string;
  userBinding: string;
  configSha256: string;
  mode: number;
  candidateSha256: string;
  before: Uint8Array;
  candidate: Uint8Array;
};
type Manifest = Omit<SetupData, 'before' | 'candidate'> & {
  schema: 'stroq-mcp-call-control-setup/1';
  phase:
    'prepared' | 'authority-recorded' | 'configuration-confirmed' | 'configuration-unconfirmed';
  eventId: string | null;
  revision: string | null;
  beforeBytes: number;
  candidateBytes: number;
  vaultBinding: string;
};
export type StoredSetup = {
  manifest: Manifest;
  manifestSha: string;
  directory: string;
  before: Uint8Array;
  candidate: Uint8Array;
};
const keys = [
  'operationId',
  'controlId',
  'invocationSha256',
  'contextId',
  'proxyWorkspaceId',
  'createdAt',
  'artifact',
  'name',
  'sourceType',
  'relativePath',
  'sourceRootBinding',
  'userBinding',
  'configSha256',
  'mode',
  'candidateSha256',
  'schema',
  'phase',
  'eventId',
  'revision',
  'beforeBytes',
  'candidateBytes',
  'vaultBinding',
];
function valid(m: unknown, ctx: Context, id: string, vaultBinding: string): m is Manifest {
  if (
    !isObject(m) ||
    Object.keys(m).sort().join() !== [...keys].sort().join() ||
    m.schema !== 'stroq-mcp-call-control-setup/1' ||
    m.operationId !== id ||
    !UUID.test(id) ||
    typeof m.controlId !== 'string' ||
    !UUID.test(m.controlId) ||
    !validateMcpContainmentArtifact(m.artifact)
  )
    return false;
  if (
    [
      'invocationSha256',
      'sourceRootBinding',
      'userBinding',
      'configSha256',
      'candidateSha256',
      'vaultBinding',
    ].some((k) => typeof m[k] !== 'string' || !SHA.test(m[k] as string)) ||
    m.userBinding !== binding(ctx.user) ||
    m.vaultBinding !== vaultBinding ||
    typeof m.contextId !== 'string' ||
    !/^context-[a-f0-9]{64}$/.test(m.contextId) ||
    typeof m.proxyWorkspaceId !== 'string' ||
    !/^workspace-[a-f0-9]{24}$/.test(m.proxyWorkspaceId)
  )
    return false;
  if (
    typeof m.name !== 'string' ||
    !m.name ||
    m.name.length > 512 ||
    typeof m.relativePath !== 'string' ||
    !m.relativePath ||
    m.relativePath.length > 512 ||
    m.relativePath.split(/[\\/]/).some((p) => p === '..') ||
    m.relativePath.startsWith('/') ||
    ![
      'claude-desktop-manual',
      'cursor-project',
      'cursor-user',
      'claude-code-project',
      'devin-cascade-current',
      'windsurf-legacy-ide',
      'windsurf-legacy',
    ].includes(m.sourceType as string)
  )
    return false;
  return (
    typeof m.createdAt === 'string' &&
    new Date(m.createdAt).toISOString() === m.createdAt &&
    Number.isInteger(m.mode) &&
    (m.mode as number) >= 0 &&
    (m.mode as number) <= 0o777 &&
    ['beforeBytes', 'candidateBytes'].every(
      (k) => Number.isInteger(m[k]) && (m[k] as number) > 0 && (m[k] as number) <= MAX_CONFIG,
    ) &&
    [
      'prepared',
      'authority-recorded',
      'configuration-confirmed',
      'configuration-unconfirmed',
    ].includes(m.phase as string) &&
    (m.eventId === null || (typeof m.eventId === 'string' && UUID.test(m.eventId))) &&
    (m.revision === null || (typeof m.revision === 'string' && SHA.test(m.revision))) &&
    (m.eventId === null) === (m.revision === null)
  );
}
function payloads(ctx: Context, m: Manifest, before: Uint8Array, candidate: Uint8Array) {
  if (
    hash(before) !== m.configSha256 ||
    hash(candidate) !== m.candidateSha256 ||
    before.length !== m.beforeBytes ||
    candidate.length !== m.candidateBytes
  )
    return fail();
  const decode = (b: Uint8Array) =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b),
    a = parseJsonDocument(decode(before)),
    b = parseJsonDocument(decode(candidate));
  if (
    !a.ok ||
    !b.ok ||
    !isObject(a.doc.mcpServers) ||
    !isObject(b.doc.mcpServers) ||
    !Object.hasOwn(a.doc.mcpServers, m.name) ||
    !Object.hasOwn(b.doc.mcpServers, m.name) ||
    mcpEntryMetadata(a.doc.mcpServers[m.name]).sha256 !== m.artifact.sha256 ||
    !deepEqual(removeAt(a.doc, ['mcpServers', m.name]), removeAt(b.doc, ['mcpServers', m.name]))
  )
    return fail();
  const next = b.doc.mcpServers[m.name],
    original = a.doc.mcpServers[m.name];
  if (
    !isObject(next) ||
    typeof next.command !== 'string' ||
    !Array.isArray(next.args) ||
    !next.args.every((x) => typeof x === 'string') ||
    !isObject(next.env) ||
    typeof next.env.STROQ_HOME !== 'string' ||
    next.env.HOME !== ctx.user.path ||
    next.env.USERPROFILE !== ctx.user.path ||
    m.contextId !== `context-${hash(JSON.stringify([next.env.STROQ_HOME, ctx.user.path]))}`
  )
    return fail();
  const parsed = parseMcpArgv(next.args.slice(2));
  if (
    !parsed.ok ||
    parsed.invocation.callControlId !== m.controlId ||
    parsed.invocation.server !== m.name ||
    parsed.invocation.client !== m.artifact.agent ||
    !parsed.invocation.cwd
  )
    return fail();
  const rebuilt = callControlProxy(
    original,
    m.name,
    m.artifact.agent,
    {
      command: next.command,
      entry: String(next.args[0]),
      home: next.env.STROQ_HOME,
      userHome: ctx.user.path,
      fingerprint: '0'.repeat(64),
    },
    parsed.invocation.cwd,
    m.controlId,
  );
  if (rebuilt.configuration === 'controlled' || !deepEqual(rebuilt.entry, next)) return fail();
}
async function quota(ctx: Context, reserve: number, newRecord = false) {
  const root = await inspect(ctx.user, vault(ctx), 'directory', true);
  if (!root) return;
  let bytes = 0,
    count = 0,
    stages = 0;
  const dirs = await opendir(vault(ctx));
  for await (const ent of dirs) {
    deadline(ctx.deadline);
    const path = join(vault(ctx), ent.name);
    if (ent.name === '.gitignore') {
      const file = await readPrivate(ctx.user, path, 3);
      if (!file || Buffer.from(file.bytes).toString() !== '*\n') return fail();
      bytes += file.bytes.length;
      continue;
    }
    if (
      !UUID.test(ent.name) ||
      !ent.isDirectory() ||
      ++count > SETUP_MAX_RECORDS ||
      !(await inspect(ctx.user, path, 'directory', true))
    )
      return fail();
    let manifest = false;
    for await (const file of await opendir(path)) {
      deadline(ctx.deadline);
      if (
        !['manifest.json', 'before.json', 'candidate.json'].includes(file.name) &&
        !/^\.manifest-[a-f0-9-]+\.tmp$/.test(file.name)
      )
        return fail();
      if (file.name === 'manifest.json') manifest = true;
      else if (file.name.startsWith('.manifest-') && ++stages > 32) return fail();
      const read = await readPrivate(
        ctx.user,
        join(path, file.name),
        file.name === 'manifest.json' || file.name.startsWith('.manifest-') ? 16384 : MAX_CONFIG,
      );
      if (!read) return fail();
      bytes += read.bytes.length;
      if (bytes + reserve > SETUP_MAX_BYTES) throw new Error('mcp-call-control-limit');
    }
    if (!manifest || !(await readSetupRecord(ctx, ent.name))) return fail();
  }
  if (count >= SETUP_MAX_RECORDS && newRecord) throw new Error('mcp-call-control-limit');
  if (bytes + reserve > SETUP_MAX_BYTES) throw new Error('mcp-call-control-limit');
}
async function readSetupRecord(ctx: Context, id: string): Promise<StoredSetup | null> {
  if (!UUID.test(id)) return fail();
  const root = await inspect(ctx.user, vault(ctx), 'directory', true);
  if (!root) return null;
  const directory = join(vault(ctx), id),
    dir = await inspect(ctx.user, directory, 'directory', true);
  if (!dir) return null;
  const read = await readPrivate(ctx.user, join(directory, 'manifest.json'), 16384);
  if (!read) return fail();
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
  } catch {
    return fail();
  }
  if (!valid(manifest, ctx, id, binding({ path: vault(ctx), ino: root.ino, dev: root.dev })))
    return fail();
  const before = await readPrivate(ctx.user, join(directory, 'before.json'), MAX_CONFIG),
    candidate = await readPrivate(ctx.user, join(directory, 'candidate.json'), MAX_CONFIG);
  if (!before || !candidate) return fail();
  payloads(ctx, manifest, before.bytes, candidate.bytes);
  return {
    manifest,
    manifestSha: read.sha256,
    directory,
    before: before.bytes,
    candidate: candidate.bytes,
  };
}
export async function readSetup(ctx: Context, id: string): Promise<StoredSetup | null> {
  await quota(ctx, 0);
  return readSetupRecord(ctx, id);
}
export async function reserveSetup(ctx: Context, data: SetupData): Promise<StoredSetup> {
  if (
    !UUID.test(data.operationId) ||
    data.before.length > MAX_CONFIG ||
    data.candidate.length > MAX_CONFIG
  )
    throw new Error('mcp-call-control-invalid');
  // Reserve payloads plus two full manifests: intent replacement can leave one opaque stage.
  await quota(ctx, data.before.length + data.candidate.length + 32768, true);
  await ensureMarker(ctx.user, vault(ctx));
  const root = await inspect(ctx.user, vault(ctx), 'directory', true);
  if (!root) return fail();
  const directory = join(vault(ctx), data.operationId);
  await mkdir(directory, { mode: 0o700 });
  const { before, candidate, ...rest } = data;
  const manifest: Manifest = {
    ...rest,
    schema: 'stroq-mcp-call-control-setup/1',
    phase: 'prepared',
    eventId: null,
    revision: null,
    beforeBytes: before.length,
    candidateBytes: candidate.length,
    vaultBinding: binding({ path: vault(ctx), ino: root.ino, dev: root.dev }),
  };
  if (!valid(manifest, ctx, data.operationId, manifest.vaultBinding)) return fail();
  payloads(ctx, manifest, before, candidate);
  await writeExclusive(ctx.user, join(directory, 'before.json'), before);
  await writeExclusive(ctx.user, join(directory, 'candidate.json'), candidate);
  await writeManifest(ctx.user, join(directory, 'manifest.json'), manifest);
  return (await readSetup(ctx, data.operationId)) ?? fail();
}
async function update(
  ctx: Context,
  record: StoredSetup,
  patch: Partial<Pick<Manifest, 'phase' | 'eventId' | 'revision'>>,
) {
  await quota(ctx, 16384);
  const fresh = await readSetup(ctx, record.manifest.operationId);
  if (!fresh || fresh.manifestSha !== record.manifestSha) throw new Error('mcp-call-control-stale');
  await writeManifest(
    ctx.user,
    join(record.directory, 'manifest.json'),
    { ...record.manifest, ...patch },
    record.manifestSha,
  );
  return (await readSetup(ctx, record.manifest.operationId)) ?? fail();
}
export const markSetupAuthority = (
  ctx: Context,
  record: StoredSetup,
  eventId: string,
  revision: string,
) => update(ctx, record, { phase: 'authority-recorded', eventId, revision });
export const finishSetup = (
  ctx: Context,
  record: StoredSetup,
  configuration: 'confirmed' | 'unconfirmed',
) =>
  update(ctx, record, {
    phase: configuration === 'confirmed' ? 'configuration-confirmed' : 'configuration-unconfirmed',
  });
export async function verifySetupConfiguration(
  ctx: Context,
  record: StoredSetup,
): Promise<'confirmed' | 'unconfirmed' | 'unavailable'> {
  try {
    const m = record.manifest,
      sources = await discoverMcpSources({
        project: ctx.project.path,
        userHome: ctx.user.path,
        platform: ctx.platform,
        environment: ctx.environment,
        deadline: ctx.deadline,
      });
    const matches = sources.filter(
      (s) =>
        s.source === m.sourceType &&
        s.relativePath === m.relativePath &&
        binding(s.root) === m.sourceRootBinding,
    );
    if (matches.length !== 1 || matches[0].applicability !== 'supported') return 'unavailable';
    const capture = await readMcpSource(matches[0]);
    return capture.sha256 === m.candidateSha256 && capture.mode === m.mode
      ? 'confirmed'
      : 'unconfirmed';
  } catch {
    return 'unavailable';
  }
}

/** Read-only bounded recovery inventory; corruption remains explicit and no record is repaired or removed. */
export async function readRetainedCallControlSetups(
  ctx: Context,
): Promise<{ records: StoredSetup[]; available: boolean }> {
  try {
    await quota(ctx, 0);
    if (!(await inspect(ctx.user, vault(ctx), 'directory', true)))
      return { records: [], available: true };
    const records: StoredSetup[] = [];
    for await (const entry of await opendir(vault(ctx))) {
      if (entry.name === '.gitignore') continue;
      const record = await readSetupRecord(ctx, entry.name);
      if (!record) return fail();
      records.push(record);
    }
    return { records, available: true };
  } catch {
    return { records: [], available: false };
  }
}
