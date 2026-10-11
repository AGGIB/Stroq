import { createHash } from 'node:crypto';
import { stableStringify } from '../audit/audit-log.js';

/**
 * The bytes a permit is signed over: a domain line, then the body with its keys in sorted
 * order. The domain line means a signature made for one kind of document can never verify as
 * another (an escalation has a line of its own), and the sorted keys mean the bytes do not
 * depend on how a writer happened to order them.
 */
export const PERMIT_DOMAIN = 'stroq-permit-v1\n';
export const ESCALATION_DOMAIN = 'stroq-escalation-v1\n';

const encode = (domain: string, body: unknown): Uint8Array =>
  new TextEncoder().encode(`${domain}${stableStringify(body)}`);

export function canonicalBytes(body: unknown): Uint8Array {
  return encode(PERMIT_DOMAIN, body);
}

export function canonicalEscalationBytes(body: unknown): Uint8Array {
  return encode(ESCALATION_DOMAIN, body);
}

/** The sha256, in lower-case hex, of the bytes a permit body is signed over. */
export function digestOf(body: unknown): string {
  return createHash('sha256').update(canonicalBytes(body)).digest('hex');
}
