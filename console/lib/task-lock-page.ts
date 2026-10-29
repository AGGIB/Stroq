import { closed, count, hash } from './local-guards';
import { isTaskLockId, validateTaskLockState, type TaskLockState } from './task-locks';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

export const TASK_LOCK_PAGE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'task-page-stale': 'The task catalog changed. Refresh the first page before continuing.',
  'task-page-expired': 'This page link expired. Refresh the first page to continue.',
  'task-lookup-limit':
    "The task catalog limit was reached. The requested permission's absence is not established.",
  'preview-stale':
    'This permission version changed. Open current permissions to choose the current record.',
  'task-unavailable':
    'This exact task permission is unavailable in the inspected catalog. No other task was substituted.',
};

/** Each page is its own captured observation, not an atomic report over every page. */
export interface TaskLockPage {
  schema: 'stroq-task-lock-page/1';
  state: TaskLockState;
  page: { index: number; nextCursor: string | null; catalogLimited: boolean };
}
export type TaskLockPageRequest =
  { cursor: string } | { id: string; expectedPermitSha256: string | null };

export function validateTaskLockPage(value: unknown): value is TaskLockPage {
  if (
    !closed(value, ['schema', 'state', 'page']) ||
    value.schema !== 'stroq-task-lock-page/1' ||
    !validateTaskLockState(value.state) ||
    !closed(value.page, ['index', 'nextCursor', 'catalogLimited']) ||
    typeof value.page.index !== 'number' ||
    !count(value.page.index, 128) ||
    value.page.index < 1 ||
    !(value.page.nextCursor === null || uuid(value.page.nextCursor)) ||
    typeof value.page.catalogLimited !== 'boolean'
  )
    return false;
  const { state, page } = value;
  const index = value.page.index;
  if (index === 128 && page.nextCursor !== null) return false;
  if (!state.available)
    return page.index === 1 && page.nextCursor === null && page.catalogLimited === false;
  if (index > 1 || page.nextCursor !== null || page.catalogLimited)
    return state.coverage.limited && !state.coverage.complete;
  return true;
}

/** Browser requests select server-held cursors or exact opaque records, never filesystem paths. */
export function validateTaskLockPageRequest(value: unknown): value is TaskLockPageRequest {
  return (
    (closed(value, ['cursor']) && Reflect.ownKeys(value).length === 1 && uuid(value.cursor)) ||
    (closed(value, ['id', 'expectedPermitSha256']) &&
      Reflect.ownKeys(value).length === 2 &&
      isTaskLockId(value.id) &&
      (value.expectedPermitSha256 === null || hash(value.expectedPermitSha256)))
  );
}
