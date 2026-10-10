import { describe, expect, it } from 'vitest';
import {
  PermitBodySchema,
  SignedPermitSchema,
  TASK_ID_PATTERN,
  TaskScopeSchema,
  isTaskId,
} from '../../src/scope/types.js';
import { sampleBody, sampleScope } from './helpers.js';

const parses = (value: unknown): boolean => PermitBodySchema.safeParse(value).success;
const bodyWith = (patch: Record<string, unknown>): unknown => ({ ...sampleBody(), ...patch });

describe('PermitBodySchema', () => {
  it('accepts a complete body, with and without a session id', () => {
    expect(parses(sampleBody())).toBe(true);
    const { sessionId: _dropped, ...withoutSession } = sampleBody();
    expect(parses(withoutSession)).toBe(true);
  });

  it('rejects an unknown key at the top level', () => {
    expect(parses(bodyWith({ extra: true }))).toBe(false);
  });

  it('rejects an unknown key at every nested level', () => {
    const scope = sampleScope({ mcp: [{ server: 'docs', tools: '*' }] });
    expect(parses(bodyWith({ scope: { ...scope, extra: 1 } }))).toBe(false);
    expect(parses(bodyWith({ scope: { ...scope, read: { ...scope.read, extra: 1 } } }))).toBe(
      false,
    );
    expect(parses(bodyWith({ scope: { ...scope, net: { mode: 'none', extra: 1 } } }))).toBe(false);
    expect(
      parses(bodyWith({ scope: { ...scope, mcp: [{ server: 'docs', tools: '*', extra: 1 }] } })),
    ).toBe(false);
  });

  it('rejects a version other than 1 and a host other than claude-code', () => {
    expect(parses(bodyWith({ v: 2 }))).toBe(false);
    expect(parses(bodyWith({ host: 'cursor' }))).toBe(false);
  });

  it.each(['', 'A', '-a', 'a b', 'a/b', '..', 'a\\b', 'a'.repeat(65), 'é', 'a\0b'])(
    'rejects the task id %j',
    (taskId) => {
      expect(parses(bodyWith({ taskId }))).toBe(false);
    },
  );

  it.each(['2026-10-10', '2026-10-10T12:00:00Z', '2026-10-10T12:00:00.000+00:00', 'now', '1', ''])(
    'rejects the timestamp %j, which is not the exact form Date#toISOString writes',
    (stamp) => {
      expect(parses(bodyWith({ issuedAt: stamp }))).toBe(false);
      expect(parses(bodyWith({ expiresAt: stamp }))).toBe(false);
    },
  );

  it('rejects a day that does not exist, which a lenient parser would move', () => {
    expect(parses(bodyWith({ expiresAt: '2026-02-31T00:00:00.000Z' }))).toBe(false);
  });

  it('rejects digests that are not 64 lower-case hex characters', () => {
    expect(parses(bodyWith({ policyDigest: 'A'.repeat(64) }))).toBe(false);
    expect(parses(bodyWith({ policyDigest: 'a'.repeat(63) }))).toBe(false);
    expect(parses(bodyWith({ screenDigest: 'g'.repeat(64) }))).toBe(false);
    expect(parses(bodyWith({ stateDigests: { 'policy.yaml': 'xyz' } }))).toBe(false);
  });

  it('rejects state digest names that are not plain file labels', () => {
    expect(parses(bodyWith({ stateDigests: { '../x': 'a'.repeat(64) } }))).toBe(false);
    expect(parses(bodyWith({ stateDigests: { '': 'a'.repeat(64) } }))).toBe(false);
  });

  it('rejects a nonce that is short or not URL-safe', () => {
    expect(parses(bodyWith({ nonce: 'short' }))).toBe(false);
    expect(parses(bodyWith({ nonce: `${'a'.repeat(20)} ${'b'.repeat(20)}` }))).toBe(false);
  });

  it('rejects a project root that is empty or holds a NUL', () => {
    expect(parses(bodyWith({ projectRoot: '' }))).toBe(false);
    expect(parses(bodyWith({ projectRoot: '/work\0/x' }))).toBe(false);
  });
});

describe('TaskScopeSchema', () => {
  const scopeParses = (value: unknown): boolean => TaskScopeSchema.safeParse(value).success;

  it('accepts hosts mode and a listed MCP server', () => {
    expect(
      scopeParses(
        sampleScope({
          net: { mode: 'hosts', hosts: ['api.example.com', '*.example.org'] },
          mcp: [{ server: 'docs', tools: ['search', 'fetch_page'] }],
        }),
      ),
    ).toBe(true);
  });

  it('rejects a glob that is not absolute: a relative glob has no anchor', () => {
    expect(scopeParses(sampleScope({ read: { allow: ['src/**'], deny: [] } }))).toBe(false);
    expect(scopeParses(sampleScope({ write: { allow: [], deny: ['**/.env'] } }))).toBe(false);
  });

  it.each(['/p/../x/**', '/p/./x', '/p/x/..', 'C:/p/../x', 'C:\\p\\..\\x', '/..'])(
    'rejects the glob %j, which climbs or loops: a glob is matched as written, not resolved',
    (glob) => {
      expect(scopeParses(sampleScope({ read: { allow: [], deny: [glob] } }))).toBe(false);
      expect(scopeParses(sampleScope({ write: { allow: [glob], deny: [] } }))).toBe(false);
    },
  );

  it('accepts a glob with dots inside names, which are ordinary', () => {
    expect(
      scopeParses(sampleScope({ read: { allow: ['/p/.env*', '/p/a..b/**', '/p/...'], deny: [] } })),
    ).toBe(true);
  });

  it('accepts absolute globs in both flavours', () => {
    expect(
      scopeParses(sampleScope({ read: { allow: ['C:/proj/**', 'D:\\proj\\**'], deny: [] } })),
    ).toBe(true);
  });

  it.each([
    ['an empty host', ''],
    ['a scheme', 'https://example.com'],
    ['a port', 'example.com:443'],
    ['a path', 'example.com/x'],
    ['upper case', 'Example.com'],
    ['a bare star', '*'],
    ['a star in the middle', 'a.*.com'],
    ['a leading dot', '.example.com'],
    ['a label starting with a hyphen', '-a.example.com'],
    ['an empty label', 'a..com'],
  ])('rejects a host pattern with %s', (_name, host) => {
    expect(scopeParses(sampleScope({ net: { mode: 'hosts', hosts: [host] } }))).toBe(false);
  });

  it('rejects hosts mode without hosts and none mode with them', () => {
    expect(scopeParses({ ...sampleScope(), net: { mode: 'hosts' } })).toBe(false);
    expect(scopeParses({ ...sampleScope(), net: { mode: 'none', hosts: ['a.com'] } })).toBe(false);
  });

  it('rejects a shell value outside the two words', () => {
    expect(scopeParses({ ...sampleScope(), shell: 'maybe' })).toBe(false);
  });

  it('rejects tool names that are not plain names (no wildcards, no spaces)', () => {
    expect(scopeParses(sampleScope({ tools: ['*'] }))).toBe(false);
    expect(scopeParses(sampleScope({ tools: ['Re ad'] }))).toBe(false);
  });
});

describe('SignedPermitSchema', () => {
  const sig = 'A'.repeat(86);
  const signed = { body: sampleBody(), keyId: '0123456789abcdef', sig };

  it('accepts the three fields and nothing else', () => {
    expect(SignedPermitSchema.safeParse(signed).success).toBe(true);
    expect(SignedPermitSchema.safeParse({ ...signed, extra: 1 }).success).toBe(false);
  });

  it('rejects a key id or signature of the wrong shape', () => {
    expect(SignedPermitSchema.safeParse({ ...signed, keyId: '0123' }).success).toBe(false);
    expect(SignedPermitSchema.safeParse({ ...signed, keyId: 'ABCDEF0123456789' }).success).toBe(
      false,
    );
    expect(SignedPermitSchema.safeParse({ ...signed, sig: 'A'.repeat(85) }).success).toBe(false);
    expect(SignedPermitSchema.safeParse({ ...signed, sig: `${'A'.repeat(85)}=` }).success).toBe(
      false,
    );
  });
});

describe('task ids', () => {
  it('has one pattern, and isTaskId agrees with it', () => {
    expect(TASK_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
    expect(isTaskId('fix-login-1')).toBe(true);
    expect(isTaskId('a')).toBe(true);
    expect(isTaskId('a'.repeat(64))).toBe(true);
    expect(isTaskId('a'.repeat(65))).toBe(false);
    expect(isTaskId('../etc')).toBe(false);
    expect(isTaskId(undefined)).toBe(false);
    expect(isTaskId(7)).toBe(false);
  });
});
