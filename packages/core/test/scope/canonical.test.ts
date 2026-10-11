import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../src/audit/audit-log.js';
import {
  ESCALATION_DOMAIN,
  PERMIT_DOMAIN,
  canonicalBytes,
  canonicalEscalationBytes,
  digestOf,
} from '../../src/scope/canonical.js';
import { sampleBody } from './helpers.js';

describe('canonicalBytes', () => {
  it('is the UTF-8 of the domain line followed by the stable JSON of the body', () => {
    const body = sampleBody();
    const expected = Buffer.from(`stroq-permit-v1\n${stableStringify(body)}`, 'utf8');
    expect(PERMIT_DOMAIN).toBe('stroq-permit-v1\n');
    expect(Buffer.from(canonicalBytes(body)).equals(expected)).toBe(true);
  });

  it('does not depend on the order the keys were written in', () => {
    const a = { x: 1, y: { b: 2, a: 1 } };
    const b = { y: { a: 1, b: 2 }, x: 1 };
    expect(
      Buffer.from(canonicalBytes(a as never)).equals(Buffer.from(canonicalBytes(b as never))),
    ).toBe(true);
  });

  it('treats an absent optional field and one set to undefined alike', () => {
    const { sessionId: _drop, ...without } = sampleBody();
    const withUndefined = { ...without, sessionId: undefined };
    expect(
      Buffer.from(canonicalBytes(without)).equals(Buffer.from(canonicalBytes(withUndefined))),
    ).toBe(true);
  });

  it('changes when any single value changes', () => {
    const base = Buffer.from(canonicalBytes(sampleBody()));
    expect(base.equals(Buffer.from(canonicalBytes(sampleBody({ taskId: 'fix-login-2' }))))).toBe(
      false,
    );
    expect(
      base.equals(Buffer.from(canonicalBytes(sampleBody({ projectRoot: '/work/other' })))),
    ).toBe(false);
  });

  it('encodes non-ASCII text as UTF-8, not as UTF-16 or Latin-1', () => {
    const bytes = Buffer.from(canonicalBytes(sampleBody({ projectRoot: '/work/é' })));
    expect(bytes.includes(Buffer.from('/work/é', 'utf8'))).toBe(true);
  });
});

describe('canonicalEscalationBytes', () => {
  it('uses a domain line of its own, so a permit signature is never an escalation signature', () => {
    expect(ESCALATION_DOMAIN).toBe('stroq-escalation-v1\n');
    expect(ESCALATION_DOMAIN).not.toBe(PERMIT_DOMAIN);
    const body = { v: 1 };
    expect(
      Buffer.from(canonicalEscalationBytes(body)).equals(
        Buffer.from(canonicalBytes(body as never)),
      ),
    ).toBe(false);
  });
});

describe('digestOf', () => {
  it('is the sha256, as lower-case hex, of the canonical bytes', () => {
    const body = sampleBody();
    const expected = createHash('sha256').update(canonicalBytes(body)).digest('hex');
    expect(digestOf(body)).toBe(expected);
    expect(digestOf(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different bodies', () => {
    expect(digestOf(sampleBody())).not.toBe(digestOf(sampleBody({ nonce: 'x'.repeat(30) })));
  });
});
