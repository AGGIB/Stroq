import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESCALATION_TTL_MS,
  MAX_ESCALATION_BYTES,
  MAX_ESCALATION_TTL_MS,
  type EscalationBody,
  newEscalationBody,
  signEscalation,
  verifyEscalation,
} from '../../src/scope/escalation.js';
import { generateKeyPair } from '../../src/scope/keys.js';
import { signPermit, verifyPermit } from '../../src/scope/permit.js';
import { MINUTE, NOW, NONCE, iso, rawOf, sampleBody, testKeys } from './helpers.js';

const keys = testKeys();
const FP = 'ab'.repeat(32);

const body = (over: Partial<EscalationBody> = {}): EscalationBody => ({
  v: 1,
  taskId: 'fix-login-1',
  nonce: NONCE,
  fingerprint: FP,
  issuedAt: iso(NOW.getTime() - MINUTE),
  expiresAt: iso(NOW.getTime() + 4 * MINUTE),
  ...over,
});
const ctx = (over: Record<string, unknown> = {}) => ({
  now: NOW,
  nonce: NONCE,
  taskId: 'fix-login-1',
  fingerprint: FP,
  ...over,
});
const reasonOf = (input: unknown, c = ctx()): string | null => {
  const result = verifyEscalation(input, keys.publicKey, c);
  return result.ok ? null : result.reason;
};

describe('escalation lifetimes', () => {
  it('defaults to 5 minutes and allows at most 10', () => {
    expect(DEFAULT_ESCALATION_TTL_MS).toBe(5 * MINUTE);
    expect(MAX_ESCALATION_TTL_MS).toBe(10 * MINUTE);
  });

  it('makes a body that lasts 5 minutes from now unless told otherwise', () => {
    const made = newEscalationBody({
      taskId: 'fix-login-1',
      nonce: NONCE,
      fingerprint: FP,
      now: NOW,
    });
    expect(made).toEqual({
      v: 1,
      taskId: 'fix-login-1',
      nonce: NONCE,
      fingerprint: FP,
      issuedAt: NOW.toISOString(),
      expiresAt: iso(NOW.getTime() + 5 * MINUTE),
    });
  });

  it('honours a shorter or longer wish up to the cap, and refuses one beyond it or that is not positive', () => {
    const at = (ttlMs: number) =>
      newEscalationBody({ taskId: 't', nonce: NONCE, fingerprint: FP, now: NOW, ttlMs });
    expect(at(MINUTE).expiresAt).toBe(iso(NOW.getTime() + MINUTE));
    expect(at(MAX_ESCALATION_TTL_MS).expiresAt).toBe(iso(NOW.getTime() + 10 * MINUTE));
    expect(() => at(MAX_ESCALATION_TTL_MS + 1)).toThrow(RangeError);
    expect(() => at(0)).toThrow(RangeError);
    expect(() => at(-1)).toThrow(RangeError);
    expect(() => at(Number.NaN)).toThrow(RangeError);
  });
});

describe('verifyEscalation', () => {
  it('accepts a good escalation, as text, bytes or object, and returns its body', () => {
    const signed = signEscalation(body(), keys.privateKey);
    for (const input of [rawOf(signed), Buffer.from(rawOf(signed)), signed]) {
      const result = verifyEscalation(input, keys.publicKey, ctx());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.body).toEqual(body());
    }
  });

  it('rejects a body or signature with one bit flipped', () => {
    const signed = signEscalation(body(), keys.privateKey);
    const flippedBody = {
      ...signed,
      body: { ...signed.body, fingerprint: `${'ab'.repeat(31)}ac` },
    };
    expect(reasonOf(rawOf(flippedBody), ctx({ fingerprint: `${'ab'.repeat(31)}ac` }))).toBe(
      'signature',
    );
    const sig = Buffer.from(signed.sig, 'base64url');
    sig[10] = (sig[10] as number) ^ 1;
    expect(reasonOf(rawOf({ ...signed, sig: sig.toString('base64url') }))).toBe('signature');
  });

  it('rejects an escalation made by another key, and a truncated or empty one', () => {
    const other = signEscalation(body(), generateKeyPair().privateKey);
    expect(reasonOf(rawOf(other))).toBe('key-id');
    const raw = rawOf(signEscalation(body(), keys.privateKey));
    expect(reasonOf(raw.slice(0, raw.length - 3))).toBe('malformed');
    expect(reasonOf('')).toBe('malformed');
  });

  it('is not fooled by a permit passed off as an escalation, or the other way round', () => {
    expect(reasonOf(rawOf(signPermit(sampleBody(), keys.privateKey)))).toBe('schema');
    const escalation = rawOf(signEscalation(body(), keys.privateKey));
    const asPermit = verifyPermit(escalation, keys.publicKey, {
      now: NOW,
      nonce: NONCE,
      projectRoot: '/work/project',
      policyDigest: 'a'.repeat(64),
      stateDigests: {},
    });
    expect(asPermit).toEqual({ ok: false, reason: 'schema' });
  });

  it('rejects unknown keys, duplicate keys and prototype keys', () => {
    const signed = signEscalation(body(), keys.privateKey);
    const raw = rawOf(signed);
    expect(reasonOf(rawOf({ ...signed, extra: 1 }))).toBe('schema');
    expect(reasonOf(rawOf({ ...signed, body: { ...signed.body, extra: 1 } }))).toBe('schema');
    expect(reasonOf(raw.replace('"v":1', '"v":1,"v":1'))).toBe('malformed');
    expect(reasonOf(raw.replace('"body":{', '"body":{"__proto__":{},'))).toBe('malformed');
  });

  it('refuses text over its size cap', () => {
    const raw = rawOf(signEscalation(body(), keys.privateKey));
    expect(MAX_ESCALATION_BYTES).toBe(16 * 1024);
    expect(reasonOf(raw + ' '.repeat(MAX_ESCALATION_BYTES))).toBe('oversize');
    expect(reasonOf(raw + ' '.repeat(MAX_ESCALATION_BYTES - Buffer.byteLength(raw)))).toBeNull();
  });

  it('is bound to its nonce, its task and its fingerprint', () => {
    const raw = rawOf(signEscalation(body(), keys.privateKey));
    expect(reasonOf(raw, ctx({ nonce: `${NONCE}x` }))).toBe('nonce');
    expect(reasonOf(raw, ctx({ taskId: 'other-task' }))).toBe('task-id');
    expect(reasonOf(raw, ctx({ fingerprint: 'cd'.repeat(32) }))).toBe('fingerprint');
  });

  it('expires at the instant it names, to the millisecond', () => {
    const expiresAt = NOW.getTime() + 4 * MINUTE;
    const raw = rawOf(signEscalation(body({ expiresAt: iso(expiresAt) }), keys.privateKey));
    expect(reasonOf(raw, ctx({ now: new Date(expiresAt - 1) }))).toBeNull();
    expect(reasonOf(raw, ctx({ now: new Date(expiresAt) }))).toBe('expired');
  });

  it('allows a 10 minute lifetime and not a millisecond more', () => {
    const issuedAt = NOW.getTime() - MINUTE;
    const lasting = (ms: number) =>
      rawOf(
        signEscalation(
          body({ issuedAt: iso(issuedAt), expiresAt: iso(issuedAt + ms) }),
          keys.privateKey,
        ),
      );
    expect(reasonOf(lasting(MAX_ESCALATION_TTL_MS))).toBeNull();
    expect(reasonOf(lasting(MAX_ESCALATION_TTL_MS + 1))).toBe('lifetime');
    expect(reasonOf(lasting(60 * MINUTE))).toBe('lifetime');
  });

  it('rejects one issued in the future beyond the clock skew, and one that ends before it begins', () => {
    const future = signEscalation(
      body({ issuedAt: iso(NOW.getTime() + 61_000), expiresAt: iso(NOW.getTime() + 5 * MINUTE) }),
      keys.privateKey,
    );
    expect(reasonOf(rawOf(future))).toBe('not-yet-valid');
    const backwards = signEscalation(
      body({ issuedAt: iso(NOW.getTime() + 1000), expiresAt: iso(NOW.getTime() + 500) }),
      keys.privateKey,
    );
    expect(reasonOf(rawOf(backwards))).toBe('lifetime');
  });

  it('never throws', () => {
    for (const input of [null, undefined, 7, {}, [], Symbol('x'), 10n]) {
      expect(() => verifyEscalation(input, keys.publicKey, ctx())).not.toThrow();
    }
  });
});
