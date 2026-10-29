import type { CodexPathGuardRecord } from '../lib/codex-path-guard.ts';
import { parseGuardToml } from './codex-network-guard-parse.ts';
import { restorePathGuardRecord, assertPathGuardDependencies } from './codex-path-guard-capture.ts';
import { assertPathGuardSelectorOwnership } from './codex-configuration-ownership.ts';
import { pathGuardSuperseded } from './codex-path-guard-ownership.ts';
import {
  same,
  controlParents,
  sourceSnapshot,
  type GuardOptions,
  type PathGuardCapture,
  type PathGuardRecord,
  type ControlContext,
} from './codex-path-guard-binding.ts';
/** One state capture is shared across records; caller checks its config CAS after all projections. */
export async function projectPathGuardRecord(
  options: GuardOptions,
  context: ControlContext,
  record: PathGuardRecord,
  records: PathGuardRecord[],
  capture: PathGuardCapture | null,
  checkCurrent = true,
): Promise<CodexPathGuardRecord> {
  const m = record.manifest,
    superseded = pathGuardSuperseded(record, records);
  let standing: CodexPathGuardRecord['standing'] = 'unavailable',
    canRestore = false;
  if (capture && same(capture.context, context) && capture.before.bytes !== null) {
    try {
      const current: Record<string, any> = parseGuardToml(capture.before.bytes) ?? {},
        owned = current.permissions?.[m.profileName]?.filesystem?.[m.credentialTarget] === 'deny',
        selected = current.default_permissions === m.profileName,
        row = capture.public.presets.find((p) => p.id === m.presetId);
      standing =
        !owned || !selected ? 'changed' : row?.declaration === 'deny' ? 'selected' : 'overridden';
      if (m.phase === 'guarded' && !superseded && same(controlParents(capture.before), m.parents)) {
        try {
          await assertPathGuardSelectorOwnership(context, m.profileName);
          await restorePathGuardRecord(options, capture, record);
          canRestore = true;
        } catch {}
      }
      if (checkCurrent) {
        await assertPathGuardDependencies(options, capture);
        const current = await sourceSnapshot(context);
        if (!same({ ...current, bytes: null }, { ...capture.before, bytes: null }))
          throw Error('changed');
      }
    } catch {
      standing = 'unavailable';
      canRestore = false;
    }
  }
  return {
    id: m.id,
    operationId: m.operationId,
    revision: record.revision,
    controlContextId: m.controlContextId,
    kind: m.kind,
    presetId: m.presetId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    operationStatus: ['prepared', 'restoring'].includes(m.phase)
      ? 'unknown'
      : (m.phase as 'guarded' | 'restored'),
    ownership: superseded ? 'superseded' : 'current',
    standing,
    originalSha256: m.originalSha256,
    candidateSha256: m.candidateSha256,
    canRestore,
    sharedUserConfig: true,
    hostEnforcement: false,
  };
}
