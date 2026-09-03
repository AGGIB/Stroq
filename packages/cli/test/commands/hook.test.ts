import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runHook } from '../../src/commands/hook.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-cli-hook-'));
  process.env['STROQ_HOME'] = home;
});

describe('runHook', () => {
  it('fails closed when stdin is not valid JSON at all', async () => {
    const out = await runHook('claude-code', 'not json {{{');
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(parsed.hookSpecificOutput['hookEventName']).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput['permissionDecision']).toBe('deny');
    expect(String(parsed.hookSpecificOutput['permissionDecisionReason'])).toMatch(
      /fail-closed.*not valid JSON/,
    );

    const log = readFileSync(join(home, 'stroq.log'), 'utf8');
    expect(log.trim().length).toBeGreaterThan(0);
    expect(log).toContain('hook claude-code');
  });
});
