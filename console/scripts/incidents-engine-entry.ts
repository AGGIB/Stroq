import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { AuditLog } from '../../packages/core/src/index.js';
export { createIncidentAssessmentService } from './incident-assessment-control.ts';
export { routeIncidentAssessments } from './incident-assessment-http.ts';

// Input is a service-owned bounded snapshot, never a browser-supplied path.
export async function verifyCapturedJournal(path: string) {
  return new AuditLog(path).verify();
}

if (!isMainThread) {
  Promise.resolve()
    .then(() => {
      if (!workerData || typeof workerData.path !== 'string') throw new Error('invalid-request');
      return verifyCapturedJournal(workerData.path);
    })
    .then(
      (value) => parentPort?.postMessage({ ok: true, value }),
      () => parentPort?.postMessage({ ok: false, error: 'engine-unavailable' }),
    );
}
