import { type KeyObject, createPublicKey, sign } from 'node:crypto';
import { z } from 'zod';
import { canonicalEscalationBytes } from './canonical.js';
import { type EnvelopeProblem, openEnvelope } from './envelope.js';
import { keyIdOf } from './keys.js';
import { sameText, windowProblem } from './permit.js';
import {
  Hex64Schema,
  KeyIdSchema,
  NonceSchema,
  SignatureSchema,
  TASK_ID_PATTERN,
  TimestampSchema,
} from './types.js';

/**
 * An escalation: a person's signed "yes, this once" for ONE refused operation, made with
 * `stroq permit extend` outside the agent. It can only narrow what the gate refuses, never
 * widen what the permit grants: it names a fingerprint, so it covers exactly the operation
 * that was refused, for a few minutes, once. It is signed like a permit, over a domain line of
 * its own, so a signature made for one can never be read as the other.
 */

export const MAX_ESCALATION_BYTES = 16 * 1024;
export const DEFAULT_ESCALATION_TTL_MS = 5 * 60_000;
export const MAX_ESCALATION_TTL_MS = 10 * 60_000;

export const EscalationBodySchema = z.strictObject({
  v: z.literal(1),
  taskId: z.string().regex(TASK_ID_PATTERN),
  nonce: NonceSchema,
  fingerprint: Hex64Schema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});

export const SignedEscalationSchema = z.strictObject({
  body: EscalationBodySchema,
  keyId: KeyIdSchema,
  sig: SignatureSchema,
});

export type EscalationBody = z.infer<typeof EscalationBodySchema>;
export type SignedEscalation = z.infer<typeof SignedEscalationSchema>;

export interface EscalationContext {
  readonly now: Date;
  readonly nonce: string;
  readonly taskId: string;
  /** The operation being refused: the escalation must have been made for this one. */
  readonly fingerprint: string;
}

export type EscalationRejection =
  EnvelopeProblem | 'nonce' | 'task-id' | 'fingerprint' | 'expired' | 'not-yet-valid' | 'lifetime';

export type EscalationResult =
  | { readonly ok: true; readonly body: EscalationBody }
  | { readonly ok: false; readonly reason: EscalationRejection };

export function newEscalationBody(input: {
  readonly taskId: string;
  readonly nonce: string;
  readonly fingerprint: string;
  readonly now: Date;
  readonly ttlMs?: number;
}): EscalationBody {
  const ttlMs = input.ttlMs ?? DEFAULT_ESCALATION_TTL_MS;
  if (!(ttlMs > 0 && ttlMs <= MAX_ESCALATION_TTL_MS)) {
    throw new RangeError('an escalation lasts more than 0 and at most 10 minutes');
  }
  return {
    v: 1,
    taskId: input.taskId,
    nonce: input.nonce,
    fingerprint: input.fingerprint,
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + ttlMs).toISOString(),
  };
}

/** Signs a body as it is given, like `signPermit`: the check is made where the escalation is read. */
export function signEscalation(body: EscalationBody, privateKey: KeyObject): SignedEscalation {
  const sig = sign(null, canonicalEscalationBytes(body), privateKey).toString('base64url');
  return { body, keyId: keyIdOf(createPublicKey(privateKey)), sig };
}

/** Whether `input` is an escalation this key signed, for this launch, task and operation, now. Never throws. */
export function verifyEscalation(
  input: unknown,
  publicKey: KeyObject,
  ctx: EscalationContext,
): EscalationResult {
  try {
    const opened = openEnvelope(input, publicKey, {
      maxBytes: MAX_ESCALATION_BYTES,
      schema: SignedEscalationSchema,
      bytesOf: canonicalEscalationBytes,
    });
    if (!opened.ok) return opened;
    const { body } = opened.signed;
    if (!sameText(body.nonce, ctx.nonce)) return { ok: false, reason: 'nonce' };
    if (!sameText(body.taskId, ctx.taskId)) return { ok: false, reason: 'task-id' };
    if (!sameText(body.fingerprint, ctx.fingerprint)) return { ok: false, reason: 'fingerprint' };
    const timed = windowProblem(body, ctx.now.getTime(), MAX_ESCALATION_TTL_MS);
    return timed === null ? { ok: true, body } : { ok: false, reason: timed };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
