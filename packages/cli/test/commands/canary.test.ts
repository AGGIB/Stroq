import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canaryValue, runCanary } from '../../src/commands/canary.js';
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

  it('falls back to the default name when --name is empty or blank', async () => {
    const out = capture();
    expect(await runCanary(['--name', ''])).toBe(0);
    out.restore();
    expect(out.lines.join('')).toMatch(/^STROQ_CANARY_KEY=stroq_canary_/);
  });

  // Each character used to be `byte % 62`. 256 is not a multiple of 62, so A–H came up
  // 5 times in 256 and every other character 4 times. 2,000 canaries are 64,000
  // characters: a uniform draw puts about 8,258 of them in A–H, with a standard
  // deviation of about 85, and the modulo draw put about 10,000 there. The bound is six
  // standard deviations, which a uniform generator exceeds about twice in a billion runs.
  it('draws every character of the value uniformly from its alphabet', () => {
    const chars = Array.from({ length: 2000 }, () =>
      canaryValue().slice('stroq_canary_'.length),
    ).join('');
    const inFirstEight = [...chars].filter((c) => 'ABCDEFGH'.includes(c)).length;
    const p = 8 / 62;
    const expected = chars.length * p;
    const sd = Math.sqrt(chars.length * p * (1 - p));
    expect(Math.abs(inFirstEight - expected)).toBeLessThan(6 * sd);
  });
});
