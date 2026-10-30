import { SESSION_TAINT_ERROR_MESSAGES } from './session-taint';

const REFUSAL_STATUS = {
  'stale-state': 409,
  'stale-evidence': 409,
  'not-tainted': 422,
  'preview-expired': 409,
  'preview-unavailable': 409,
  'recovery-full': 422,
  'recovery-required': 422,
  'session-busy': 409,
} as const;
type RefusalCode = keyof typeof REFUSAL_STATUS;
export class SessionTaintRefusal extends Error {
  private constructor(
    readonly code: RefusalCode,
    readonly status: number,
  ) {
    super(SESSION_TAINT_ERROR_MESSAGES[code]);
    this.name = 'SessionTaintRefusal';
  }
  static create(code: unknown, status: number): SessionTaintRefusal | null {
    if (
      typeof code !== 'string' ||
      !Object.hasOwn(REFUSAL_STATUS, code) ||
      REFUSAL_STATUS[code as RefusalCode] !== status
    )
      return null;
    return new SessionTaintRefusal(code as RefusalCode, status);
  }
}
export function createSessionTaintRefusal(
  code: unknown,
  status: number,
): SessionTaintRefusal | null {
  return SessionTaintRefusal.create(code, status);
}
