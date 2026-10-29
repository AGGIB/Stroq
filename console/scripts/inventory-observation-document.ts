import { isDeepStrictEqual } from 'node:util';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.ts';
import {
  validateInventoryObservationRecord,
  type InventoryObservationRecord,
} from '../lib/inventory-monitor';
import {
  validateObservationFacts,
  observationHash,
  observationSummary,
  compareObservations,
  type ObservationFacts,
} from './inventory-observation.ts';
export const MAX_OBSERVATION_VERSIONS = 16;
export const OBSERVATION_SCHEMA = 'stroq-inventory-observation-store/1';
const SCHEMA = OBSERVATION_SCHEMA;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const exact = (v: any, keys: string[]) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
function fail(code: string): never {
  throw new Error(code);
}
export type ObservationVersion = {
  sourceProfileSha256: string;
  chainSha256: string;
  record: InventoryObservationRecord;
  facts: ObservationFacts;
};
export type ObservationDocument = {
  schema: typeof SCHEMA;
  home: string;
  workspaceId: string;
  storeId: string;
  records: ObservationVersion[];
  omitted: number;
  latestCheckId: string;
};
export function parseObservationDocument(
  bytes: Buffer,
  where: { home: string },
  workspaceId: string,
  storeId: string,
): ObservationDocument {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      parsed = parseStrictJson(source);
    if (!parsed.ok) fail('observation-store-invalid');
    const v = parsed.value as ObservationDocument;
    if (
      !exact(v, [
        'schema',
        'home',
        'workspaceId',
        'storeId',
        'records',
        'omitted',
        'latestCheckId',
      ]) ||
      v.schema !== SCHEMA ||
      v.home !== where.home ||
      v.workspaceId !== workspaceId ||
      v.storeId !== storeId ||
      !UUID.test(v.latestCheckId) ||
      !Number.isSafeInteger(v.omitted) ||
      v.omitted < 0 ||
      v.omitted > 1000000000 ||
      !Array.isArray(v.records) ||
      v.records.length === 0 ||
      v.records.length > MAX_OBSERVATION_VERSIONS ||
      JSON.stringify(v) + '\n' !== source
    )
      fail('observation-store-invalid');
    const ids = new Set<string>();
    for (const [index, version] of v.records.entries()) {
      if (
        !exact(version, ['chainSha256', 'sourceProfileSha256', 'record', 'facts']) ||
        !SHA.test(version.chainSha256) ||
        !SHA.test(version.sourceProfileSha256) ||
        !validateInventoryObservationRecord(version.record) ||
        !validateObservationFacts(version.facts) ||
        ids.has(version.record.id)
      )
        fail('observation-store-invalid');
      ids.add(version.record.id);
      const summary = observationSummary(version.facts);
      if (
        version.record.observationSha256 !== observationHash(version.facts) ||
        Object.keys(summary).some(
          (k) =>
            summary[k as keyof typeof summary] !==
            version.record[k as keyof InventoryObservationRecord],
        )
      )
        fail('observation-store-invalid');
      const prior = v.records[index + 1];
      if (prior) {
        if (
          version.record.firstObservedAt < prior.record.lastObservedAt ||
          version.record.changes.fromId !== prior.record.id
        )
          fail('observation-store-invalid');
        const expected =
          version.chainSha256 === prior.chainSha256
            ? { ...compareObservations(prior.facts, version.facts), fromId: prior.record.id }
            : {
                status: 'runtime-changed',
                fromId: prior.record.id,
                total: 0,
                rows: [],
                omitted: 0,
              };
        if (
          !isDeepStrictEqual(version.record.changes, expected) ||
          (version.chainSha256 === prior.chainSha256 &&
            (version.sourceProfileSha256 !== prior.sourceProfileSha256 ||
              version.record.runtimeSha256 !== prior.record.runtimeSha256 ||
              version.record.observationSha256 === prior.record.observationSha256))
        )
          fail('observation-store-invalid');
      }
    }
    return v;
  } catch {
    fail('observation-store-invalid');
  }
}
