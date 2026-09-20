import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit-log.js';

const log = () => new AuditLog(join(mkdtempSync(join(tmpdir(), 'stroq-audit-cloak-')), 'a.jsonl'));

describe('audit entries carrying cloak substitutions', () => {
  it('records the kind and the placeholder, and keeps them inside the hash chain', async () => {
    const audit = log();
    await audit.append({
      sessionId: 's1',
      phase: 'post',
      tool: 'mcp__crm__get_customer',
      summary: 'mcp cloak: 2 values replaced in a tools/call result',
      cloak: [
        { direction: 'cloak', kind: 'email', placeholder: '[STROQ_EMAIL_1]', count: 2 },
        { direction: 'cloak', kind: 'secret', placeholder: '[STROQ_SECRET_2]', count: 1 },
      ],
    });
    const entry = (await audit.readAll()).at(-1)!;
    expect(entry.cloak).toEqual([
      { direction: 'cloak', kind: 'email', placeholder: '[STROQ_EMAIL_1]', count: 2 },
      { direction: 'cloak', kind: 'secret', placeholder: '[STROQ_SECRET_2]', count: 1 },
    ]);
    expect(await audit.verify()).toMatchObject({ ok: true, count: 1 });
  });

  it('breaks the chain when a recorded substitution is edited afterwards', async () => {
    const audit = log();
    await audit.append({
      sessionId: 's1',
      phase: 'pre',
      tool: 'mcp__crm__send',
      summary: 'mcp uncloak: 1 placeholder restored',
      cloak: [{ direction: 'uncloak', kind: 'email', placeholder: '[STROQ_EMAIL_1]', count: 1 }],
    });
    const entries = await audit.readAll();
    const tampered = {
      ...entries[0]!,
      cloak: [
        { direction: 'uncloak' as const, kind: 'email', placeholder: '[STROQ_EMAIL_9]', count: 1 },
      ],
    };
    const { hashEntry } = await import('../src/audit/audit-log.js');
    const { hash: _ignored, ...rest } = tampered;
    expect(hashEntry(rest)).not.toBe(entries[0]!.hash);
  });
});
