import { type KeyObject, verify } from 'node:crypto';
import type { ZodType } from 'zod';
import { keyIdOf } from './keys.js';
import { parseStrictJson } from './strict-json.js';

/**
 * The part of reading a signed document that does not depend on what the document says:
 * the size cap, the strict parse, the schema, the key id and the signature, in that order.
 * A permit and an escalation both go through it, so there is one place where "is this
 * signed by the key we trust" is decided, and it is the same place for both.
 */

export type EnvelopeProblem = 'oversize' | 'malformed' | 'schema' | 'key-id' | 'signature';

export type Opened<S> =
  | { readonly ok: true; readonly signed: S }
  | { readonly ok: false; readonly reason: EnvelopeProblem };

export interface EnvelopeSpec<S extends { body: unknown; keyId: string; sig: string }> {
  readonly maxBytes: number;
  readonly schema: ZodType<S>;
  /** The bytes the signature must cover for a body of this kind (carries the domain line). */
  readonly bytesOf: (body: S['body']) => Uint8Array;
}

type Text =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'oversize' | 'malformed' };

const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The text of an input that is raw bytes, a string, or an already-parsed value, measured in
 * BYTES before anything else is done with it: the cap is on what a file can make this code
 * read, so it comes first and costs nothing.
 */
function textOf(input: unknown, maxBytes: number): Text {
  if (input instanceof Uint8Array) {
    if (input.length > maxBytes) return { ok: false, reason: 'oversize' };
    try {
      return { ok: true, text: FATAL_UTF8.decode(input) };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }
  let text: unknown = input;
  if (typeof input !== 'string') {
    try {
      text = JSON.stringify(input);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof text !== 'string') return { ok: false, reason: 'malformed' };
  }
  if (Buffer.byteLength(text as string, 'utf8') > maxBytes)
    return { ok: false, reason: 'oversize' };
  return { ok: true, text: text as string };
}

/** A signature is 64 bytes, and only the one spelling `Buffer#toString('base64url')` writes. */
function signatureBytes(sig: string): Buffer | null {
  const bytes = Buffer.from(sig, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === sig ? bytes : null;
}

export function openEnvelope<S extends { body: unknown; keyId: string; sig: string }>(
  input: unknown,
  publicKey: KeyObject,
  spec: EnvelopeSpec<S>,
): Opened<S> {
  const text = textOf(input, spec.maxBytes);
  if (!text.ok) return text;
  const parsed = parseStrictJson(text.text);
  if (!parsed.ok) return { ok: false, reason: 'malformed' };
  const shaped = spec.schema.safeParse(parsed.value);
  if (!shaped.success) return { ok: false, reason: 'schema' };
  const signed = shaped.data;
  try {
    if (signed.keyId !== keyIdOf(publicKey)) return { ok: false, reason: 'key-id' };
    const sig = signatureBytes(signed.sig);
    // The body checked is the body returned: the schema's own output, not a second reading.
    if (sig === null || !verify(null, spec.bytesOf(signed.body), publicKey, sig)) {
      return { ok: false, reason: 'signature' };
    }
  } catch {
    return { ok: false, reason: 'key-id' };
  }
  return { ok: true, signed };
}
