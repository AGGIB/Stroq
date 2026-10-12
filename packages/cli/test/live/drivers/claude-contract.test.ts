import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriver } from '../../../src/live/drivers/claude.js';
import { controlOf } from '../../../src/live/probes.js';
import type { Probe } from '../../../src/live/types.js';
import { controlBreaches, type Invocation } from '../driver-contract.js';
import { probe } from '../probe-helpers.js';
import { makeRig, type Rig } from '../rig.js';
import {
  canMakeFakeClaude,
  makeFakeClaude,
  type FakeClaude,
  type RecordedCall,
} from './fake-claude.js';
import { STREAMS, linesOf, readFixture } from './fixtures.js';

/**
 * The contract of a control (`test/live/driver-contract.ts`): the control of a deny is the real run with the
 * hook taken out and nothing else changed, because a control that differs in anything else arms what the
 * real run's host would never have run. Here the real driver is asked for a real run and for its control,
 * and the two processes it started are compared, by the check every driver's tests run.
 */
const HOOK_LINE = '"/usr/local/bin/node" "/opt/stroq/dist/index.js" hook claude-code';
const NOOP = 'node -e 0';

let rig: Rig;
let fake: FakeClaude;
beforeEach(() => {
  rig = makeRig(false);
  fake = makeFakeClaude();
  fake.script([{ lines: linesOf(readFixture(STREAMS.denyBlocked)) }]);
});
afterEach(() => {
  fake.cleanup();
  rig.cleanup();
});

const driver = () => createClaudeDriver({ hookLine: HOOK_LINE, bin: fake.bin });

const NONCES = ['stroq-live-0000000000000001', 'stroq-live-0000000000000002'] as const;
const SESSIONS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
] as const;

const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/home/someone' };

/** What the process the driver started was given, in the parts the contract is about. */
function invocationOf(call: RecordedCall, nonce: string): Invocation {
  const argv = call.argv;
  const valueOf = (flag: string): string => argv[argv.indexOf(flag) + 1] ?? '';
  const allowAt = argv.indexOf('--allowedTools');
  const allow = argv.slice(allowAt + 1);
  const settings = JSON.parse(valueOf('--settings')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
  };
  const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? '';
  const named = new Set([
    '-p',
    valueOf('-p'),
    '--model',
    valueOf('--model'),
    '--session-id',
    valueOf('--session-id'),
    '--settings',
    valueOf('--settings'),
    '--permission-mode',
    valueOf('--permission-mode'),
    '--allowedTools',
    ...allow,
  ]);
  return {
    nonce,
    prompt: valueOf('-p'),
    model: valueOf('--model'),
    sessionId: valueOf('--session-id'),
    flags: argv.filter((word) => !named.has(word)),
    // The structure of the settings, with the command of the hook left out: that is the one part allowed to differ.
    settings: {
      ...settings,
      hooks: {
        PreToolUse: settings.hooks.PreToolUse.map((group) => ({
          ...group,
          hooks: group.hooks.map((hook) => ({ ...hook, command: '<hook>' })),
        })),
      },
    },
    permissions: { mode: valueOf('--permission-mode'), allow },
    // The no-op hook prints nothing; a hook that answers "allow" would say so in its command.
    hook: { command, decides: /permissionDecision|allow/i.test(command) ? 'allow' : 'nothing' },
    cwd: call.cwd,
    env: call.env,
  };
}

/** A real run and its control for a probe, as `verifyHost` makes them: each with a nonce and a session of its own. */
async function pair(
  id: 'deny' | 'secret-egress',
): Promise<{ real: Invocation; control: Invocation }> {
  const make = (nonce: string): Probe => probe(id, nonce, rig.project);
  const base = rig.ctx({ env: ENV, deadlineMs: 20_000 });
  await driver().run(make(NONCES[0]), {
    ...base,
    nonce: NONCES[0],
    sessionId: SESSIONS[0],
    hookMode: 'real',
  });
  await driver().run(controlOf(make(NONCES[1])), {
    ...base,
    nonce: NONCES[1],
    sessionId: SESSIONS[1],
    hookMode: 'noop',
  });
  const [first, second] = fake.calls();
  if (first === undefined || second === undefined) throw new Error('the host was not asked twice');
  return { real: invocationOf(first, NONCES[0]), control: invocationOf(second, NONCES[1]) };
}

describe.skipIf(!canMakeFakeClaude())('the Claude driver keeps the contract of a control', () => {
  it.each(['deny', 'secret-egress'] as const)(
    'starts the control of the %s probe as the real run, but for the hook, the session and the nonce',
    async (id) => {
      const { real, control } = await pair(id);
      expect(controlBreaches(real, control)).toEqual([]);
    },
  );

  it('gives the real run the line of the user and the control a hook that does nothing', async () => {
    const { real, control } = await pair('secret-egress');
    expect(real.hook.command).toBe(
      `env HOME=${rig.home} USERPROFILE=${rig.home} STROQ_HOME=${rig.stroqHome} ${HOOK_LINE}`,
    );
    expect(control.hook).toEqual({ command: NOOP, decides: 'nothing' });
  });

  it('tells the two requests apart by their nonce and session and by nothing else', async () => {
    const { real, control } = await pair('deny');
    expect(control.nonce).not.toBe(real.nonce);
    expect(control.sessionId).not.toBe(real.sessionId);
    expect(control.prompt).not.toBe(real.prompt);
    expect(control.permissions).toEqual(real.permissions);
    expect(control.env).toEqual(real.env);
  });

  it('reads the process it started for what it was given, so that a difference would be seen', async () => {
    const { real, control } = await pair('deny');
    expect(real.permissions.mode).toBe('acceptEdits');
    expect(real.permissions.allow).toEqual([
      'Bash(echo:*)',
      'Bash(printf:*)',
      'Bash(mkdir:*)',
      'Bash(curl:*)',
    ]);
    expect(real.flags).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--tools',
        'Bash',
        '--strict-mcp-config',
      ]),
    );
    // Each of the changes a driver could make to the control is named by the check, on these invocations.
    expect(
      controlBreaches(real, {
        ...control,
        permissions: { ...control.permissions, mode: 'dontAsk' },
      }),
    ).toEqual(['permissions']);
    expect(controlBreaches(real, { ...control, flags: [...control.flags, '--bare'] })).toEqual([
      'flags',
    ]);
    expect(controlBreaches(real, { ...control, model: 'opus' })).toEqual(['model']);
    expect(controlBreaches(real, { ...control, env: { ...control.env, EXTRA: '1' } })).toEqual([
      'env',
    ]);
    expect(controlBreaches(real, { ...control, hook: real.hook })).toEqual(['hook-command']);
  });
});
