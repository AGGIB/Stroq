import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSessionStore, type TaintSource } from '@stroq/core';
import { runUntaint } from '../../src/commands/untaint.js';
import { sessionsDir } from '../../src/paths.js';

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-untaint-'));
});

const src: TaintSource = {
  tool: 'Read',
  ruleIds: ['STROQ-2026-00001'],
  at: '2026-09-04T00:00:00.000Z',
};

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('stroq untaint', () => {
  it('clears one session with --session', async () => {
    const store = new FileSessionStore(sessionsDir());
    await store.markSuspect('s1', src);
    expect((await store.get('s1')).taint).not.toBeNull();

    expect(await runUntaint(['--session', 's1'])).toBe(0);

    expect((await store.get('s1')).taint).toBeNull();
  });

  it('clears every session with --all', async () => {
    const store = new FileSessionStore(sessionsDir());
    await store.markSuspect('s1', src);
    await store.markSuspect('s2', src);

    expect(await runUntaint(['--all'])).toBe(0);

    expect((await store.get('s1')).taint).toBeNull();
    expect((await store.get('s2')).taint).toBeNull();
  });

  it('--all is a no-op when the sessions dir does not exist yet', async () => {
    expect(existsSync(sessionsDir())).toBe(false);
    expect(await runUntaint(['--all'])).toBe(0);
  });

  it('prints usage and exits 1 when neither flag is given', async () => {
    const out = capture();
    expect(await runUntaint([])).toBe(1);
    out.restore();
    expect(out.lines.join('')).toContain('usage');
  });
});
