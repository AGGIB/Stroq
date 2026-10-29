import { describe, expect, it } from 'vitest';
import {
  MAX_TASK_ACCESS_REQUEST_TTL_MS,
  newTaskAccessRequestBody,
  signTaskAccessRequest,
  verifyTaskAccessRequest,
  type TaskAccessRequestBody,
} from '../../src/scope/access-request.js';
import { signEscalation } from '../../src/scope/escalation.js';
import { signPermit } from '../../src/scope/permit.js';
import { generateKeyPair } from '../../src/scope/keys.js';
import { MINUTE, NOW, NONCE, iso, sampleBody, testKeys } from './helpers.js';

const keys = testKeys();
const fields = {
  taskId: 'fix-login-1',
  permitBodySha256: 'a'.repeat(64),
  fingerprint: 'b'.repeat(64),
  fingerprintKind: 'whole-call' as const,
  requiredFingerprints: ['b'.repeat(64), 'c'.repeat(64)],
  reviewSha256: 'd'.repeat(64),
  sessionSha256: 'e'.repeat(64),
  callIdSha256: 'f'.repeat(64),
};
const context = { ...fields, now: NOW, permitExpiresAt: iso(NOW.getTime() + 20 * MINUTE) };
const body = (): TaskAccessRequestBody => newTaskAccessRequestBody(context);
const reason = (input: unknown, over: Partial<typeof context> = {}) => {
  const result = verifyTaskAccessRequest(input, keys.publicKey, { ...context, ...over });
  return result.ok ? null : result.reason;
};

describe('signed task access requests', () => {
  it('binds every finite field and limits fresh requests to ten minutes or permit expiry', () => {
    expect(MAX_TASK_ACCESS_REQUEST_TTL_MS).toBe(10 * MINUTE);
    expect(body()).toEqual({
      v: 1,
      ...fields,
      issuedAt: NOW.toISOString(),
      expiresAt: iso(NOW.getTime() + 10 * MINUTE),
    });
    expect(
      newTaskAccessRequestBody({ ...context, permitExpiresAt: iso(NOW.getTime() + MINUTE) })
        .expiresAt,
    ).toBe(iso(NOW.getTime() + MINUTE));
    expect(() =>
      newTaskAccessRequestBody({ ...context, permitExpiresAt: NOW.toISOString() }),
    ).toThrow();
  });

  it('authenticates equivalent JSON spellings without accepting tampering', () => {
    const signed = signTaskAccessRequest(body(), keys.privateKey);
    for (const input of [
      signed,
      JSON.stringify(signed, null, 2),
      Buffer.from(JSON.stringify(signed)),
    ])
      expect(verifyTaskAccessRequest(input, keys.publicKey, context)).toEqual({
        ok: true,
        body: body(),
      });
    expect(reason({ ...signed, body: { ...signed.body, reviewSha256: '0'.repeat(64) } })).toBe(
      'signature',
    );
    expect(reason(signTaskAccessRequest(body(), generateKeyPair().privateKey))).toBe('key-id');
  });

  it.each([
    'taskId',
    'permitBodySha256',
    'fingerprint',
    'fingerprintKind',
    'reviewSha256',
    'sessionSha256',
    'callIdSha256',
  ] as const)('rejects context drift in %s', (field) => {
    const value =
      field === 'taskId'
        ? 'other-task'
        : field === 'fingerprintKind'
          ? 'read-target'
          : '0'.repeat(64);
    expect(
      reason(signTaskAccessRequest(body(), keys.privateKey), { [field]: value }),
    ).not.toBeNull();
  });

  it('requires the same unique ordered requirement list, including the selected fingerprint', () => {
    const signed = signTaskAccessRequest(body(), keys.privateKey);
    expect(
      reason(signed, { requiredFingerprints: [...fields.requiredFingerprints].reverse() }),
    ).not.toBeNull();
    for (const requiredFingerprints of [
      [],
      [fields.fingerprint, fields.fingerprint],
      ['c'.repeat(64)],
      Array.from({ length: 17 }, (_, n) => n.toString(16).padStart(64, '0')),
    ])
      expect(
        reason(signTaskAccessRequest({ ...body(), requiredFingerprints }, keys.privateKey)),
      ).not.toBeNull();
  });

  it('rejects expiry, future time beyond core skew, overlong lifetime and permit expiry overrun', () => {
    const signed = signTaskAccessRequest(body(), keys.privateKey);
    expect(reason(signed, { now: new Date(signed.body.expiresAt) })).toBe('expired');
    expect(reason(signed, { now: new Date(NOW.getTime() - MINUTE - 1) })).toBe('not-yet-valid');
    expect(
      reason(
        signTaskAccessRequest(
          { ...body(), expiresAt: iso(NOW.getTime() + 10 * MINUTE + 1) },
          keys.privateKey,
        ),
      ),
    ).toBe('lifetime');
    expect(reason(signed, { permitExpiresAt: iso(NOW.getTime() + MINUTE) })).toBe('permit-expiry');
  });

  it('rejects unknown keys, duplicate JSON keys, malformed UTF8 and alternate signature domains', () => {
    const signed = signTaskAccessRequest(body(), keys.privateKey);
    expect(reason({ ...signed, private: 'unexpected' })).toBe('schema');
    expect(reason({ ...signed, body: { ...signed.body, private: 'unexpected' } })).toBe('schema');
    const text = JSON.stringify(signed).replace('"v":1', '"v":1,"v":1');
    expect(reason(text)).toBe('malformed');
    expect(reason(Buffer.from([0xff]))).toBe('malformed');
    expect(reason(signPermit(sampleBody(), keys.privateKey))).not.toBeNull();
    expect(
      reason(
        signEscalation(
          {
            v: 1,
            taskId: fields.taskId,
            nonce: NONCE,
            fingerprint: fields.fingerprint,
            issuedAt: body().issuedAt,
            expiresAt: body().expiresAt,
          },
          keys.privateKey,
        ),
      ),
    ).not.toBeNull();
  });
});
