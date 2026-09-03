import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  it('renders undefined array elements as null', () => {
    expect(stableStringify([1, undefined, 3])).toBe('[1,null,3]');
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

  it('redacts an Authorization: Bearer header but keeps the scheme', () => {
    const raw = 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456.xyz789"';
    const out = redact(raw);
    expect(out).toContain('Authorization: Bearer [REDACTED]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts curl -u user:pass basic auth entirely', () => {
    const out = redact('curl -u admin:hunter2 https://api.example/x');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('admin');
  });

  it('redacts URL userinfo credentials', () => {
    const out = redact('export DATABASE_URL=postgres://user:s3cr3tpw@db.example/prod');
    expect(out).not.toContain('s3cr3tpw');
    expect(out).toContain('://[REDACTED]@db.example/prod');
  });

  it('redacts an X-Api-Key header value but keeps the label', () => {
    const out = redact('curl -H "X-Api-Key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0"');
    expect(out).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a0');
    expect(out).toContain('X-Api-Key: [REDACTED]');
  });

  it('does not touch an ordinary command', () => {
    expect(redact('ls -la src/components')).toBe('ls -la src/components');
  });

  it('does not redact a 40-char git SHA (pure hex is exempt)', () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    expect(redact(`git show ${sha}`)).toBe(`git show ${sha}`);
  });
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
  it('reports a corrupt line via verify without throwing', async () => {
    const file = fresh();
    const log = new AuditLog(file);
    for (let i = 1; i <= 3; i += 1) await log.append(input(i));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    lines[1] = '{not json';
    writeFileSync(file, lines.join('\n') + '\n');
    expect(await log.verify()).toEqual({ ok: false, count: 3, brokenAt: 2 });
  });
  it('rejects readAll with a corrupt-line error', async () => {
    const file = fresh();
    const log = new AuditLog(file);
    for (let i = 1; i <= 3; i += 1) await log.append(input(i));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    lines[1] = '{not json';
    writeFileSync(file, lines.join('\n') + '\n');
    await expect(log.readAll()).rejects.toThrow(/corrupt audit line 2/);
  });
  it('rejects append with the same corrupt-line error', async () => {
    const file = fresh();
    const log = new AuditLog(file);
    for (let i = 1; i <= 3; i += 1) await log.append(input(i));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    lines[1] = '{not json';
    writeFileSync(file, lines.join('\n') + '\n');
    await expect(log.append(input(4))).rejects.toThrow(/corrupt audit line 2/);
  });
  it('does not detect deletion of the last entry (documented limitation)', async () => {
    const file = fresh();
    const log = new AuditLog(file);
    for (let i = 1; i <= 3; i += 1) await log.append(input(i));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    writeFileSync(file, lines.slice(0, 2).join('\n') + '\n');
    expect(await log.verify()).toEqual({ ok: true, count: 2, brokenAt: null });
  });

  it.skipIf(process.platform === 'win32')(
    'creates a new STROQ_HOME dir with 0700 and audit.jsonl with 0600',
    async () => {
      const home = join(mkdtempSync(join(tmpdir(), 'stroq-audit-')), 'stroq-home');
      const file = join(home, 'audit.jsonl');
      const log = new AuditLog(file);
      await log.append(input(1));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    },
  );
});
