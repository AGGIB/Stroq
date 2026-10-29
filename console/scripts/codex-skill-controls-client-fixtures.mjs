import { codexSourcesFixture } from './codex-skill-sources-fixtures.mjs';
/** A two-minute window from one reading of the clock: two readings are now and then a millisecond apart. */
const twoMinutes = () => {
  const at = Date.now();
  return { createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 120000).toISOString() };
};
export const contextId = 'codex-context-' + 'e'.repeat(64);
export const otherContextId = 'codex-context-' + 'f'.repeat(64);
export const recordId = '10000000-0000-4000-8000-000000000001';
export const operationId = '20000000-0000-4000-8000-000000000002';
export function sourceReport() {
  const report = codexSourcesFixture();
  report.context.controlContextId = contextId;
  report.items[0].declaredState = 'enabled';
  return report;
}
export function controlRecord(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: recordId,
    operationId,
    revision: '1'.repeat(64),
    controlContextId: contextId,
    createdAt: now,
    updatedAt: now,
    name: 'Release notes',
    location: { label: 'release/notes', redacted: false },
    operationStatus: 'disabled',
    standing: 'disabled',
    originalSha256: 'd'.repeat(64),
    candidateSha256: 'a'.repeat(64),
    canRestore: true,
    sharedUserConfig: true,
    hostEnforcement: false,
    ...overrides,
  };
}
export function controlState(records = []) {
  return {
    schema: 'stroq-codex-skill-controls/1',
    controlContextId: contextId,
    generatedAt: new Date().toISOString(),
    available: true,
    history: 'ready',
    records,
    error: null,
  };
}
export function controlPreview(operation = 'disable') {
  const report = sourceReport();
  return {
    schema: 'stroq-codex-skill-control-preview/1',
    id: operationId,
    operationId,
    controlContextId: contextId,
    operation,
    recordId,
    recordRevision: operation === 'disable' ? null : '1'.repeat(64),
    ...twoMinutes(),
    name: report.items[0].name,
    location: report.items[0].location,
    beforeSha256: operation === 'disable' ? report.settings.sha256 : 'a'.repeat(64),
    afterSha256: operation === 'disable' ? 'a'.repeat(64) : 'd'.repeat(64),
    sameNameCopies: 2,
    sharedUserConfig: true,
    retainsConfigurationCopies: true,
    formattingPreserved: true,
    hostEnforcement: false,
    binding:
      operation === 'disable'
        ? {
            controlContextId: contextId,
            sourceId: report.items[0].sourceId,
            candidateId: report.items[0].id,
            entrypointSha256: report.items[0].entrypointSha256,
            runtimeSha256: report.runtimeSha256,
          }
        : null,
  };
}
export function controlReceipt(operation = 'disable', overrides = {}) {
  return {
    schema: 'stroq-codex-skill-control-receipt/1',
    controlContextId: contextId,
    operationId,
    operation,
    checkedAt: new Date().toISOString(),
    writeConfirmed: true,
    record: controlRecord(
      operation === 'restore'
        ? {
            operationStatus: 'restored',
            standing: 'enabled-or-unspecified',
            canRestore: false,
          }
        : {},
    ),
    ...overrides,
  };
}
