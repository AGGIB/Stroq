import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, FileCloakStore, FileSecretIndex, createCloakDetector } from '@stroq/core';
import { auditFile, cloakDir, secretsFile } from '../paths.js';
import { McpCloak } from './cloak.js';
import type { McpContext } from './judge.js';

/**
 * Wiring the cloak to this machine: the real secret index, the real audit log, and
 * one dictionary file per (session, server).
 *
 * **Per SERVER, deliberately.** The session is shared across a client's servers so
 * that a poisoned result from server A taints the calls that go to server B — that is
 * the point of it. A reversible dictionary must not be shared the same way: a
 * placeholder minted from server A's data, echoed by the model into a call to server
 * B, would then be restored and server B would receive data it never had. Splitting
 * the dictionary makes that impossible by construction — B has simply never heard of
 * the placeholder, so the literal text travels instead, which is the harmless answer.
 */

/**
 * `sha256(session \n server)`, truncated the same way `sessionKey` truncates, so a
 * dictionary file names neither the session nor the server on a shared filesystem.
 * The pair is hashed with a separator so that `("a", "bc")` and `("ab", "c")` cannot
 * collide onto one dictionary.
 */
export const cloakKey = (sessionId: string, server: string): string =>
  createHash('sha256').update(`${sessionId}\n${server}`).digest('hex').slice(0, 16);

export function createMcpCloak(ctx: McpContext): McpCloak {
  return new McpCloak({
    detector: createCloakDetector({
      secrets: new FileSecretIndex(secretsFile(), homedir(), process.env),
      cwd: ctx.cwd,
    }),
    store: new FileCloakStore(join(cloakDir(), `${cloakKey(ctx.sessionId, ctx.server)}.json`)),
    audit: new AuditLog(auditFile()),
    sessionId: ctx.sessionId,
  });
}
