import { isCodexControlContext } from './codex-skill-controls';
const uuid = (v: string | null): v is string =>
  Boolean(v && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v));
export function codexSkillControlHref(recordId?: string, controlContextId?: string) {
  if (!recordId && !controlContextId) return '/skills/?codexControls=history';
  if (!uuid(recordId ?? null) || !isCodexControlContext(controlContextId))
    return '/skills/?codexControls=history';
  return `/skills/?codexControl=${encodeURIComponent(recordId!)}&context=${encodeURIComponent(controlContextId)}`;
}
export interface CodexSkillControlLocation {
  open: boolean;
  invalid: boolean;
  recordId: string | null;
  controlContextId: string | null;
}
export function parseCodexSkillControlLocation(
  query: Pick<URLSearchParams, 'get' | 'getAll'>,
): CodexSkillControlLocation {
  const recordId = query.get('codexControl'),
    controlContextId = query.get('context'),
    history = query.get('codexControls');
  if (recordId === null && history === null)
    return { open: false, invalid: false, recordId: null, controlContextId: null };
  const invalid =
    query.getAll('codexControl').length > 1 ||
    query.getAll('context').length > 1 ||
    query.getAll('codexControls').length > 1 ||
    (recordId !== null
      ? !uuid(recordId) || !isCodexControlContext(controlContextId) || history !== null
      : history !== 'history' || controlContextId !== null);
  return {
    open: true,
    invalid,
    recordId: invalid ? null : recordId,
    controlContextId: invalid ? null : controlContextId,
  };
}
