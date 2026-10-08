import { describe, expect, it } from 'vitest';
import type { FlowDeps } from '../../src/commands/init-flow.js';
import { flow, installedOutput, squash } from '../helpers/flow-deps.js';

const CLAUDE_COMMAND = '"node" "/stroq/index.js" hook claude-code';
const CURSOR_COMMAND = '"node" "/stroq/index.js" hook cursor';

describe('runInitFlow, answered yes', () => {
  const yes = { terminal: { answers: ['y'] } } as const;

  it('shows what Stroq is, with its version', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).toContain('  stroq 0.22.0\n');
    expect(f.fake.out()).toContain('Action firewall for AI coding agents');
    expect(squash(f.fake.out())).toContain('Nothing is sent anywhere.');
  });

  it('marks the agents that are here with a tick and shows where their config is', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).toContain('Agents on this machine');
    expect(f.fake.out()).toMatch(/✔ Claude Code\s+\.claude\/settings\.json/);
    expect(f.fake.out()).toMatch(/✔ Cursor\s+~\/\.cursor\/hooks\.json/);
  });

  it('marks the agents that are not here with a dash and says so', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).toMatch(/– Codex CLI\s+not found/);
  });

  it('says what it adds, reads, writes and how to undo it', async () => {
    const f = flow(yes);

    await f.run();

    const shown = squash(f.fake.out());
    expect(shown).toContain('What this does');
    expect(shown).toContain(
      "adds Stroq's hooks to the config of each agent above that is marked (in this project)",
    );
    expect(shown).toContain(
      'reads credential files, to know which of your own keys your agent must not send out: ~/.aws/credentials, .env. Only salted hashes are kept, never the values.',
    );
    expect(shown).toContain('writes ~/.stroq: the audit log, and what each session has read');
    expect(shown).toContain('undo stroq uninstall');
  });

  it('shows what it will do before it asks, and asks before it installs anything', async () => {
    const f = flow(yes);
    let shownWhenAsked = '';
    f.fake.read.mockImplementationOnce(async () => {
      shownWhenAsked = f.fake.out();
      return 'y';
    });

    await f.run();

    expect(shownWhenAsked).toContain('What this does');
    expect(f.fake.read.mock.invocationCallOrder[0]).toBeLessThan(
      f.install.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('asks one question, for all the agents at once', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.prompts).toHaveLength(1);
    expect(f.fake.prompts[0]).toContain('Guard these 2 agents in this project?');
    expect(f.fake.prompts[0]).toContain('(Y/n)');
  });

  it('installs once for each chosen agent', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.install.mock.calls).toEqual([['claude-code'], ['cursor']]);
  });

  it('installs in the order the agents are shown, whatever the order of the choice', async () => {
    const f = flow({ ...yes, deps: { chosen: ['cursor', 'claude-code'] } });

    await f.run();

    expect(f.install.mock.calls).toEqual([['claude-code'], ['cursor']]);
  });

  it('leaves one line for each agent, with the file that was written', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).toContain(
      '  ✔ Claude Code  hooks installed in /proj/.claude-code/config.json\n',
    );
    expect(f.fake.out()).toContain('  ✔ Cursor  hooks installed in /proj/.cursor/config.json\n');
  });

  it('says only "installed" when the installer did not name a file', async () => {
    const f = flow({
      ...yes,
      deps: { install: async () => ({ code: 0, out: 'Restart it.\n' }) },
    });

    await f.run();

    expect(f.fake.out()).toContain('  ✔ Claude Code  installed\n');
  });

  it('shows what the installer said to a person, under the agent it was about', async () => {
    const note = 'Restart Cursor, then run "stroq doctor" to verify.';
    const f = flow({
      ...yes,
      deps: {
        install: async (id) => ({
          code: 0,
          out: installedOutput(`/proj/.${id}/hooks.json`, ...(id === 'cursor' ? [note] : [])),
        }),
      },
    });

    await f.run();

    const lines = f.fake.out().split('\n');
    const at = lines.findIndex((line) => line.includes('✔ Cursor  hooks installed'));
    expect(lines[at + 1]).toBe(`      ${note}`);
  });

  it('keeps the config lines of the installer, its doctor line and its uninstall line off the screen', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).not.toContain('PreToolUse');
    expect(f.fake.out()).not.toContain('Run "stroq doctor" to verify.');
    expect(f.fake.out()).not.toContain('To remove them');
  });

  it('runs the self-check for each agent with the command that was recorded for it', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.command.mock.calls).toEqual([['claude-code'], ['cursor']]);
    expect(f.check.mock.calls).toEqual([
      ['claude-code', CLAUDE_COMMAND],
      ['cursor', CURSOR_COMMAND],
    ]);
  });

  it('checks only after everything was installed', async () => {
    const f = flow(yes);

    await f.run();

    const lastInstall = Math.max(...f.install.mock.invocationCallOrder);
    const firstCheck = Math.min(...f.check.mock.invocationCallOrder);
    expect(firstCheck).toBeGreaterThan(lastInstall);
  });

  // The line would be 88 columns, and the terminal is 80: the agent, and what was said of it under it.
  it('shows both timings of the self-check, a step for each agent', async () => {
    const f = flow(yes);

    await f.run();

    const said = '    answered a harmless action in 120 ms, and denied a `curl | sh` in 95 ms\n';
    expect(f.fake.out()).toContain(`  ✔ Claude Code\n${said}`);
    expect(f.fake.out()).toContain(`  ✔ Cursor\n${said}`);
  });

  it('says that the check judged the default rules, which are not necessarily the ones in use', async () => {
    const f = flow(yes);

    await f.run();

    expect(squash(f.fake.out())).toContain('and denied a `curl | sh` in 95 ms (default rules)');
  });

  it('ends with Done, naming the agents it guards', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).toContain('  Done. Stroq is guarding Claude Code and Cursor.\n');
    expect(f.fake.out()).not.toContain('start it once');
  });

  it('says what to type next, beginning with the command that shows what the agent saw', async () => {
    const f = flow(yes);

    await f.run();

    const shown = squash(f.fake.out());
    expect(shown).toContain('Try next');
    expect(shown).toContain(
      'stroq sent --last which of your credentials did your agent already see?',
    );
    expect(shown).toContain('stroq why why the last action was denied or asked about');
    expect(shown).toContain('stroq doctor the hooks, and when your agent last called them');
    // Two agents were guarded: one `uninstall` takes out the hooks of one of them.
    expect(shown).toContain('stroq uninstall --agent <name> take the hooks of one agent out again');
    expect(shown.indexOf('stroq sent --last')).toBeLessThan(shown.indexOf('stroq why'));
  });

  it('says things in the order a newcomer needs them', async () => {
    const f = flow(yes);

    await f.run();

    const out = f.fake.out();
    const order = [
      'stroq 0.22.0',
      'Agents on this machine',
      'What this does',
      'hooks installed in',
      'answered a harmless action',
      'Done.',
      'Try next',
    ].map((text) => out.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('exits 0', async () => {
    expect(await flow(yes).run()).toBe(0);
  });

  it('does not print the --yes marker, because it was asked', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).not.toContain('(--yes)');
  });
});

describe('runInitFlow, with --yes', () => {
  it('does not ask', async () => {
    const f = flow({ deps: { yes: true } });

    await f.run();

    expect(f.fake.read).not.toHaveBeenCalled();
    expect(f.fake.prompts).toEqual([]);
  });

  it('prints the question with the answer it was given', async () => {
    const f = flow({ deps: { yes: true } });

    await f.run();

    expect(f.fake.out()).toContain('  ? Guard these 2 agents in this project? yes (--yes)\n');
  });

  it('installs and exits 0 all the same', async () => {
    const f = flow({ deps: { yes: true } });

    const code = await f.run();

    expect(code).toBe(0);
    expect(f.install).toHaveBeenCalledTimes(2);
  });
});

describe('runInitFlow, declined', () => {
  it.each([
    ['n', ['n']],
    ['no', ['no']],
    ['the end of the input', []],
    ['an answer that is neither, three times', ['x', 'x', 'x']],
  ] as const)('writes nothing when the answer is %s', async (_name, answers) => {
    const f = flow({ terminal: { answers } });

    const code = await f.run();

    // Declined is not done: a script that goes on after `stroq init` must be told it was not.
    expect(code).toBe(1);
    expect(f.fake.out()).toContain('Nothing was changed.');
    expect(f.install).not.toHaveBeenCalled();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled();
  });

  it('has shown what it would have done, so that the person knows what they declined', async () => {
    const f = flow({ terminal: { answers: ['n'] } });

    await f.run();

    expect(f.fake.out()).toContain('What this does');
    expect(f.fake.out()).not.toContain('Done.');
    expect(f.fake.out()).not.toContain('Try next');
    expect(f.fake.out()).not.toContain('hooks installed in');
  });
});

describe('runInitFlow, with no agent to guard', () => {
  it.each([
    ['nothing is chosen', { chosen: [] }],
    ['the choice names an agent that is not listed', { chosen: ['nonsense'] }],
    ['there are no agents at all', { agents: [], chosen: [] }],
  ] as const satisfies readonly (readonly [string, Partial<FlowDeps>])[])(
    'says so and installs nothing when %s',
    async (_name, deps) => {
      const f = flow({ deps });

      const code = await f.run();

      expect(code).toBe(1);
      expect(squash(f.fake.out())).toContain(
        'None of the agents Stroq can guard was found here, and nothing was installed.',
      );
      expect(f.install).not.toHaveBeenCalled();
      expect(f.fake.read).not.toHaveBeenCalled();
    },
  );

  it('says how to name the agent', async () => {
    const f = flow({ deps: { chosen: [] } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'Run `stroq init --agent <name>` for the one you use (claude-code, cursor, codex, copilot, openclaw, windsurf or antigravity).',
    );
  });

  it('does not describe what it would do, or print a Done', async () => {
    const f = flow({ deps: { chosen: [] } });

    await f.run();

    expect(f.fake.out()).not.toContain('What this does');
    expect(f.fake.out()).not.toContain('Done.');
  });
});
