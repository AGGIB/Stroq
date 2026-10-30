import { describe, expect, it } from 'vitest';
import { createSessionTaintRefusal, SessionTaintRefusal } from './session-taint-error';
import { SESSION_TAINT_ERROR_MESSAGES } from './session-taint';
const refusals = [
  ['stale-state', 409],
  ['stale-evidence', 409],
  ['not-tainted', 422],
  ['preview-expired', 409],
  ['preview-unavailable', 409],
  ['recovery-full', 422],
  ['recovery-required', 422],
  ['session-busy', 409],
] as const;
describe('verified session clear pre-commit refusals', () => {
  it.each(refusals)('recognizes only %s at its exact HTTP status', (code, status) => {
    const error = createSessionTaintRefusal(code, status);
    expect(error).toBeInstanceOf(SessionTaintRefusal);
    expect(error?.code).toBe(code);
    expect(error?.status).toBe(status);
    expect(error?.message).toBe(SESSION_TAINT_ERROR_MESSAGES[code]);
    expect(createSessionTaintRefusal(code, status === 409 ? 422 : 409)).toBeNull();
  });
  it('rejects unknown codes, plain text, inherited keys and ambiguous write failures', () => {
    for (const code of [
      'write-unconfirmed',
      'deadline-exceeded',
      'invalid-report',
      'cancelled',
      'server-stopped',
      'constructor',
      'PRIVATE_DIAGNOSTIC',
      { code: 'stale-state' },
      null,
      undefined,
    ])
      expect(createSessionTaintRefusal(code, 409)).toBeNull();
    expect(createSessionTaintRefusal(SESSION_TAINT_ERROR_MESSAGES['stale-state'], 409)).toBeNull();
    expect(createSessionTaintRefusal('stale-state', 200)).toBeNull();
  });
});
