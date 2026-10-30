import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';

describe('finite MCP call-control audit evidence', () => {
  it('projects fixed evidence fields and drops malformed evidence without retaining private extras', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stroq-call-audit-'));
    try {
      const file = join(root, 'audit.jsonl');
      const log = new AuditLog(file);
      const evidence = {
        controlId: '11111111-2222-4333-8444-555555555555',
        eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        invocationSha256: 'a'.repeat(64),
        authoritySha256: 'b'.repeat(64),
        reason: 'paused' as const,
      };
      const entry = await log.append({
        sessionId: 's',
        phase: 'pre',
        tool: 'mcp',
        summary: 'held',
        mcpCallControl: { ...evidence, environment: 'PRIVATE_VALUE' } as typeof evidence,
      });
      expect(entry.mcpCallControl).toEqual(evidence);
      for (const changed of [
        { reason: 'PRIVATE_REASON' },
        { reason: { toString: () => 'paused', private: 'PRIVATE_VALUE' } },
        { controlId: '../x' },
        { eventId: null },
        { authoritySha256: null },
        { invocationSha256: 'bad' },
      ]) {
        const invalid = await log.append({
          sessionId: 's',
          phase: 'pre',
          tool: 'mcp',
          summary: 'held',
          mcpCallControl: { ...evidence, ...changed } as typeof evidence,
        });
        expect(invalid).not.toHaveProperty('mcpCallControl');
      }
      expect(await readFile(file, 'utf8')).not.toMatch(/PRIVATE_VALUE|PRIVATE_REASON/);
      expect(
        (
          await log.append({
            sessionId: 's',
            phase: 'pre',
            tool: 'mcp',
            summary: 'held',
            mcpCallControl: {
              ...evidence,
              reason: 'unavailable',
              eventId: null,
              authoritySha256: null,
            },
          })
        ).mcpCallControl,
      ).toMatchObject({ reason: 'unavailable', eventId: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
