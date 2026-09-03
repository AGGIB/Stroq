import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '@stroq/core';
import { formatEntry, runLog } from '../../src/commands/log.js';
import { runVerify } from '../../src/commands/verify.js';
import { auditFile } from '../../src/paths.js';

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-log-'));
});

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('log and verify', () => {
  it('formats entries and prints the last N', async () => {
    const log = new AuditLog(auditFile());
    for (let i = 1; i <= 3; i += 1) {
      await log.append({
        sessionId: 's',
        phase: 'pre',
        tool: 'Bash',
        summary: `cmd ${i}`,
        classes: ['shell.network'],
        decision: { effect: 'deny', ruleId: 'r', reason: 'x' },
      });
    }
    const entry = (await log.readAll())[0]!;
    expect(formatEntry(entry)).toMatch(
      /pre\s+Bash\s+\[s\]\s+deny\(r\)\s+\[shell\.network\]\s+cmd 1/,
    );
    const out = capture();
    expect(await runLog(['--count', '2'])).toBe(0);
    out.restore();
    expect(out.lines.join('')).toContain('cmd 3');
    expect(out.lines.join('')).not.toContain('cmd 1');
  });

  it('clamps --count 0 to 1, and falls back to 20 for a non-numeric value', async () => {
    const log = new AuditLog(auditFile());
    for (let i = 1; i <= 3; i += 1) {
      await log.append({ sessionId: 's', phase: 'pre', tool: 'Bash', summary: `cmd ${i}` });
    }
    let out = capture();
    expect(await runLog(['--count', '0'])).toBe(0);
    out.restore();
    const zeroOutput = out.lines.filter((l) => l.trim().length > 0);
    expect(zeroOutput).toHaveLength(1);
    expect(zeroOutput[0]).toContain('cmd 3');

    out = capture();
    expect(await runLog(['--count', 'abc'])).toBe(0);
    out.restore();
    const abcOutput = out.lines.join('');
    expect(abcOutput).toContain('cmd 1');
    expect(abcOutput).toContain('cmd 2');
    expect(abcOutput).toContain('cmd 3');
  });

  it('verify reports OK and BROKEN', async () => {
    const log = new AuditLog(auditFile());
    await log.append({
      sessionId: 's',
      phase: 'post',
      tool: 'Read',
      summary: 'x',
      scan: { verdict: 'clean', score: 0, ruleIds: [] },
    });
    let out = capture();
    expect(await runVerify()).toBe(0);
    out.restore();
    expect(out.lines.join('')).toContain('OK');
    writeFileSync(auditFile(), '{"seq":1,"hash":"bad","prevHash":"bad"}\n');
    out = capture();
    expect(await runVerify()).toBe(1);
    out.restore();
    expect(out.lines.join('')).toContain('BROKEN');
  });
});
