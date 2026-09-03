import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AuditLog,
  GENESIS_HASH,
  hashEntry,
  redact,
  stableStringify,
} from '../../src/audit/audit-log.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'stroq-audit-')), 'audit.jsonl');
const input = (i: number) => ({
  sessionId: 's',
  phase: 'pre' as const,
  tool: 'Bash',
  summary: `cmd ${i}`,
});

describe('stableStringify', () => {
  it('sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('redact', () => {
  it.each([
    ['token sk-abcdefghijklmnop123456', 'token [REDACTED]'],
    ['key AKIAIOSFODNN7EXAMPLE', 'key [REDACTED]'],
    ['ghp_abcdefghijklmnopqrstuvwxyz1234', '[REDACTED]'],
    ['-----BEGIN RSA PRIVATE KEY-----', '[REDACTED]'],
    ['plain text', 'plain text'],
  ])('%s → %s', (raw, expected) => expect(redact(raw)).toBe(expected));
});

describe('AuditLog', () => {
  it('chains entries from the genesis hash', async () => {
    const log = new AuditLog(fresh());
    const a = await log.append(input(1));
    const b = await log.append(input(2));
    expect(a.seq).toBe(1);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(b.hash).toBe(hashEntry({ ...b, hash: undefined } as never));
  });
  it('reads an empty log from a missing file', async () => {
    expect(await new AuditLog(fresh()).readAll()).toEqual([]);
    expect(await new AuditLog(fresh()).verify()).toEqual({ ok: true, count: 0, brokenAt: null });
  });
  it('verifies an intact chain and detects tampering', async () => {
    const file = fresh();
    const log = new AuditLog(file);
    for (let i = 1; i <= 3; i += 1) await log.append(input(i));
    expect(await log.verify()).toEqual({ ok: true, count: 3, brokenAt: null });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    lines[1] = lines[1]!.replace('cmd 2', 'cmd X');
    writeFileSync(file, lines.join('\n') + '\n');
    expect(await log.verify()).toEqual({ ok: false, count: 3, brokenAt: 2 });
  });
  it('redacts secrets and truncates long summaries', async () => {
    const log = new AuditLog(fresh());
    const entry = await log.append({
      ...input(1),
      summary: 'x'.repeat(500) + ' sk-abcdefghijklmnop123456',
    });
    expect(entry.summary.length).toBeLessThanOrEqual(300);
    expect(entry.summary).not.toContain('sk-abcdef');
  });
  it('keeps the chain intact under concurrent appends', async () => {
    const log = new AuditLog(fresh());
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(input(i))));
    expect(await log.verify()).toMatchObject({ ok: true, count: 20 });
  });
});
