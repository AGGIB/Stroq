import {
  validateCodexPathGuardState,
  validateCodexPathGuardPreview,
  type CodexPathGuardRecord,
} from './codex-path-guard';
import { CODEX_PATH_GUARD_LABELS, type PathGuardPending } from './codex-path-guard-client';
import { codexPathGuardHref } from './codex-path-guard-navigation';
import { closed, stamp } from './local-guards';
import type { ProtectionEvidenceRow } from './protection-evidence';
interface Input {
  state: unknown;
  pending?: readonly PathGuardPending[];
  loading?: boolean;
}
const key = (ctx: string, record: string, op: string) => `${ctx}:${record}:${op}`;
const recordKey = (r: CodexPathGuardRecord) => key(r.controlContextId, r.id, r.operationId);
const href = (r: Pick<CodexPathGuardRecord, 'controlContextId' | 'id'>) =>
  codexPathGuardHref({ controlContextId: r.controlContextId, recordId: r.id });
function validPending(v: unknown): v is PathGuardPending {
  return (
    closed(v, ['preview', 'startedAt']) &&
    Reflect.ownKeys(v).length === 2 &&
    validateCodexPathGuardPreview(v.preview) &&
    stamp(v.startedAt)
  );
}
function retainedRow(record: CodexPathGuardRecord): ProtectionEvidenceRow | null {
  const unknown = record.operationStatus === 'unknown';
  if (
    !unknown &&
    (record.operationStatus !== 'guarded' ||
      record.ownership !== 'current' ||
      record.standing === 'selected')
  )
    return null;
  const label = CODEX_PATH_GUARD_LABELS[record.presetId];
  return {
    key: 'codex-path-record:' + recordKey(record),
    title: unknown
      ? `Codex ${label.name} change needs recheck`
      : record.standing === 'overridden'
        ? `Codex ${label.name} rule is overridden`
        : record.standing === 'unavailable'
          ? `Codex ${label.name} rule is unverified`
          : `Codex ${label.name} rule changed`,
    context: 'Base user path declaration',
    detail: `${label.path} · ${unknown ? 'This retained operation has no confirmed publication outcome. Recheck the exact saved change.' : record.standing === 'overridden' ? 'A higher layer overrides this saved declaration. Inspect the exact rule.' : record.standing === 'unavailable' ? 'The current owned declaration could not be verified. Its receipt does not establish current adoption.' : 'The current user declaration differs from this owned change. Inspect the retained rule.'}`,
    href: href(record),
    action: 'Inspect change',
    tone: 'orange',
  };
}
/** Passive declaration/history projection only. Never captures paths, reconciles unknowns or runs Codex. */
export function codexPathGuardRows(input: Input): ProtectionEvidenceRow[] {
  const state = validateCodexPathGuardState(input.state) ? input.state : null,
    rows: ProtectionEvidenceRow[] = [],
    seen = new Set<string>();
  for (const value of input.pending ?? []) {
    if (!validPending(value)) continue;
    const p = value.preview,
      k = key(p.controlContextId, p.recordId, p.operationId);
    if (seen.has(k)) continue;
    seen.add(k);
    const label = CODEX_PATH_GUARD_LABELS[p.presetId],
      foreign = !!state?.controlContextId && p.controlContextId !== state.controlContextId;
    rows.push({
      key: 'codex-path-write:' + k,
      title: `Codex ${label.name} change is unconfirmed`,
      context: 'Exact path-rule operation',
      detail: `${label.path} · ${foreign ? 'This request belongs to another Codex data directory. Return to that context to recheck it.' : 'The response did not establish the write outcome. Recheck the exact saved change; do not repeat it.'}`,
      href: codexPathGuardHref({ controlContextId: p.controlContextId, recordId: p.recordId }),
      action: 'Inspect change',
      tone: 'orange',
    });
  }
  if ((input.pending ?? []).some((p) => !validPending(p)))
    rows.push({
      key: 'codex-path-pending-unavailable',
      title: 'Codex path change metadata unavailable',
      context: 'Unresolved request metadata',
      detail: 'An unresolved request could not be bound safely. Its state was not cleared.',
      href: codexPathGuardHref({ view: 'history' }),
      action: 'Inspect history',
      tone: 'orange',
    });
  const records = [...(state?.records ?? [])].sort(
    (a, b) => Number(b.operationStatus === 'unknown') - Number(a.operationStatus === 'unknown'),
  );
  for (const record of records) {
    if (seen.has(recordKey(record))) continue;
    const row = retainedRow(record);
    if (row) rows.push(row);
  }
  if (
    (!state && !input.loading) ||
    (state && (!state.available || state.history === 'unavailable'))
  )
    rows.push({
      key: 'codex-path-history-unavailable',
      title: 'Codex credential path history unavailable',
      context: 'Base user path declaration',
      detail:
        'Saved changes or current owned rules could not be verified. Missing evidence is not an empty history.',
      href: codexPathGuardHref({ view: 'history' }),
      action: 'Inspect history',
      tone: 'orange',
    });
  if (state?.available && state.history !== 'unavailable')
    for (const record of state.records) {
      if (
        record.operationStatus !== 'guarded' ||
        record.ownership !== 'current' ||
        record.standing !== 'selected' ||
        seen.has(recordKey(record))
      )
        continue;
      const label = CODEX_PATH_GUARD_LABELS[record.presetId];
      rows.push({
        key: 'codex-path-declared:' + recordKey(record),
        title: `Codex ${label.name} deny declaration matches`,
        context: 'Base user path declaration',
        detail: `${label.path} · An owned denial matches the captured user declaration. Native adoption remains unverified; aliases, other copies and overrides can differ.`,
        href: href(record),
        action: 'Inspect change',
        tone: 'muted',
      });
    }
  return rows;
}
