import {
  validateCodexSkillControlPreview,
  validateCodexSkillControlState,
  type CodexSkillControlPreview,
} from './codex-skill-controls';
import { codexSkillControlHref } from './codex-skill-control-navigation';
import type { ProtectionEvidenceRow } from './protection-evidence';

/** Passive current declarations and exact retained operations; never native enforcement. */
export function codexSkillControlRows(
  value: unknown,
  pending: readonly { preview: CodexSkillControlPreview }[] = [],
): ProtectionEvidenceRow[] {
  const state = validateCodexSkillControlState(value) ? value : null;
  const rows: ProtectionEvidenceRow[] = [];
  const unknown = pending.filter((p) => validateCodexSkillControlPreview(p.preview));
  const operations = new Set<string>();
  for (const { preview } of unknown) {
    const key = preview.controlContextId + ':' + preview.operationId;
    if (operations.has(key)) continue;
    operations.add(key);
    const foreign = state?.controlContextId && state.controlContextId !== preview.controlContextId;
    rows.push({
      key: 'codex-skill-write-' + key,
      title: 'Codex skill change is unconfirmed',
      detail: foreign
        ? 'This request belongs to another Codex data directory. Return to that context to recheck it.'
        : 'The response did not establish the write outcome. Recheck the exact saved operation; do not repeat the change.',
      href: codexSkillControlHref(preview.recordId, preview.controlContextId),
      action: 'Inspect saved change',
      tone: 'orange',
    });
  }
  if (!state || !state.available || state.history === 'unavailable') {
    rows.push({
      key: 'codex-skill-control-history',
      title: 'Codex skill settings unavailable',
      detail: 'Saved changes or current base user settings could not be verified.',
      href: codexSkillControlHref(),
      action: 'Inspect saved changes',
      tone: 'orange',
    });
  }
  let disabled = 0;
  for (const record of state?.records ?? []) {
    if (operations.has(record.controlContextId + ':' + record.operationId)) continue;
    const uncertain = ['prepared', 'restoring', 'unknown'].includes(record.operationStatus);
    if (uncertain || (record.operationStatus === 'disabled' && record.standing !== 'disabled')) {
      rows.push({
        key: 'codex-skill-record-' + record.controlContextId + ':' + record.id,
        title: uncertain ? 'Codex skill change needs recheck' : 'Codex skill declaration changed',
        detail: uncertain
          ? 'A saved operation has no confirmed publication result. Inspect its retained evidence.'
          : 'The saved disable no longer matches the current base user declaration.',
        href: codexSkillControlHref(record.id, record.controlContextId),
        action: 'Inspect saved change',
        tone: 'orange',
      });
    } else if (record.operationStatus === 'disabled' && record.standing === 'disabled') disabled++;
  }
  if (disabled)
    rows.push({
      key: 'codex-skill-disabled',
      title: `${disabled} Codex disable ${disabled === 1 ? 'record matches' : 'records match'} current settings`,
      detail:
        'Present in base user configuration. Native adoption is unverified; profiles and session overrides can differ.',
      href: codexSkillControlHref(),
      action: 'Inspect saved changes',
      tone: 'muted',
    });
  return rows;
}
