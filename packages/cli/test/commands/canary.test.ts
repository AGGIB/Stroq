import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCanary } from '../../src/commands/canary.js';
import { secretsFile } from '../../src/paths.js';

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-canary-'));
});

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('stroq canary', () => {
  it('prints a fresh canary line and records only its hash', async () => {
    const out = capture();
    expect(await runCanary([])).toBe(0);
    out.restore();
    const text = out.lines.join('');
    const m = /STROQ_CANARY_KEY=(stroq_canary_[A-Za-z0-9]{32})/.exec(text);
    expect(m).not.toBeNull();
    const raw = readFileSync(secretsFile(), 'utf8');
    expect(raw).not.toContain(m![1]);
    expect(raw).toContain('"canary":true');
    expect(text).toContain('.env');
  });

  it('accepts a custom name', async () => {
    const out = capture();
    expect(await runCanary(['--name', 'FAKE_STRIPE_KEY'])).toBe(0);
    out.restore();
    expect(out.lines.join('')).toMatch(/FAKE_STRIPE_KEY=stroq_canary_/);
  });
});
