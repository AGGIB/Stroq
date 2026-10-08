import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentHookStatus } from '../../src/commands/doctor.js';
import { SUPPORTED_AGENTS, runHook } from '../../src/commands/hook.js';
import { readHookStamp, stampHookFired } from '../../src/hook-stamp.js';

/**
 * `stroq hook <agent>` leaves the time of the call where `stroq doctor` can read it: that is
 * how doctor knows the host really runs the hook, and not only that a hook is written down.
 */
const CALLED_AT = '2026-10-06T10:00:00.000Z';

let home: string;

// Only the clock is faked: the hook's own deadline runs on a real timer, and a stamp is compared
// with the second it was written, not with how long the machine took to get there.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-hook-stamp-'));
  process.env['STROQ_HOME'] = home;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CALLED_AT));
});

afterEach(() => vi.useRealTimers());

const claudeEvent = (command: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 'stamp-test',
    cwd: '/home/dev/project',
  });

const stampOf = (agent: string): string | undefined => readHookStamp(agent)?.toISOString();

describe('runHook leaves the time of the call', () => {
  it('for the agent that made it', async () => {
    await runHook('claude-code', claudeEvent('ls'));
    expect(stampOf('claude-code')).toBe(CALLED_AT);
    expect(readHookStamp('codex')).toBeNull();
  });

  // The host called Stroq: what it sent is a different question, and it is the one the
  // fail-closed answer is for.
  it('even when what the host sent is not JSON', async () => {
    await runHook('cursor', 'not json {{{');
    expect(stampOf('cursor')).toBe(CALLED_AT);
  });

  it('for an agent whose phase rides on the command line', async () => {
    await runHook('copilot', '{}', 'pre');
    expect(stampOf('copilot')).toBe(CALLED_AT);
  });

  it('not for an agent Stroq does not know', async () => {
    await runHook('not-an-agent', '{}');
    expect(existsSync(join(home, 'last-hook'))).toBe(false);
  });

  it('not for a command line that is not a phase of the agent', async () => {
    await runHook('copilot', '{}', 'sideways');
    expect(readHookStamp('copilot')).toBeNull();
  });
});

// The stamp is a side note to the answer, and the answer is what a firewall is for: a home that
// cannot be written (a read-only disk, a directory left by `sudo`) must not change a verdict.
describe('a stamp that cannot be written', () => {
  const blockedHome = (): string => {
    const blocked = mkdtempSync(join(tmpdir(), 'stroq-hook-blocked-'));
    // `last-hook` is a file, so nothing can be made under it.
    writeFileSync(join(blocked, 'last-hook'), 'in the way');
    return blocked;
  };

  it.each([
    ['an allow', 'ls -la'],
    ['a deny', 'rm -rf ~'],
  ])('leaves %s as it was', async (_, command) => {
    const written = await runHook('claude-code', claudeEvent(command));
    expect(stampOf('claude-code')).toBe(CALLED_AT);

    process.env['STROQ_HOME'] = blockedHome();
    const blocked = await runHook('claude-code', claudeEvent(command));
    expect(readHookStamp('claude-code')).toBeNull();
    expect(blocked).toEqual(written);
  });

  it('is not the reason a bad event is let through', async () => {
    process.env['STROQ_HOME'] = blockedHome();
    const result = await runHook('claude-code', 'not json {{{');
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// A name the stamp refuses, or an agent with no doctor row, would show "no hook call recorded" for
// a host that is working, for ever. The three lists have to agree.
describe('every agent that has an adapter', () => {
  it.each(SUPPORTED_AGENTS)('%s can be stamped, read, and has a doctor row', (agent) => {
    stampHookFired(agent);
    expect(stampOf(agent)).toBe(CALLED_AT);
    expect(agentHookStatus(agent)).not.toBeNull();
  });
});
