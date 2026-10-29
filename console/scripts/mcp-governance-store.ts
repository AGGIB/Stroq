import { opendir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './agent-setup-files.mjs';
import { MCP_GOVERNANCE_ERRORS } from '../lib/mcp-governance-types.ts';
import { exact, uuid, context, workspace } from '../lib/mcp-governance-validation.ts';
import {
  governanceHash,
  governanceFail as fail,
  parseGovernanceMetadata,
  validateMcpGovernanceIntent,
  GOVERNANCE_RECORD_BYTES,
  GOVERNANCE_RECORDS,
  GOVERNANCE_STORE_BYTES,
} from './mcp-governance-store-schema.ts';
import { createGovernanceFiles, fileRevision, same } from './mcp-governance-store-files.ts';
import { inspectGovernanceLock, withGovernanceLease } from './mcp-governance-store-lease.ts';
import type {
  McpGovernanceIntent,
  McpGovernanceIntentPatch,
  McpGovernanceStoreEntry,
  McpGovernanceStoreLease,
  McpGovernanceStoreOptions,
  McpGovernanceStoreRead,
  McpGovernanceStore,
} from './mcp-governance-store-types.ts';
export * from './mcp-governance-store-types.ts';
export { validateMcpGovernanceIntent } from './mcp-governance-store-schema.ts';
interface Snapshot extends McpGovernanceStoreRead {
  bytes: number;
  marker: any;
  fingerprint: unknown;
}
interface Session {
  operationId: string;
  expected: Snapshot;
  physical: () => Promise<void>;
}
const errors = new Set<string>(MCP_GOVERNANCE_ERRORS);
function finiteError(e: unknown): never {
  fail(
    e instanceof Error && errors.has(e.message) ? e.message : 'mcp-governance-store-unavailable',
  );
}
const copy = <T>(v: T): T => structuredClone(v);

/** Private global journal: passive reads never create, migrate, delete or settle an operation. */
export function createMcpGovernanceStore(options: McpGovernanceStoreOptions): McpGovernanceStore {
  if (
    !exact(options, [
      'home',
      'contextId',
      'workspaceId',
      ...(Object.hasOwn(options, 'now') ? ['now'] : []),
    ]) ||
    !context(options.contextId) ||
    !workspace(options.workspaceId) ||
    (options.now !== undefined && typeof options.now !== 'function')
  )
    fail('mcp-governance-invalid');
  const files = createGovernanceFiles(options.home),
    sessions = new WeakMap<McpGovernanceStoreLease, Session>();
  const now = options.now ?? Date.now;
  async function scan(temporary?: { path: string; bytes: Buffer }): Promise<Snapshot> {
    const location = await files.inspect();
    if (!location.store)
      return {
        status: 'missing',
        records: [],
        revision: null,
        bytes: 0,
        marker: null,
        fingerprint: null,
      };
    const records: McpGovernanceStoreEntry[] = [],
      fingerprints: unknown[] = [];
    let bytes = 0,
      names = 0,
      marker: any = null,
      foundTemporary = false;
    for await (const item of await opendir(files.directory, { bufferSize: 8 })) {
      if (++names > GOVERNANCE_RECORDS + 4) fail();
      const path = join(files.directory, item.name);
      if (item.name === '.writer.lock' || item.name === '.writer.lock.reaper') {
        await inspectGovernanceLock(files, path);
        bytes += 4096;
        continue;
      }
      if (temporary?.path === path) {
        const read = await files.read(path);
        if (!read.bytes?.equals(temporary.bytes)) fail();
        bytes += read.bytes.length;
        foundTemporary = true;
        continue;
      }
      if (item.name === '.gitignore') {
        marker = await files.read(path, 2);
        if (!marker.bytes?.equals(Buffer.from('*\n'))) fail();
        bytes += 2;
        continue;
      }
      if (
        !item.isFile() ||
        !item.name.endsWith('.json') ||
        !uuid(item.name.slice(0, -5)) ||
        records.length >= GOVERNANCE_RECORDS
      )
        fail();
      const read = await files.read(path),
        intent = parseGovernanceMetadata(read.bytes ?? fail());
      if (!validateMcpGovernanceIntent(intent) || intent.id !== item.name.slice(0, -5)) fail();
      const physical = fileRevision(read, files.home),
        revision = governanceHash(JSON.stringify(physical));
      records.push({ intent, revision });
      fingerprints.push({ id: intent.id, ...physical });
      bytes += read.bytes!.length;
      if (bytes > GOVERNANCE_STORE_BYTES) fail();
    }
    if (
      (temporary && !foundTemporary) ||
      (!marker && records.length) ||
      bytes > GOVERNANCE_STORE_BYTES ||
      new Set(records.map((r) => r.intent.operationId)).size !== records.length
    )
      fail();
    records.sort((a, b) => a.intent.id.localeCompare(b.intent.id));
    fingerprints.sort((a: any, b: any) => a.id.localeCompare(b.id));
    await files.inspect();
    const fingerprint = {
      home: location.home,
      store: location.store,
      marker: marker ? fileRevision(marker, files.home) : null,
      records: fingerprints,
    };
    return {
      status: 'ready',
      records,
      revision: governanceHash(JSON.stringify(fingerprint)),
      bytes,
      marker,
      fingerprint,
    };
  }
  const publicRead = (v: Snapshot): McpGovernanceStoreRead =>
    copy({ status: v.status, records: v.records, revision: v.revision });
  async function read(): Promise<McpGovernanceStoreRead> {
    try {
      return publicRead(await scan());
    } catch {
      return { status: 'unavailable', records: [], revision: null };
    }
  }
  async function current(
    lease: McpGovernanceStoreLease,
    temporary?: { path: string; bytes: Buffer },
  ) {
    const session = sessions.get(lease);
    if (!session) fail('mcp-governance-invalid');
    await session.physical();
    const fresh = await scan(temporary);
    if (!same(fresh.fingerprint, session.expected.fingerprint)) fail('mcp-governance-stale');
    await session.physical();
    return { session, fresh };
  }
  async function withLease<T>(
    request: { operationId: string; explicitRecovery?: boolean },
    action: (lease: McpGovernanceStoreLease) => Promise<T>,
  ): Promise<T> {
    if (
      !exact(request, [
        'operationId',
        ...(Object.hasOwn(request, 'explicitRecovery') ? ['explicitRecovery'] : []),
      ]) ||
      !uuid(request.operationId) ||
      (request.explicitRecovery !== undefined && typeof request.explicitRecovery !== 'boolean') ||
      typeof action !== 'function'
    )
      fail('mcp-governance-invalid');
    let callbackThrew = false,
      callbackFailure: unknown;
    try {
      return await withGovernanceLease(
        files,
        {
          ...request,
          contextId: options.contextId,
          workspaceId: options.workspaceId,
          explicitRecovery: request.explicitRecovery === true,
        },
        async (physical) => {
          const lease: McpGovernanceStoreLease = {
            createdHome: copy(physical.createdHome),
            assertCurrent: async () => {
              await current(lease);
            },
          };
          const session: Session = {
            operationId: request.operationId,
            expected: await scan(),
            physical: physical.assertCurrent,
          };
          sessions.set(lease, session);
          try {
            let result: T;
            try {
              result = await action(lease);
            } catch (error) {
              callbackThrew = true;
              callbackFailure = error;
              throw error;
            }
            await current(lease);
            return result;
          } finally {
            sessions.delete(lease);
          }
        },
      );
    } catch (e) {
      if (callbackThrew && e === callbackFailure) throw e;
      finiteError(e);
    }
  }
  async function publish(
    intent: McpGovernanceIntent,
    lease: McpGovernanceStoreLease,
    expectedRevision: string | null,
  ) {
    const { session, fresh } = await current(lease);
    const old = fresh.records.find((r) => r.intent.id === intent.id);
    if (expectedRevision === null ? old !== undefined : old?.revision !== expectedRevision)
      fail('mcp-governance-stale');
    const bytes = Buffer.from(JSON.stringify(intent) + '\n');
    if (bytes.length > GOVERNANCE_RECORD_BYTES) fail('mcp-governance-store-full');
    // One global reserve covers the next metadata replacement and both bounded lease owners.
    if (fresh.bytes + bytes.length + GOVERNANCE_RECORD_BYTES + 8194 > GOVERNANCE_STORE_BYTES)
      fail('mcp-governance-store-full');
    if (!fresh.marker) {
      if (fresh.records.length) fail();
      const handle = await open(join(files.directory, '.gitignore'), 'wx', 0o600);
      try {
        await handle.writeFile('*\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await files.sync();
      session.expected = await scan();
    }
    await current(lease);
    const path = join(files.directory, intent.id + '.json'),
      before = await files.read(path);
    const published = await atomicWrite((await files.inspect()).root, path, bytes, before, 0o600, {
      fault: async (stage: string, details: { temporary: string }) => {
        if (stage === 'before-rename') await current(lease, { path: details.temporary, bytes });
      },
    });
    await files.sync();
    await session.physical();
    const next = await scan(),
      entry = next.records.find((r) => r.intent.id === intent.id);
    if (
      !entry ||
      !same(entry.intent, intent) ||
      entry.revision !== governanceHash(JSON.stringify(fileRevision(published, files.home)))
    )
      fail('mcp-governance-write-unconfirmed');
    const prior = fresh.records.filter((r) => r.intent.id !== intent.id),
      after = next.records.filter((r) => r.intent.id !== intent.id);
    if (!same(prior, after)) fail('mcp-governance-write-unconfirmed');
    session.expected = next;
    return copy(entry);
  }
  async function create(intent: McpGovernanceIntent, lease: McpGovernanceStoreLease) {
    try {
      const session = sessions.get(lease);
      if (
        !session ||
        !validateMcpGovernanceIntent(intent) ||
        intent.phase !== 'prepared' ||
        intent.historyRef !== null ||
        intent.operationId !== session.operationId ||
        intent.binding.contextId !== options.contextId ||
        intent.binding.workspaceId !== options.workspaceId ||
        intent.createdAt !== intent.updatedAt
      )
        fail('mcp-governance-invalid');
      const { fresh } = await current(lease);
      if (fresh.records.length >= GOVERNANCE_RECORDS) fail('mcp-governance-store-full');
      if (
        fresh.records.some(
          (r) => r.intent.id === intent.id || r.intent.operationId === intent.operationId,
        )
      )
        fail('mcp-governance-stale');
      return await publish(copy(intent), lease, null);
    } catch (e) {
      finiteError(e);
    }
  }
  async function update(
    id: string,
    expectedRevision: string,
    patch: McpGovernanceIntentPatch,
    lease: McpGovernanceStoreLease,
  ) {
    try {
      if (
        !uuid(id) ||
        !/^[a-f0-9]{64}$/.test(expectedRevision) ||
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Reflect.ownKeys(patch).length === 0 ||
        !Reflect.ownKeys(patch).every((k) =>
          ['phase', 'staged', 'historyRef', 'terminalSource'].includes(k as string),
        )
      )
        fail('mcp-governance-invalid');
      const { session, fresh } = await current(lease),
        old = fresh.records.find((r) => r.intent.id === id);
      if (!old || old.revision !== expectedRevision) fail('mcp-governance-stale');
      if (
        old.intent.operationId !== session.operationId ||
        old.intent.binding.contextId !== options.contextId ||
        old.intent.binding.workspaceId !== options.workspaceId
      )
        fail('mcp-governance-invalid');
      const updatedAt = new Date(now()).toISOString(),
        next = { ...copy(old.intent), ...copy(patch), updatedAt };
      const transitions = {
        prepared: ['prepared', 'staged', 'not-applied'],
        staged: ['staged', 'applied'],
        applied: ['applied'],
        'not-applied': ['not-applied'],
      };
      if (
        !validateMcpGovernanceIntent(next) ||
        !transitions[old.intent.phase].includes(next.phase) ||
        (old.intent.staged !== null && !same(next.staged, old.intent.staged)) ||
        (old.intent.historyRef !== null && !same(next.historyRef, old.intent.historyRef)) ||
        (old.intent.terminalSource !== null && next.terminalSource !== old.intent.terminalSource)
      )
        fail('mcp-governance-invalid');
      return await publish(next, lease, expectedRevision);
    } catch (e) {
      finiteError(e);
    }
  }
  return { read, withLease, create, update };
}
