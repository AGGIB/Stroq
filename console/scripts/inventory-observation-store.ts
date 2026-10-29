import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertInventoryMonitorContext } from './inventory-monitor-context.ts';
import {
  parseObservationDocument,
  OBSERVATION_SCHEMA as SCHEMA,
  MAX_OBSERVATION_VERSIONS,
  type ObservationDocument as Document,
  type ObservationVersion as Version,
} from './inventory-observation-document.ts';
export { MAX_OBSERVATION_VERSIONS } from './inventory-observation-document.ts';
import {
  validateInventoryObservationRecord,
  type InventoryObservationRecord,
} from '../lib/inventory-monitor';
import type { InventoryState } from '../lib/inventory';
import type {
  InventoryMonitorBound,
  InventoryMonitorIntent,
  InventoryMonitorStoreOptions,
} from './inventory-monitor-store.ts';
import {
  atomicWrite,
  rootIdentity,
  snapshotFile,
  MAX_CONFIG,
} from './inventory-observation-files.ts';
import {
  projectInventory,
  observationHash,
  observationSummary,
  compareObservations,
} from './inventory-observation.ts';

export const MAX_OBSERVATION_BYTES = MAX_CONFIG;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const exact = (v: any, keys: string[]) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const stamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
function fail(code: string): never {
  throw new Error(code);
}
const owned = (s: { uid: number }) =>
  typeof process.getuid !== 'function' || s.uid === process.getuid();
type Bound = InventoryMonitorBound;
type ObservationStoreOptions = InventoryMonitorStoreOptions & {
  readIntent(): Promise<{ revision: string; record: InventoryMonitorIntent } | null>;
};
export type ObservationHistory = {
  status: 'missing' | 'ready' | 'unavailable';
  revision: string | null;
  records: InventoryObservationRecord[];
  omitted: number;
  latestCheckId: string | null;
  latestCaptureId: string | null;
};
export type ReadyObservationHistory = ObservationHistory & {
  status: 'ready';
  revision: string;
  latestCheckId: string;
  latestCaptureId: string;
};
const empty = (status: ObservationHistory['status']): ObservationHistory => ({
  status,
  revision: null,
  records: [],
  omitted: 0,
  latestCheckId: null,
  latestCaptureId: null,
});
const publicHistory = (doc: Document, revision: string): ReadyObservationHistory => ({
  status: 'ready',
  revision,
  records: doc.records.map((v) => structuredClone(v.record)),
  omitted: doc.omitted,
  latestCheckId: doc.latestCheckId,
  latestCaptureId: doc.records[0]!.record.id,
});
async function location(selectedHome: string, storeId: string) {
  let anchor = selectedHome;
  for (;;) {
    try {
      const s = await lstat(anchor);
      if (!s.isDirectory() || s.isSymbolicLink() || !owned(s) || s.mode & 0o022)
        fail('observation-store-unavailable');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(anchor) === anchor)
        throw error;
      anchor = dirname(anchor);
    }
  }
  const root = await rootIdentity(anchor),
    home = join(root.path, relative(anchor, selectedHome));
  return {
    root,
    home,
    file: join(home, 'console', 'inventory-monitor-observations', `${storeId}.json`),
  };
}
async function snapshot(where: Awaited<ReturnType<typeof location>>, file = where.file) {
  try {
    const s = await lstat(file);
    if (s.isFile() && s.size > MAX_OBSERVATION_BYTES) fail('observation-store-limit');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const capture = await snapshotFile(where.root, file, MAX_OBSERVATION_BYTES);
  if (
    capture.directories.some(
      (d) =>
        !owned(d) ||
        d.mode & 0o022 ||
        ((d.path === where.home || d.path.startsWith(`${where.home}/`)) &&
          (d.mode & 0o777) !== 0o700),
    ) ||
    (capture.file && (!owned(capture.file) || (capture.file.mode & 0o777) !== 0o600))
  )
    fail('observation-store-unavailable');
  return capture;
}
function codeOf(error: any) {
  if (error?.message === 'context-unavailable') return error;
  if (
    /^observation-(?:store-(?:invalid|unavailable|stale|limit)|write-unconfirmed)$/.test(
      error?.message,
    )
  )
    return error;
  return new Error(
    error?.message === 'preview-stale'
      ? 'observation-store-stale'
      : 'observation-store-unavailable',
  );
}
/** Intent and history are separate so malformed history can never prevent pausing checks. */
export function createObservationStore({
  home,
  roots,
  storeId,
  workspaceId,
  readIntent,
  fault = async () => {},
}: ObservationStoreOptions) {
  async function capture() {
    const where = await location(home, storeId),
      before = await snapshot(where);
    return {
      where,
      before,
      document:
        before.bytes === null
          ? null
          : parseObservationDocument(before.bytes, where, workspaceId, storeId),
    };
  }
  async function readObservations(): Promise<ObservationHistory> {
    try {
      const current = await capture();
      return current.document
        ? publicHistory(current.document, current.before.sha256)
        : empty('missing');
    } catch {
      return empty('unavailable');
    }
  }
  async function appendObservation(
    input: InventoryState,
    bound: Bound,
    options: {
      expectedIntentRevision: string;
      checkId: string;
      observedAt: string;
      beforeCommit?: () => Promise<void>;
    },
  ) {
    if (
      !exact(bound, ['engineVersion', 'runtimeSha256', 'sourceProfileSha256']) ||
      typeof bound.engineVersion !== 'string' ||
      !SHA.test(bound.runtimeSha256) ||
      !SHA.test(bound.sourceProfileSha256) ||
      !options ||
      !SHA.test(options.expectedIntentRevision) ||
      !UUID.test(options.checkId) ||
      !stamp(options.observedAt) ||
      (options.beforeCommit !== undefined && typeof options.beforeCommit !== 'function') ||
      input?.workspace?.id !== workspaceId
    )
      fail('observation-store-invalid');
    const facts = projectInventory(structuredClone(input), {
      projectIsUser: roots.project.path === roots.user.path,
    });
    bound = structuredClone(bound);
    options = { ...options };
    let committed = false,
      guardError: unknown;
    try {
      const current = await capture(),
        { where, before } = current;
      const assertIntent = async () => {
        await assertInventoryMonitorContext({ home: where.home, roots });
        try {
          const actual = {
            project: await rootIdentity(roots.project.path),
            user: await rootIdentity(roots.user.path),
          };
          if (!isDeepStrictEqual(actual, roots)) fail('observation-store-stale');
        } catch {
          fail('observation-store-stale');
        }
        const intent = await readIntent();
        if (
          !intent ||
          intent.revision !== options.expectedIntentRevision ||
          intent.record.enabled !== true ||
          intent.record.home !== where.home ||
          !isDeepStrictEqual(intent.record.roots, roots) ||
          intent.record.engineVersion !== bound.engineVersion ||
          intent.record.runtimeSha256 !== bound.runtimeSha256 ||
          intent.record.sourceProfileSha256 !== bound.sourceProfileSha256
        )
          fail('observation-store-stale');
      };
      await assertIntent();
      const prior = current.document?.records[0],
        chainSha256 = observationHash({ home: where.home, roots, workspaceId, storeId, ...bound });
      if (
        current.document?.latestCheckId === options.checkId ||
        (prior && options.observedAt < prior.record.lastObservedAt)
      )
        fail('observation-store-stale');
      const observationSha256 = observationHash(facts),
        coalesced =
          prior?.chainSha256 === chainSha256 &&
          prior.record.observationSha256 === observationSha256;
      const record: InventoryObservationRecord = coalesced
        ? { ...structuredClone(prior!.record), lastObservedAt: options.observedAt }
        : {
            id: randomUUID(),
            firstObservedAt: options.observedAt,
            lastObservedAt: options.observedAt,
            runtimeSha256: bound.runtimeSha256,
            observationSha256,
            ...observationSummary(facts),
            changes: prior
              ? prior.chainSha256 === chainSha256
                ? { ...compareObservations(prior.facts, facts), fromId: prior.record.id }
                : {
                    status: 'runtime-changed',
                    fromId: prior.record.id,
                    total: 0,
                    rows: [],
                    omitted: 0,
                  }
              : { status: 'first', fromId: null, total: 0, rows: [], omitted: 0 },
          };
      if (!validateInventoryObservationRecord(record)) fail('observation-store-invalid');
      const records: Version[] = coalesced
        ? [{ ...prior!, record }, ...current.document!.records.slice(1)]
        : [
            { chainSha256, sourceProfileSha256: bound.sourceProfileSha256, record, facts },
            ...(current.document?.records ?? []),
          ];
      const document: Document = {
        schema: SCHEMA,
        home: where.home,
        workspaceId,
        storeId,
        records,
        omitted: current.document?.omitted ?? 0,
        latestCheckId: options.checkId,
      };
      let bytes: Buffer;
      for (;;) {
        bytes = Buffer.from(JSON.stringify(document) + '\n');
        if (
          document.records.length <= MAX_OBSERVATION_VERSIONS &&
          bytes.length <= MAX_OBSERVATION_BYTES
        )
          break;
        if (document.records.length <= 1) fail('observation-store-limit');
        if (document.omitted >= 1000000000) fail('observation-store-limit');
        document.records.pop();
        document.omitted++;
      }
      const revision = observationHashBytes(bytes);
      await atomicWrite(where.root, where.file, bytes, before, 0o600, {
        async fault(stage, details) {
          if (stage === 'after-rename') committed = true;
          const staged =
            stage === 'before-rename' ? await snapshot(where, details.temporary) : null;
          await fault(stage, details);
          if (stage === 'before-rename') {
            if (!isDeepStrictEqual(staged, await snapshot(where, details.temporary)))
              fail('observation-store-stale');
            await assertIntent();
            try {
              await options.beforeCommit?.();
            } catch (error) {
              guardError = error;
              throw error;
            }
          }
        },
      });
      const after = await snapshot(where);
      if (after.sha256 !== revision) fail('observation-write-unconfirmed');
      return { ...publicHistory(document, revision), record: structuredClone(record) };
    } catch (error) {
      if (committed) fail('observation-write-unconfirmed');
      if (error === guardError) throw error;
      throw codeOf(error);
    }
  }
  return { readObservations, appendObservation };
}
const observationHashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
