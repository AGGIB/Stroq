import { type KeyObject, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import { canonicalBytes } from './canonical.js';
import { type EnvelopeProblem, openEnvelope } from './envelope.js';
import { keyIdOf } from './keys.js';
import { type PermitBody, type SignedPermit, SignedPermitSchema } from './types.js';

/** A permit is a few kilobytes. A file past this is not read as one. */
export const MAX_PERMIT_BYTES = 64 * 1024;
/** How far ahead of this machine's clock a permit may say it was issued: clocks differ a little. */
export const CLOCK_SKEW_MS = 60_000;
/** The longest a permit can last. A longer wish is a new permit, confirmed again by a person. */
export const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The facts about THIS run that a permit has to agree with. */
export interface VerifyContext {
  readonly now: Date;
  readonly nonce: string;
  readonly projectRoot: string;
  readonly sessionId?: string | undefined;
  readonly policyDigest: string;
  readonly stateDigests: Readonly<Record<string, string>>;
  /** The task whose directory the permit was found in. A copy from another task's directory fails on it. */
  readonly taskId?: string | undefined;
}

export type PermitRejection =
  | EnvelopeProblem
  | 'nonce'
  | 'task-id'
  | 'expired'
  | 'not-yet-valid'
  | 'lifetime'
  | 'project-root'
  | 'session'
  | 'policy-digest'
  | 'state-digest';

export type VerifyResult =
  | { readonly ok: true; readonly body: PermitBody }
  | { readonly ok: false; readonly reason: PermitRejection };

/**
 * Signs a body as it is given. Whether the body is one a hook will accept is for the hook to
 * decide when it reads it back; a signer that second-guessed its input would make the rejection
 * paths impossible to test with a genuine signature, which is the only kind worth testing.
 */
export function signPermit(body: PermitBody, privateKey: KeyObject): SignedPermit {
  const sig = sign(null, canonicalBytes(body), privateKey).toString('base64url');
  return { body, keyId: keyIdOf(createPublicKey(privateKey)), sig };
}

/** Equal strings, compared without stopping at the first difference. Anything else is unequal. */
export function sameText(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameDigests(expected: Readonly<Record<string, string>>, actual: unknown): boolean {
  if (typeof actual !== 'object' || actual === null) return false;
  const have = Object.keys(actual).sort();
  const want = Object.keys(expected).sort();
  if (have.length !== want.length) return false;
  return want.every(
    (name, i) =>
      name === have[i] &&
      sameText(expected[name], Object.getOwnPropertyDescriptor(actual, name)?.value),
  );
}

/**
 * Every comparison below is written so that a value that is not a number (a clock that
 * returned an invalid date) fails the check instead of passing it.
 */
function timeProblem(body: PermitBody, now: number): PermitRejection | null {
  const issuedAt = Date.parse(body.issuedAt);
  const expiresAt = Date.parse(body.expiresAt);
  if (!(expiresAt > now)) return 'expired';
  if (!(issuedAt <= now + CLOCK_SKEW_MS)) return 'not-yet-valid';
  const lifetime = expiresAt - issuedAt;
  if (!(lifetime > 0 && lifetime <= MAX_LIFETIME_MS)) return 'lifetime';
  return null;
}

/**
 * Whether `input` (the text of a permit file, its bytes, or a parsed object) is a permit this
 * key signed, for this run. Returns the first failing reason in a fixed order: size, parse,
 * schema, key id, signature, nonce, task, expiry, project, session, policy, state. The order
 * is part of the contract: a forged permit is reported as a forgery, whatever else is also
 * wrong with it. Never throws.
 */
export function verifyPermit(
  input: unknown,
  publicKey: KeyObject,
  ctx: VerifyContext,
): VerifyResult {
  try {
    const opened = openEnvelope(input, publicKey, {
      maxBytes: MAX_PERMIT_BYTES,
      schema: SignedPermitSchema,
      bytesOf: canonicalBytes,
    });
    if (!opened.ok) return opened;
    const { body } = opened.signed;
    const reason = contextProblem(body, ctx);
    return reason === null ? { ok: true, body } : { ok: false, reason };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function contextProblem(body: PermitBody, ctx: VerifyContext): PermitRejection | null {
  if (!sameText(body.nonce, ctx.nonce)) return 'nonce';
  if (ctx.taskId !== undefined && !sameText(body.taskId, ctx.taskId)) return 'task-id';
  const timed = timeProblem(body, ctx.now.getTime());
  if (timed !== null) return timed;
  if (!sameText(body.projectRoot, ctx.projectRoot)) return 'project-root';
  if (body.sessionId !== undefined && !sameText(body.sessionId, ctx.sessionId)) return 'session';
  if (!sameText(body.policyDigest, ctx.policyDigest)) return 'policy-digest';
  if (!sameDigests(body.stateDigests, ctx.stateDigests)) return 'state-digest';
  return null;
}
