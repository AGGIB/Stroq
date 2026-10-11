import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '../../src/scope/canonical.js';
import { generateKeyPair, keyIdOf } from '../../src/scope/keys.js';
import {
  CLOCK_SKEW_MS,
  MAX_LIFETIME_MS,
  MAX_PERMIT_BYTES,
  signPermit,
  verifyPermit,
} from '../../src/scope/permit.js';
import type { PermitBody, SignedPermit } from '../../src/scope/types.js';
import {
  HOUR,
  MINUTE,
  NOW,
  NONCE,
  PROJECT,
  SESSION,
  iso,
  rawOf,
  sampleBody,
  testKeys,
  verifyContext,
} from './helpers.js';

const keys = testKeys();
const signed = (over: Partial<PermitBody> = {}): SignedPermit =>
  signPermit(sampleBody(over), keys.privateKey);
const verify = (input: unknown, ctx = verifyContext()) =>
  verifyPermit(input as never, keys.publicKey, ctx as never);
const reasonOf = (input: unknown, ctx = verifyContext()): string | null => {
  const result = verify(input, ctx);
  return result.ok ? null : result.reason;
};

describe('signPermit', () => {
  it('signs with the key id of the signing key and a 64-byte base64url signature', () => {
    const permit = signed();
    expect(permit.keyId).toBe(keyIdOf(keys.publicKey));
    expect(permit.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(permit.body).toEqual(sampleBody());
  });

  it('signs the canonical bytes: the same body signed twice gives the same signature', () => {
    expect(signed().sig).toBe(signed().sig);
  });

  it('does not change the body it was given', () => {
    const body = sampleBody();
    const before = JSON.stringify(body);
    signPermit(body, keys.privateKey);
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe('verifyPermit: a good permit', () => {
  it('verifies from its text, from bytes and from an object, and returns the body', () => {
    const permit = signed();
    for (const input of [rawOf(permit), Buffer.from(rawOf(permit)), permit]) {
      const result = verify(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.body).toEqual(sampleBody());
    }
  });

  it('verifies a permit with no session id whatever session the call comes from', () => {
    const { sessionId: _drop, ...rest } = sampleBody();
    const permit = signPermit(rest, keys.privateKey);
    expect(verify(rawOf(permit), verifyContext({ sessionId: 'any-session' })).ok).toBe(true);
    expect(verify(rawOf(permit), verifyContext({ sessionId: undefined })).ok).toBe(true);
  });
});

describe('verifyPermit: forgery', () => {
  it('rejects a body with one bit flipped in any string field', () => {
    const permit = signed();
    const raw = JSON.parse(rawOf(permit)) as { body: Record<string, unknown> };
    const flipLast = (text: string): string =>
      text.slice(0, -1) + String.fromCharCode(text.charCodeAt(text.length - 1) ^ 1);
    const flips: Array<(body: Record<string, any>) => void> = [
      (b) => (b.taskId = flipLast(b.taskId)),
      (b) => (b.nonce = flipLast(b.nonce)),
      (b) => (b.profile = flipLast(b.profile)),
      (b) => (b.projectRoot = flipLast(b.projectRoot)),
      (b) => (b.sessionId = flipLast(b.sessionId)),
      (b) => (b.policyDigest = flipLast(b.policyDigest)),
      (b) => (b.screenDigest = flipLast(b.screenDigest)),
      (b) => (b.scope.tools[0] = flipLast(b.scope.tools[0])),
      (b) => (b.scope.write.allow[0] = flipLast(b.scope.write.allow[0])),
      (b) => (b.scope.shell = 'denied'),
      (b) => (b.scope.net = { mode: 'hosts', hosts: ['evil.example.com'] }),
      (b) => (b.expiresAt = iso(Date.parse(b.expiresAt) + 1)),
    ];
    for (const flip of flips) {
      const copy = structuredClone(raw);
      flip(copy.body);
      const result = verify(JSON.stringify(copy), verifyContext());
      expect(result.ok).toBe(false);
    }
  });

  it('reports a body that was changed to something well-formed as a bad signature', () => {
    const copy = JSON.parse(rawOf(signed())) as { body: { scope: { shell: string } } };
    copy.body.scope.shell = 'denied';
    expect(reasonOf(JSON.stringify(copy))).toBe('signature');
  });

  it('rejects a signature with any one bit flipped', () => {
    const permit = signed();
    const bytes = Buffer.from(permit.sig, 'base64url');
    for (const index of [0, 1, 7, 31, 32, 62, 63]) {
      for (const bit of [0, 3, 7]) {
        const flipped = Buffer.from(bytes);
        flipped[index] = (flipped[index] as number) ^ (1 << bit);
        const forged = { ...permit, sig: flipped.toString('base64url') };
        expect(reasonOf(rawOf(forged))).toBe('signature');
      }
    }
  });

  it('rejects a signature spelled differently from how it is written (non-canonical base64url)', () => {
    const permit = signed();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = permit.sig.slice(-1);
    // The last character holds 4 bits of signature and 2 spare bits; a lenient decoder drops them.
    const sibling = alphabet[
      (alphabet.indexOf(last) & ~3) | ((alphabet.indexOf(last) + 1) & 3)
    ] as string;
    const twin = { ...permit, sig: permit.sig.slice(0, -1) + sibling };
    expect(Buffer.from(twin.sig, 'base64url').equals(Buffer.from(permit.sig, 'base64url'))).toBe(
      true,
    );
    expect(reasonOf(rawOf(twin))).toBe('signature');
  });

  it('rejects a permit signed by a different key', () => {
    const other = generateKeyPair();
    const forged = signPermit(sampleBody(), other.privateKey);
    expect(reasonOf(rawOf(forged))).toBe('key-id');
  });

  it('rejects a different key that claims the right key id, on the signature', () => {
    const other = generateKeyPair();
    const forged = {
      ...signPermit(sampleBody(), other.privateKey),
      keyId: keyIdOf(keys.publicKey),
    };
    expect(reasonOf(rawOf(forged))).toBe('signature');
  });

  it('rejects a wrong key id even when the signature is good', () => {
    const permit = signed();
    expect(reasonOf(rawOf({ ...permit, keyId: '0123456789abcdef' }))).toBe('key-id');
  });

  it('rejects a permit signed over some other domain (a permit is not an escalation)', () => {
    const body = sampleBody();
    const wrongDomain = sign(
      null,
      Buffer.concat([
        Buffer.from('stroq-escalation-v1\n'),
        Buffer.from(canonicalBytes(body)).subarray(16),
      ]),
      keys.privateKey,
    ).toString('base64url');
    expect(reasonOf(rawOf({ body, keyId: keyIdOf(keys.publicKey), sig: wrongDomain }))).toBe(
      'signature',
    );
  });

  it('rejects a permit that was truncated, at any length short of the whole', () => {
    const raw = rawOf(signed());
    for (const length of [0, 1, 10, Math.floor(raw.length / 2), raw.length - 5, raw.length - 1]) {
      const result = verify(raw.slice(0, length));
      expect(result.ok).toBe(false);
    }
    expect(reasonOf(raw.slice(0, raw.length - 1))).toBe('malformed');
  });

  it('rejects empty input and input that is not JSON', () => {
    expect(reasonOf('')).toBe('malformed');
    expect(reasonOf('not json')).toBe('malformed');
    expect(reasonOf(Buffer.from([0xff, 0xfe, 0x00]))).toBe('malformed');
    expect(reasonOf(undefined)).toBe('malformed');
  });

  it('rejects JSON that is not a permit: null, a number, an array, an empty object', () => {
    for (const input of ['null', '7', '[]', '{}', '"x"']) expect(reasonOf(input)).toBe('schema');
  });

  it('rejects a permit with a key it does not know, signed or not', () => {
    const permit = signed();
    expect(reasonOf(rawOf({ ...permit, extra: 1 }))).toBe('schema');
    expect(reasonOf(rawOf({ ...permit, body: { ...permit.body, extra: 1 } }))).toBe('schema');
  });

  it('rejects a body key that is __proto__, constructor or prototype, at any depth', () => {
    const raw = rawOf(signed());
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(reasonOf(raw.replace('{"body":{', `{"body":{"${key}":{},`))).toBe('malformed');
      expect(reasonOf(raw.replace('"scope":{', `"scope":{"${key}":1,`))).toBe('malformed');
      expect(reasonOf(raw.replace('"net":{', `"net":{"${key}":1,`))).toBe('malformed');
      expect(reasonOf(`{"${key}":1,${raw.slice(1)}`)).toBe('malformed');
    }
  });

  it('rejects an own __proto__ key on an object passed in, which JSON.parse would have made', () => {
    const permit = JSON.parse(`{"__proto__":{"x":1},${rawOf(signed()).slice(1)}`) as unknown;
    expect(reasonOf(permit)).toBe('malformed');
  });

  it('rejects duplicate keys, in the envelope and in the body', () => {
    const permit = signed();
    const raw = rawOf(permit);
    expect(
      reasonOf(
        raw.replace(
          `"keyId":"${permit.keyId}"`,
          `"keyId":"${permit.keyId}","keyId":"${permit.keyId}"`,
        ),
      ),
    ).toBe('malformed');
    expect(reasonOf(raw.replace('"v":1', '"v":1,"v":1'))).toBe('malformed');
    expect(reasonOf(raw.replace('"shell":"allowed"', '"shell":"allowed","shell":"denied"'))).toBe(
      'malformed',
    );
  });

  it('rejects a duplicate body whose last copy is the genuine one (JSON.parse would keep that)', () => {
    const permit = signed();
    const evil = sampleBody({
      scope: { ...sampleBody().scope, shell: 'allowed', tools: ['Bash', 'WebFetch'] },
    });
    const raw = `{"body":${JSON.stringify(evil)},"body":${JSON.stringify(permit.body)},"keyId":"${permit.keyId}","sig":"${permit.sig}"}`;
    expect(JSON.parse(raw).body).toEqual(permit.body);
    expect(reasonOf(raw)).toBe('malformed');
  });

  it('refuses text over 64 KiB, and accepts a good permit padded to exactly 64 KiB', () => {
    const raw = rawOf(signed());
    const padTo = (bytes: number): string => raw + ' '.repeat(bytes - Buffer.byteLength(raw));
    expect(MAX_PERMIT_BYTES).toBe(64 * 1024);
    expect(verify(padTo(MAX_PERMIT_BYTES)).ok).toBe(true);
    expect(reasonOf(padTo(MAX_PERMIT_BYTES + 1))).toBe('oversize');
    expect(reasonOf(Buffer.from(padTo(MAX_PERMIT_BYTES + 1)))).toBe('oversize');
    expect(reasonOf('x'.repeat(10 * MAX_PERMIT_BYTES))).toBe('oversize');
  });

  it('counts bytes and not characters when it measures the size', () => {
    const raw = rawOf(signed());
    // Each é is two bytes: the text is under the limit in characters and over it in bytes.
    const chars = MAX_PERMIT_BYTES - Buffer.byteLength(raw) + 1;
    const padded = `${raw}${'é'.repeat(Math.ceil(chars / 2) + 1)}`;
    expect(padded.length).toBeLessThanOrEqual(MAX_PERMIT_BYTES);
    expect(Buffer.byteLength(padded)).toBeGreaterThan(MAX_PERMIT_BYTES);
    expect(reasonOf(padded)).toBe('oversize');
  });
});

describe('verifyPermit: replay and reuse', () => {
  it('rejects a permit made for another nonce (another launch of the same task)', () => {
    expect(reasonOf(rawOf(signed()), verifyContext({ nonce: `${NONCE}x` }))).toBe('nonce');
    expect(reasonOf(rawOf(signed()), verifyContext({ nonce: '' }))).toBe('nonce');
    expect(reasonOf(rawOf(signed()), verifyContext({ nonce: undefined }))).toBe('nonce');
  });

  it('rejects a permit for another task id when the caller says which task it is', () => {
    expect(reasonOf(rawOf(signed()), verifyContext({ taskId: 'other-task' }))).toBe('task-id');
    expect(verify(rawOf(signed()), verifyContext({ taskId: 'fix-login-1' })).ok).toBe(true);
  });

  it('rejects a permit for another project root', () => {
    expect(reasonOf(rawOf(signed()), verifyContext({ projectRoot: `${PROJECT}-other` }))).toBe(
      'project-root',
    );
    expect(reasonOf(rawOf(signed()), verifyContext({ projectRoot: `${PROJECT}/` }))).toBe(
      'project-root',
    );
  });

  it('rejects a permit for another session, and one the caller names no session for', () => {
    expect(reasonOf(rawOf(signed()), verifyContext({ sessionId: `${SESSION}-b` }))).toBe('session');
    expect(reasonOf(rawOf(signed()), verifyContext({ sessionId: undefined }))).toBe('session');
  });

  it('rejects a changed policy digest', () => {
    expect(reasonOf(rawOf(signed()), verifyContext({ policyDigest: 'f'.repeat(64) }))).toBe(
      'policy-digest',
    );
  });

  it('rejects any change to the state digests: a changed value, a missing name, an extra name', () => {
    const changed = { 'policy.yaml': 'e'.repeat(64), 'secrets.json': 'c'.repeat(64) };
    const missing = { 'policy.yaml': 'b'.repeat(64) };
    const extra = {
      'policy.yaml': 'b'.repeat(64),
      'secrets.json': 'c'.repeat(64),
      'more.json': 'a'.repeat(64),
    };
    for (const stateDigests of [changed, missing, extra, {}]) {
      expect(reasonOf(rawOf(signed()), verifyContext({ stateDigests }))).toBe('state-digest');
    }
  });

  it('treats the expiry to the millisecond: valid until the instant it names, not at it', () => {
    const expiresAt = NOW.getTime() + 5 * MINUTE;
    const permit = rawOf(signed({ expiresAt: iso(expiresAt) }));
    expect(verify(permit, verifyContext({ now: new Date(expiresAt - 1) })).ok).toBe(true);
    expect(reasonOf(permit, verifyContext({ now: new Date(expiresAt) }))).toBe('expired');
    expect(reasonOf(permit, verifyContext({ now: new Date(expiresAt + 1) }))).toBe('expired');
  });

  it('allows an issue time up to 60 s ahead of the clock, and not a millisecond more', () => {
    expect(CLOCK_SKEW_MS).toBe(60_000);
    const ahead = (ms: number): string =>
      rawOf(
        signed({ issuedAt: iso(NOW.getTime() + ms), expiresAt: iso(NOW.getTime() + ms + MINUTE) }),
      );
    expect(verify(ahead(CLOCK_SKEW_MS)).ok).toBe(true);
    expect(reasonOf(ahead(CLOCK_SKEW_MS + 1))).toBe('not-yet-valid');
  });

  it('caps the lifetime at 24 hours, to the millisecond', () => {
    expect(MAX_LIFETIME_MS).toBe(24 * HOUR);
    const issuedAt = NOW.getTime() - MINUTE;
    const lasting = (ms: number): string =>
      rawOf(signed({ issuedAt: iso(issuedAt), expiresAt: iso(issuedAt + ms) }));
    expect(verify(lasting(MAX_LIFETIME_MS), verifyContext({ now: NOW })).ok).toBe(true);
    expect(reasonOf(lasting(MAX_LIFETIME_MS + 1))).toBe('lifetime');
    expect(reasonOf(lasting(7 * 24 * HOUR))).toBe('lifetime');
  });

  it('rejects a permit that ends before it begins', () => {
    const permit = rawOf(
      signed({ issuedAt: iso(NOW.getTime() + 10_000), expiresAt: iso(NOW.getTime() + 5_000) }),
    );
    expect(reasonOf(permit)).toBe('lifetime');
  });
});

describe('verifyPermit: the order of the checks', () => {
  const stale = (over: Partial<PermitBody>): string => rawOf(signed(over));
  const everythingWrong = verifyContext({
    nonce: 'z'.repeat(32),
    now: new Date(NOW.getTime() + 10 * HOUR),
    projectRoot: '/elsewhere',
    sessionId: 'elsewhere',
    policyDigest: 'f'.repeat(64),
    stateDigests: {},
  });

  it('answers with the first failing check, never a later one', () => {
    expect(reasonOf(stale({}), everythingWrong)).toBe('nonce');
    const { nonce: _n, ...noNonce } = everythingWrong;
    expect(reasonOf(stale({}), { ...noNonce, nonce: NONCE })).toBe('expired');
    expect(reasonOf(stale({}), { ...noNonce, nonce: NONCE, now: NOW })).toBe('project-root');
    expect(reasonOf(stale({}), { ...noNonce, nonce: NONCE, now: NOW, projectRoot: PROJECT })).toBe(
      'session',
    );
    expect(
      reasonOf(stale({}), {
        ...noNonce,
        nonce: NONCE,
        now: NOW,
        projectRoot: PROJECT,
        sessionId: SESSION,
      }),
    ).toBe('policy-digest');
    expect(
      reasonOf(stale({}), {
        ...noNonce,
        nonce: NONCE,
        now: NOW,
        projectRoot: PROJECT,
        sessionId: SESSION,
        policyDigest: sampleBody().policyDigest,
      }),
    ).toBe('state-digest');
  });

  it('checks size before parsing, parsing before the schema, the schema before the key id, the key id before the signature', () => {
    expect(reasonOf(`{${' '.repeat(MAX_PERMIT_BYTES)}`)).toBe('oversize');
    expect(reasonOf('{"body":')).toBe('malformed');
    expect(reasonOf('{"body":{}}')).toBe('schema');
    const otherKey = generateKeyPair();
    const wrongKeyAndSig = signPermit(sampleBody(), otherKey.privateKey);
    expect(reasonOf(rawOf(wrongKeyAndSig))).toBe('key-id');
    const wrongSig = { ...signed(), sig: 'A'.repeat(86) };
    expect(reasonOf(rawOf(wrongSig))).toBe('signature');
  });

  it('checks the signature before the nonce: a forged permit with a wrong nonce is a forgery', () => {
    const copy = JSON.parse(rawOf(signed())) as { body: { taskId: string } };
    copy.body.taskId = 'changed';
    expect(reasonOf(JSON.stringify(copy), verifyContext({ nonce: 'q'.repeat(32) }))).toBe(
      'signature',
    );
  });
});

describe('verifyPermit: it never throws', () => {
  it('survives odd inputs and odd keys', () => {
    for (const input of [null, undefined, 0, NaN, Symbol('x'), () => 1, [], {}, new Date(), 10n]) {
      expect(() => verify(input)).not.toThrow();
      expect(verify(input).ok).toBe(false);
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const result = verifyPermit(rawOf(signed()), rsa.publicKey, verifyContext() as never);
    expect(result.ok).toBe(false);
  });

  it('does not let the context throw either', () => {
    const hostile = { ...verifyContext(), stateDigests: null };
    expect(() => verify(rawOf(signed()), hostile as never)).not.toThrow();
    expect(verify(rawOf(signed()), hostile as never).ok).toBe(false);
  });
});
