import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, FileSessionStore } from '@stroq/core';
import { runWhy } from '../../src/commands/why.js';
import { auditFile, sessionsDir } from '../../src/paths.js';

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-why-'));
});

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

const allow = { effect: 'allow' as const, ruleId: null, reason: 'default' };

async function seed(): Promise<void> {
  const log = new AuditLog(auditFile());
  await log.append({ sessionId: 's', phase: 'pre', tool: 'Bash', summary: 'ls', decision: allow });
  await log.append({
    sessionId: 's',
    phase: 'pre',
    tool: 'Bash',
    summary: 'npx @evil/pkg',
    classes: ['origin.untrusted', 'origin.suspect'],
    decision: { effect: 'deny', ruleId: 'deny-origin-suspect', reason: 'blocked' },
    provenance: [
      {
        kind: 'pkg',
        excerpt: '@evil/pkg',
        tool: 'Read',
        source: 'README.md',
        at: '2026-09-04T10:00:00.000Z',
        suspect: true,
      },
    ],
  });
  await log.append({ sessionId: 's', phase: 'pre', tool: 'Bash', summary: 'ls', decision: allow });
  await new FileSessionStore(sessionsDir()).markSuspect('s', {
    tool: 'Read',
    ruleIds: ['STROQ-2026-00001'],
    at: '2026-09-04T10:00:00.000Z',
  });
}

describe('stroq why', () => {
  it('explains the most recent denied or asked action with provenance and taint', async () => {
    await seed();
    const out = capture();
    expect(await runWhy([])).toBe(0);
    out.restore();
    const text = out.lines.join('');
    expect(text).toContain('#2');
    expect(text).toContain('verdict: deny by deny-origin-suspect: blocked');
    expect(text).toMatch(/because: "@evil\/pkg" appeared in the output of Read \(README\.md\)/);
    expect(text).toContain('Stroq flagged that content as suspicious');
    expect(text).toContain('taint:   suspect since ');
    expect(text).toContain('Read: STROQ-2026-00001');
  });

  it('explains a specific entry by seq, with a plain fallback when no provenance was involved', async () => {
    await seed();
    await new FileSessionStore(sessionsDir()).clear('s');
    const out = capture();
    expect(await runWhy(['--seq', '1'])).toBe(0);
    out.restore();
    const text = out.lines.join('');
    expect(text).toContain('#1');
    expect(text).toContain(
      'because: the action itself matches the rule; no untrusted content was involved',
    );
    expect(text).toContain('taint:   none');
  });

  it('fails when there is nothing to explain', async () => {
    let out = capture();
    expect(await runWhy([])).toBe(1);
    out.restore();
    expect(out.lines.join('')).toContain('no denied or asked action');
    await seed();
    out = capture();
    expect(await runWhy(['--seq', '9'])).toBe(1);
    out.restore();
    expect(out.lines.join('')).toContain('no audit entry with seq 9');
  });
});
