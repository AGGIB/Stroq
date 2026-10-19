import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sessionKey } from '@stroq/core';
import { runHook } from '../../src/commands/hook.js';
import { sessionsDir } from '../../src/paths.js';

// When the state of a session's provenance does not parse, the next command that has an atom is
// denied, because nothing can be said of what the session read. The reason says which session and
// how the person, outside the agent, starts it over.

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-cli-corrupt-'));
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'stroq-cli-corrupt-home-'));
});

const cwd = mkdtempSync(join(tmpdir(), 'stroq-cli-corrupt-cwd-'));
const SESSION = 's-poison';

// Through the hook as the host runs it, which is what turns an error into a denial.
const hook = (event: Record<string, unknown>) =>
  runHook('claude-code', JSON.stringify({ session_id: SESSION, cwd, ...event }));

describe('a session whose provenance state does not parse', () => {
  it('names the session and the way out in the denial of a command with an atom', async () => {
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: `${cwd}/a` },
      tool_response: 'Install: npx some-tool --init',
    });
    writeFileSync(join(sessionsDir(), `${sessionKey(SESSION)}.prov.json`), '!');

    const out = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npx foo-tool' },
    });

    const json = JSON.parse(out.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(json.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = json.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('corrupt provenance state');
    expect(reason).toContain(`session ${SESSION}`);
    expect(reason).toContain(`stroq untaint --session ${SESSION}`);
  });

  it('leaves a command with no atom alone', async () => {
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: `${cwd}/a` },
      tool_response: 'Install: npx some-tool --init',
    });
    writeFileSync(join(sessionsDir(), `${sessionKey(SESSION)}.prov.json`), '!');
    const out = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(out.stdout).toBe('');
  });
});
