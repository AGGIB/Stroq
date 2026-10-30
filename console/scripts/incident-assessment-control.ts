import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serialize } from 'node:v8';
import { acquireWorkspaceMonitorLease } from './workspace-monitor-lease.mjs';
import {
  INCIDENT_ASSESSMENT_ERRORS,
  assessmentReasonMatches,
  validateIncidentAssessmentPreview,
  validateIncidentAssessmentReceipt,
  validateIncidentAssessmentState,
  type IncidentAssessmentPreview,
  type IncidentAssessmentRecord,
  type IncidentAssessmentState,
} from '../lib/incident-assessments.ts';
import {
  selectAssessmentIncident,
  assessmentHash,
  assessmentFail,
  type AssessmentSource,
} from './incident-assessment-selector.ts';
import {
  readAssessmentStore,
  assertAssessmentStore,
  initializeAssessmentStore,
  appendAssessmentRecord,
  type AssessmentStore,
  type AssessmentFault,
} from './incident-assessment-store.ts';

const exact = (v: unknown, keys: string[]): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const codeOf = (error: unknown) => {
  const message = (error as Error)?.message;
  return (INCIDENT_ASSESSMENT_ERRORS as readonly string[]).includes(message)
    ? message
    : 'incident-assessments-unavailable';
};
const failed = (error: string) => ({
  status:
    error === 'invalid-request'
      ? 400
      : [
            'stale-evidence',
            'stale-assessment',
            'assessment-unchanged',
            'preview-unavailable',
            'preview-expired',
            'busy',
          ].includes(error)
        ? 409
        : ['store-full', 'write-unconfirmed'].includes(error)
          ? 422
          : 503,
  body: { error },
});
interface Lease {
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}
interface Configuration {
  home?: string;
  now?: () => number | Date;
  acquireLease?: (input: { home: string; storeId: string }) => Promise<Lease | null>;
  fault?: AssessmentFault;
}
interface Plan {
  report: IncidentAssessmentPreview;
  store: AssessmentStore;
  source: AssessmentSource;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}
/** Annotation only. One exact local-journal event; no native state, policy or review mutation. */
export async function createIncidentAssessmentService(configuration: Configuration = {}) {
  const home = resolve(configuration.home ?? join(homedir(), '.stroq')),
    now = configuration.now ?? Date.now,
    acquire = configuration.acquireLease ?? acquireWorkspaceMonitorLease;
  const storeId = assessmentHash(`stroq-incident-assessments/1\0${home}`),
    plans = new Map<string, Plan>(),
    active = new Set<Promise<unknown>>();
  let stopped = false,
    busy = false,
    lastClock = -Infinity;
  const clock = () => {
    try {
      const sampled = now(),
        value = sampled instanceof Date ? sampled.getTime() : sampled;
      if (
        !Number.isSafeInteger(value) ||
        value < lastClock ||
        !Number.isFinite(Date.parse(new Date(value).toISOString()))
      )
        assessmentFail('clock-unavailable');
      lastClock = value;
      return value;
    } catch {
      assessmentFail('clock-unavailable');
    }
  };
  const live = () => {
    if (stopped) assessmentFail('server-stopped');
  };
  function remove(id: string) {
    const p = plans.get(id);
    if (p) {
      clearTimeout(p.timer);
      plans.delete(id);
    }
    return p;
  }
  function track<T>(work: () => Promise<T>) {
    const p = Promise.resolve().then(work);
    active.add(p);
    p.finally(() => active.delete(p)).catch(() => undefined);
    return p;
  }
  function chronology(store: AssessmentStore, at: number) {
    if (store.records.some((r) => Date.parse(r.assessedAt) > at))
      assessmentFail('clock-unavailable');
  }
  async function getState() {
    try {
      live();
      const at = clock(),
        store = await readAssessmentStore(home);
      chronology(store, at);
      live();
      const body: IncidentAssessmentState = {
        schema: 'stroq-incident-assessments/1',
        scope: 'local-journal',
        generatedAt: new Date(at).toISOString(),
        history: store.revision === null ? 'missing' : 'ready',
        revision: store.revision,
        records: store.records,
        canRecord: !store.full,
        error: store.full ? 'store-full' : null,
      };
      if (!validateIncidentAssessmentState(body)) assessmentFail('history-unavailable');
      return { status: 200, body };
    } catch (error) {
      return {
        status: 200,
        body: {
          schema: 'stroq-incident-assessments/1',
          scope: 'local-journal',
          generatedAt: new Date().toISOString(),
          history: 'unavailable',
          revision: null,
          records: [],
          canRecord: false,
          error: codeOf(error),
        },
      };
    }
  }
  async function preview(input: unknown) {
    if (
      !exact(input, [
        'id',
        'expectedEvidenceSha',
        'expectedAssessmentId',
        'assessment',
        'reason',
      ]) ||
      !sha(input.expectedEvidenceSha) ||
      input.id !== `incident-${input.expectedEvidenceSha}` ||
      !(input.expectedAssessmentId === null || uuid(input.expectedAssessmentId)) ||
      !assessmentReasonMatches(input.assessment, input.reason)
    )
      return failed('invalid-request');
    if (stopped) return failed('server-stopped');
    if (busy) return failed('busy');
    busy = true;
    try {
      const at = clock(),
        source = await selectAssessmentIncident(
          home,
          { id: input.id, expectedEvidenceSha: input.expectedEvidenceSha },
          at,
        ),
        store = await readAssessmentStore(home);
      chronology(store, at);
      const latest = store.records.findLast((r) => r.incident.id === input.id) ?? null;
      if (
        (latest?.id ?? null) !== input.expectedAssessmentId ||
        (input.assessment === 'reopened' && (!latest || latest.assessment === 'reopened'))
      )
        assessmentFail('stale-assessment');
      if (latest && latest.assessment === input.assessment && latest.reason === input.reason)
        assessmentFail('assessment-unchanged');
      if (store.full) assessmentFail('store-full');
      live();
      if (clock() >= at + 120000) assessmentFail('preview-expired');
      const report: IncidentAssessmentPreview = {
        schema: 'stroq-incident-assessment-preview/1',
        id: randomUUID(),
        recordId: randomUUID(),
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(at + 120000).toISOString(),
        incident: source.incident,
        assessment: input.assessment,
        reason: input.reason,
        previousAssessmentId: latest?.id ?? null,
        storeRevision: store.revision,
      };
      if (!validateIncidentAssessmentPreview(report))
        assessmentFail('incident-assessments-unavailable');
      const bytes = serialize({ report, store, source }).byteLength;
      if (
        plans.size >= 8 ||
        [...plans.values()].reduce((n, p) => n + p.bytes, bytes) > 8 * 1024 * 1024
      )
        assessmentFail('busy');
      const timer = setTimeout(() => remove(report.id), 120000);
      timer.unref?.();
      plans.set(report.id, { report, source, store, bytes, timer });
      return { status: 200, body: structuredClone(report) };
    } catch (error) {
      return failed(codeOf(error));
    } finally {
      busy = false;
    }
  }
  function receipt(
    operation: 'record' | 'recheck',
    recordId: string,
    evidence: string,
    store: AssessmentStore,
  ) {
    const record = store.records.find((r) => r.id === recordId) ?? null;
    if (record && record.incident.evidenceSha256 !== evidence) assessmentFail('stale-assessment');
    const body = {
      schema: 'stroq-incident-assessment-receipt/1',
      operation,
      checkedAt: new Date(clock()).toISOString(),
      status: record ? 'recorded' : 'not-present',
      recordId,
      expectedEvidenceSha: evidence,
      revision: store.revision,
      record,
    };
    if (!validateIncidentAssessmentReceipt(body)) assessmentFail('clock-unavailable');
    return { status: 200, body };
  }
  async function apply(input: unknown) {
    const saved =
      input !== null &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      'previewId' in input &&
      uuid(input.previewId)
        ? remove(input.previewId)
        : undefined;
    if (!exact(input, ['previewId']) || !uuid(input.previewId)) return failed('invalid-request');
    if (stopped) return failed('server-stopped');
    if (!saved) return failed('preview-unavailable');
    if (busy) return failed('busy');
    busy = true;
    let lease: Lease | null = null,
      committed = false;
    try {
      const expiry = Date.parse(saved.report.expiresAt),
        at = clock();
      if (at >= expiry) assessmentFail('preview-expired');
      chronology(saved.store, at);
      await selectAssessmentIncident(
        home,
        { id: saved.report.incident.id, expectedEvidenceSha: saved.report.incident.evidenceSha256 },
        at,
        saved.source,
      );
      await initializeAssessmentStore(home, saved.store);
      lease = await acquire({ home, storeId });
      if (!lease) assessmentFail('busy');
      const guard = async () => {
        live();
        const checked = clock();
        if (checked >= expiry) assessmentFail('preview-expired');
        chronology(saved.store, checked);
        await lease!.assertCurrent();
        await selectAssessmentIncident(
          home,
          {
            id: saved.report.incident.id,
            expectedEvidenceSha: saved.report.incident.evidenceSha256,
          },
          checked,
          saved.source,
        );
      };
      await guard();
      await assertAssessmentStore(home, saved.store);
      const record: IncidentAssessmentRecord = {
        id: saved.report.recordId,
        incident: saved.report.incident,
        assessment: saved.report.assessment,
        reason: saved.report.reason,
        assessedAt: new Date(clock()).toISOString(),
        previousAssessmentId: saved.report.previousAssessmentId,
      };
      const after = await appendAssessmentRecord(
        home,
        saved.store,
        record,
        guard,
        configuration.fault,
      );
      committed = true;
      await lease.release();
      lease = null;
      live();
      return receipt('record', record.id, record.incident.evidenceSha256, after);
    } catch (error) {
      return failed(committed ? 'write-unconfirmed' : codeOf(error));
    } finally {
      try {
        await lease?.release();
      } catch {}
      busy = false;
    }
  }
  async function recheck(input: unknown) {
    if (
      !exact(input, ['recordId', 'expectedEvidenceSha']) ||
      !uuid(input.recordId) ||
      !sha(input.expectedEvidenceSha)
    )
      return failed('invalid-request');
    if (stopped) return failed('server-stopped');
    if (busy) return failed('busy');
    busy = true;
    let lease: Lease | null = null;
    try {
      const before = await readAssessmentStore(home);
      await initializeAssessmentStore(home, before);
      lease = await acquire({ home, storeId });
      if (!lease) assessmentFail('busy');
      live();
      await lease.assertCurrent();
      const store = await readAssessmentStore(home);
      chronology(store, clock());
      await lease.assertCurrent();
      await lease.release();
      lease = null;
      live();
      return receipt('recheck', input.recordId, input.expectedEvidenceSha, store);
    } catch (error) {
      return failed(codeOf(error));
    } finally {
      try {
        await lease?.release();
      } catch {}
      busy = false;
    }
  }
  return {
    getState: () => track(getState),
    preview: (v: unknown) => track(() => preview(v)),
    apply: (v: unknown) => track(() => apply(v)),
    recheck: (v: unknown) => track(() => recheck(v)),
    async close() {
      stopped = true;
      for (const id of plans.keys()) remove(id);
      while (active.size) await Promise.allSettled([...active]);
    },
  };
}
