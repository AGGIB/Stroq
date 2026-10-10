import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, type KeyPair } from '../../src/scope/keys.js';
import type { PermitBody, TaskScope } from '../../src/scope/types.js';

/** A fixed clock, so that expiry is tested to the millisecond and never against the wall clock. */
export const NOW = new Date('2026-10-10T12:00:00.000Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const POLICY_DIGEST = 'a'.repeat(64);
export const STATE_DIGESTS = { 'policy.yaml': 'b'.repeat(64), 'secrets.json': 'c'.repeat(64) };
export const NONCE = 'bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U';
export const PROJECT = '/work/project';
export const SESSION = 'session-0001';

/** A temp directory per call: nothing here reads or writes the real home. */
export const tempDir = (label = 'scope'): string => mkdtempSync(join(tmpdir(), `stroq-${label}-`));

export const iso = (ms: number): string => new Date(ms).toISOString();

export function sampleScope(over: Partial<TaskScope> = {}): TaskScope {
  return {
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    read: { allow: [`${PROJECT}/**`], deny: [`${PROJECT}/**/.env*`] },
    write: { allow: [`${PROJECT}/src/**`, `${PROJECT}/test/**`], deny: [`${PROJECT}/.git/**`] },
    net: { mode: 'none' },
    mcp: [],
    shell: 'allowed',
    ...over,
  };
}

/** A body that verifies against `verifyContext()` at `NOW`; tests change one field at a time. */
export function sampleBody(over: Partial<PermitBody> = {}): PermitBody {
  return {
    v: 1,
    taskId: 'fix-login-1',
    nonce: NONCE,
    host: 'claude-code',
    profile: 'repo-edit-and-test',
    projectRoot: PROJECT,
    sessionId: SESSION,
    issuedAt: iso(NOW.getTime() - MINUTE),
    expiresAt: iso(NOW.getTime() + 30 * MINUTE),
    policyDigest: POLICY_DIGEST,
    stateDigests: { ...STATE_DIGESTS },
    scope: sampleScope(),
    screenDigest: 'd'.repeat(64),
    ...over,
  };
}

export function verifyContext(over: Record<string, unknown> = {}) {
  return {
    now: NOW,
    nonce: NONCE,
    projectRoot: PROJECT,
    sessionId: SESSION,
    policyDigest: POLICY_DIGEST,
    stateDigests: { ...STATE_DIGESTS },
    ...over,
  };
}

let shared: KeyPair | undefined;
/** One generated key pair per test file is enough, and ed25519 generation is cheap. */
export function testKeys(): KeyPair {
  shared ??= generateKeyPair();
  return shared;
}
