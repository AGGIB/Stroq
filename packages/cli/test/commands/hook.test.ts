import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SUPPORTED_AGENTS, runHook } from '../../src/commands/hook.js';

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

describe('runHook agent routing', () => {
  it('lists every supported agent when the agent is unknown', async () => {
    expect(SUPPORTED_AGENTS).toEqual(['claude-code', 'cursor']);
    const out = await runHook('bogus', '{}');
    expect(out).toEqual({
      stdout: 'unknown agent "bogus" (supported: claude-code, cursor)\n',
      exitCode: 1,
    });
  });

  it('rejects prototype-chain property names as agent names', async () => {
    for (const agent of ['constructor', '__proto__']) {
      const out = await runHook(agent, '{}');
      expect(out).toEqual({
        stdout: `unknown agent "${agent}" (supported: claude-code, cursor)\n`,
        exitCode: 1,
      });
    }
  });

  it('fails closed with a Cursor deny when stdin is not valid JSON', async () => {
    const out = await runHook('cursor', 'not json {{{');
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      permission: 'deny',
      user_message: 'Stroq internal error (fail-closed): hook input is not valid JSON',
      agent_message: 'Stroq internal error (fail-closed): hook input is not valid JSON',
    });
    expect(readFileSync(join(home, 'stroq.log'), 'utf8')).toContain('hook cursor');
  });

  it('fails closed on a malformed blocking event and stays silent on an after event', async () => {
    const blocked = await runHook('cursor', '{"hook_event_name":"beforeShellExecution"}');
    expect(blocked.exitCode).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ permission: 'deny' });
    expect(String(JSON.parse(blocked.stdout).user_message)).toContain('fail-closed');

    expect(await runHook('cursor', '{"hook_event_name":"afterShellExecution"}')).toEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('routes a valid Cursor event to the Cursor adapter', async () => {
    const allowed = await runHook(
      'cursor',
      JSON.stringify({
        conversation_id: 'route-1',
        hook_event_name: 'beforeShellExecution',
        workspace_roots: ['/home/dev/p'],
        cwd: '/home/dev/p',
        command: 'ls -la',
      }),
    );
    expect(allowed).toEqual({ stdout: '', exitCode: 0 });

    const asked = await runHook(
      'cursor',
      JSON.stringify({
        conversation_id: 'route-1',
        hook_event_name: 'beforeShellExecution',
        workspace_roots: ['/home/dev/p'],
        cwd: '/home/dev/p',
        command: 'git reset --hard',
      }),
    );
    expect(JSON.parse(asked.stdout)).toMatchObject({ permission: 'ask' });
  });
});
