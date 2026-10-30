const ERRORS = new Set([
  'runtime-unavailable',
  'context-unavailable',
  'platform-unsupported',
  'task-unavailable',
  'preview-stale',
  'preview-expired',
  'task-lock-busy',
  'deadline-exceeded',
  'invalid-report',
  'server-stopped',
  'task-access-failed',
  'write-unconfirmed',
  'unsafe-source',
  'stale-evidence',
  'legacy-refusal',
  'refusal-unavailable',
  'operation-unavailable',
  'permission-unavailable',
  'permission-active',
  'signing-key-unavailable',
  'signing-key-mismatch',
]);
/**
 * A character the review screen would not show as it is, by code point (`task-access-review.ts`).
 * Its own shape, a hexadecimal number and nothing else, so no other diagnostic passes for one.
 */
const HIDDEN_CHARACTER = /^hidden-character-(?:[0-9a-f]{4}|[1-9a-f][0-9a-f]{4}|10[0-9a-f]{4})$/;
const hiddenCharacter = (code) => typeof code === 'string' && HIDDEN_CHARACTER.test(code);
/** Never reflect filesystem, parser, crypto or custom worker diagnostics into an API response. */
export const taskAccessError = (error) =>
  ERRORS.has(error?.message) || hiddenCharacter(error?.message)
    ? error.message
    : error?.message === 'agent-configuration-busy'
      ? 'task-lock-busy'
      : ['agent-configuration-unavailable', 'engine-unavailable'].includes(error?.message)
        ? 'runtime-unavailable'
        : 'task-access-failed';
export const taskAccessStatus = (code) =>
  [
    'preview-stale',
    'preview-expired',
    'task-lock-busy',
    'stale-evidence',
    'permission-active',
  ].includes(code)
    ? 409
    : code === 'task-unavailable'
      ? 404
      : code === 'deadline-exceeded'
        ? 504
        : [
              'platform-unsupported',
              'unsafe-source',
              'write-unconfirmed',
              'legacy-refusal',
              'refusal-unavailable',
              'operation-unavailable',
              'permission-unavailable',
              'signing-key-unavailable',
              'signing-key-mismatch',
            ].includes(code) || hiddenCharacter(code)
          ? 422
          : 503;
