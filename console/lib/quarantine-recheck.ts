import type { SkillQuarantineArtifact, SkillQuarantineState } from './skill-quarantine';
import { quarantineSelectionKey, sameQuarantineArtifact } from './quarantine-binding';

export type QuarantineTransport = (
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
type UnknownWrite = {
  action: 'quarantine' | 'restore';
  workspaceId: string;
  artifact: SkillQuarantineArtifact;
  recordId: string;
  startedAt: string;
};
const pending = new WeakMap<QuarantineTransport, Map<string, UnknownWrite>>();
export function unresolvedQuarantine(transport: QuarantineTransport) {
  let records = pending.get(transport);
  if (!records) {
    records = new Map();
    pending.set(transport, records);
  }
  return records;
}
/** Call only after an explicit, validated successful read. Automatic mount reads do not resolve writes. */
export function confirmQuarantineRecheck(
  transport: QuarantineTransport,
  state: SkillQuarantineState,
) {
  if (!state.available) return;
  const records = unresolvedQuarantine(transport);
  for (const [key, write] of records) {
    if (write.workspaceId !== state.workspaceId || state.generatedAt < write.startedAt) continue;
    const record = state.records.find((record) => record.id === write.recordId);
    if (!record && write.action === 'restore') continue;
    if (
      record &&
      (!sameQuarantineArtifact(record.artifact, write.artifact) ||
        record.checkedAt < write.startedAt)
    )
      continue;
    records.delete(key);
  }
}
export function noteQuarantineWrite(transport: QuarantineTransport, write: UnknownWrite) {
  unresolvedQuarantine(transport).set(
    quarantineSelectionKey(write.artifact, write.workspaceId),
    write,
  );
}
