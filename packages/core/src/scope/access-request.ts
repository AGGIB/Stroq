import { type KeyObject, createPublicKey, sign } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../audit/audit-log.js';
import { type EnvelopeProblem, openEnvelope } from './envelope.js';
import { keyIdOf } from './keys.js';
import { sameText, windowProblem } from './permit.js';
import {
  Hex64Schema,
  KeyIdSchema,
  SignatureSchema,
  TASK_ID_PATTERN,
  TimestampSchema,
  isCanonicalIso,
} from './types.js';

export const TASK_ACCESS_REQUEST_DOMAIN = 'stroq-task-access-request-v1\n';
export const MAX_TASK_ACCESS_REQUEST_BYTES = 16 * 1024;
export const MAX_TASK_ACCESS_REQUEST_TTL_MS = 10 * 60_000;
export const MAX_TASK_ACCESS_REVIEW_BYTES = 64 * 1024;

/** A signed refusal is evidence for a human decision, never an authorization token. */
export const TaskAccessRequestBodySchema = z
  .strictObject({
    v: z.literal(1),
    taskId: z.string().regex(TASK_ID_PATTERN),
    permitBodySha256: Hex64Schema,
    fingerprint: Hex64Schema,
    fingerprintKind: z.enum(['read-target', 'whole-call']),
    requiredFingerprints: z.array(Hex64Schema).min(1).max(16),
    reviewSha256: Hex64Schema,
    sessionSha256: Hex64Schema,
    callIdSha256: Hex64Schema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .superRefine((body, ctx) => {
    if (
      new Set(body.requiredFingerprints).size !== body.requiredFingerprints.length ||
      !body.requiredFingerprints.includes(body.fingerprint)
    )
      ctx.addIssue({ code: 'custom', message: 'invalid required fingerprints' });
  });
export const SignedTaskAccessRequestSchema = z.strictObject({
  body: TaskAccessRequestBodySchema,
  keyId: KeyIdSchema,
  sig: SignatureSchema,
});
export type TaskAccessRequestBody = z.infer<typeof TaskAccessRequestBodySchema>;
export type SignedTaskAccessRequest = z.infer<typeof SignedTaskAccessRequestSchema>;
export type TaskAccessRequestSigner = (body: TaskAccessRequestBody) => SignedTaskAccessRequest;
type BoundFields = Omit<TaskAccessRequestBody, 'v' | 'issuedAt' | 'expiresAt'>;
export interface TaskAccessRequestContext extends BoundFields {
  readonly now: Date;
  readonly permitExpiresAt: string;
}
export type TaskAccessRequestRejection =
  EnvelopeProblem | 'context' | 'expired' | 'not-yet-valid' | 'lifetime' | 'permit-expiry';

export function canonicalTaskAccessRequestBytes(body: unknown): Uint8Array {
  return new TextEncoder().encode(`${TASK_ACCESS_REQUEST_DOMAIN}${stableStringify(body)}`);
}

export function newTaskAccessRequestBody(input: TaskAccessRequestContext): TaskAccessRequestBody {
  const { now, permitExpiresAt, ...fields } = input;
  const expires = Math.min(
    now.getTime() + MAX_TASK_ACCESS_REQUEST_TTL_MS,
    Date.parse(permitExpiresAt),
  );
  if (!isCanonicalIso(permitExpiresAt) || !(expires > now.getTime()))
    throw new RangeError('task access request has no valid lifetime');
  return TaskAccessRequestBodySchema.parse({
    ...fields,
    v: 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(expires).toISOString(),
  });
}

export function signTaskAccessRequest(
  body: TaskAccessRequestBody,
  privateKey: KeyObject,
): SignedTaskAccessRequest {
  return {
    body,
    keyId: keyIdOf(createPublicKey(privateKey)),
    sig: sign(null, canonicalTaskAccessRequestBytes(body), privateKey).toString('base64url'),
  };
}

export function verifyTaskAccessRequest(
  input: unknown,
  publicKey: KeyObject,
  ctx: TaskAccessRequestContext,
):
  | { readonly ok: true; readonly body: TaskAccessRequestBody }
  | { readonly ok: false; readonly reason: TaskAccessRequestRejection } {
  try {
    const opened = openEnvelope(input, publicKey, {
      maxBytes: MAX_TASK_ACCESS_REQUEST_BYTES,
      schema: SignedTaskAccessRequestSchema,
      bytesOf: canonicalTaskAccessRequestBytes,
    });
    if (!opened.ok) return opened;
    const { body } = opened.signed;
    const fields = [
      'taskId',
      'permitBodySha256',
      'fingerprint',
      'fingerprintKind',
      'reviewSha256',
      'sessionSha256',
      'callIdSha256',
    ] as const;
    if (
      fields.some((field) => !sameText(body[field], ctx[field])) ||
      !sameText(
        stableStringify(body.requiredFingerprints),
        stableStringify(ctx.requiredFingerprints),
      )
    )
      return { ok: false, reason: 'context' };
    const timed = windowProblem(body, ctx.now.getTime(), MAX_TASK_ACCESS_REQUEST_TTL_MS);
    if (timed !== null) return { ok: false, reason: timed };
    if (
      !isCanonicalIso(ctx.permitExpiresAt) ||
      Date.parse(body.expiresAt) > Date.parse(ctx.permitExpiresAt)
    )
      return { ok: false, reason: 'permit-expiry' };
    return { ok: true, body };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
