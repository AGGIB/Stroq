import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_BIN_ENV, DRIVEN_AGENTS, driverFor } from '../../../src/live/drivers/index.js';
import { canMakeFakeClaude, makeFakeClaude, type FakeClaude } from './fake-claude.js';

const HOOK_LINE = '"/usr/local/bin/node" "/opt/stroq/dist/index.js" hook claude-code';

describe('driverFor', () => {
  it('has a driver for Claude Code, which says it drives a real host', () => {
    const driver = driverFor('claude-code', { hookLine: HOOK_LINE, env: {} });
    expect(driver?.mode).toBe('live');
  });

  it.each(['codex', 'cursor', 'windsurf', 'antigravity', 'copilot', 'openclaw', 'mcp', '', 'x'])(
    'has no driver for %j',
    (agent) => {
      expect(driverFor(agent, { hookLine: HOOK_LINE, env: {} })).toBeNull();
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'does not mistake the name %j for an agent',
    (agent) => {
      expect(driverFor(agent, { hookLine: HOOK_LINE, env: {} })).toBeNull();
    },
  );

  it('lists the agents it drives', () => {
    expect(DRIVEN_AGENTS).toEqual(['claude-code']);
    for (const agent of DRIVEN_AGENTS)
      expect(driverFor(agent, { hookLine: HOOK_LINE, env: {} })).not.toBeNull();
  });
});

describe.skipIf(!canMakeFakeClaude())('which program it drives', () => {
  let fake: FakeClaude;
  beforeEach(() => {
    fake = makeFakeClaude();
    fake.script({ behaviours: [{}], version: '9.8.7 (Claude Code)' });
  });
  afterEach(() => {
    fake.cleanup();
  });

  it(`drives the file ${CLAUDE_BIN_ENV} names`, async () => {
    const driver = driverFor('claude-code', {
      hookLine: HOOK_LINE,
      env: { [CLAUDE_BIN_ENV]: fake.bin, PATH: '/nonexistent' },
    });
    expect(await driver?.detect()).toEqual({ available: true, version: '9.8.7' });
  });

  it('drives the `claude` on the PATH when nothing else is named', async () => {
    const driver = driverFor('claude-code', { hookLine: HOOK_LINE, env: { PATH: fake.dir } });
    expect(await driver?.detect()).toEqual({ available: true, version: '9.8.7' });
  });

  it(`takes ${CLAUDE_BIN_ENV} set to nothing for not set`, async () => {
    const driver = driverFor('claude-code', {
      hookLine: HOOK_LINE,
      env: { [CLAUDE_BIN_ENV]: '', PATH: fake.dir },
    });
    expect(await driver?.detect()).toEqual({ available: true, version: '9.8.7' });
  });

  it('says the host is not there when neither is', async () => {
    const driver = driverFor('claude-code', {
      hookLine: HOOK_LINE,
      env: { PATH: '/nonexistent-dir-for-stroq-tests' },
    });
    const found = await driver?.detect();
    expect(found?.available).toBe(false);
    expect(found?.note).toMatch(/not found/);
  });
});
