import { describe, expect, it } from 'vitest';
import type { FlowDeps } from '../../src/commands/init-flow.js';
import { uninstallCommand } from '../../src/commands/init-flow.js';
import { fakeTimers } from '../helpers/fake-terminal.js';
import { AGENTS, flow, installedOutput, squash } from '../helpers/flow-deps.js';

/**
 * What a review of the first-run screen found it said that was not true, or did not say: an undo that
 * only took one agent out, steps whose installer does more than the question says, a note that carried a
 * line of its own, and an installer that threw after the spinner had begun.
 */
const ESC = '\u001b';
const yes = { terminal: { answers: ['y'] } } as const;

describe('uninstallCommand', () => {
  it.each([
    ['claude-code', 'project', 'stroq uninstall'],
    ['claude-code', 'user', 'stroq uninstall --user'],
    ['cursor', 'project', 'stroq uninstall --agent cursor'],
    ['codex', 'user', 'stroq uninstall --agent codex --user'],
  ] as const)('is the command that takes out what %s got in %s scope', (id, scope, command) => {
    expect(uninstallCommand(id, scope)).toBe(command);
  });
});

describe('runInitFlow, the way back', () => {
  it('names the one command for one agent', async () => {
    const f = flow({ ...yes, deps: { chosen: ['claude-code'] } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'undo stroq uninstall (the hooks only: ~/.stroq is yours to delete)',
    );
  });

  it('names a command for each agent, since one takes out only one of them', async () => {
    const f = flow({ ...yes, deps: { chosen: ['claude-code', 'cursor'] } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'undo stroq uninstall, stroq uninstall --agent cursor (the hooks only',
    );
  });

  it('names the commands for the user scope with --user, which a plain uninstall does not read', async () => {
    const f = flow({ ...yes, deps: { scope: 'user', chosen: ['claude-code', 'cursor'] } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'stroq uninstall --user, stroq uninstall --agent cursor --user',
    );
  });

  it('ends with the one command for one agent, and a way to name the others for several', async () => {
    const one = flow({ ...yes, deps: { chosen: ['cursor'] } });
    const several = flow({ ...yes, deps: { chosen: ['claude-code', 'cursor'] } });

    await one.run();
    await several.run();

    expect(squash(one.fake.out())).toContain(
      'stroq uninstall --agent cursor take the hooks out again',
    );
    expect(squash(several.fake.out())).toContain(
      'stroq uninstall --agent <name> take the hooks of one agent out again',
    );
  });

  it('does not say that uninstall takes all of Stroq out when it takes the hooks', async () => {
    const f = flow({
      ...yes,
      deps: { install: async () => ({ code: 1, out: 'boom\n' }), chosen: ['claude-code'] },
    });

    await f.run();

    expect(squash(f.fake.out())).toContain('`stroq uninstall` takes the hooks out again');
    expect(f.fake.out()).not.toContain('takes Stroq out again');
  });
});

describe('runInitFlow, what installing does besides writing a hook', () => {
  const withExtra = AGENTS.map((agent) =>
    agent.id === 'cursor'
      ? { ...agent, extra: 'runs a program of its own, for the whole user' }
      : agent,
  );

  it('says it before the question, in a row of its own', async () => {
    const f = flow({ ...yes, deps: { agents: withExtra } });

    await f.run();

    const out = squash(f.fake.out());
    expect(out).toContain('also Cursor: runs a program of its own, for the whole user');
    expect(out.indexOf('also Cursor')).toBeLessThan(out.indexOf('hooks installed in'));
  });

  it('says nothing of it for an agent that was not chosen', async () => {
    const f = flow({ ...yes, deps: { agents: withExtra, chosen: ['claude-code'] } });

    await f.run();

    expect(f.fake.out()).not.toContain('also ');
  });

  it('says that a copy of the CLI is written, and where, when it came from the npx cache', async () => {
    const f = flow({ ...yes, deps: { copiesCli: true } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      '~/.stroq: the audit log, and what each session has read; and a copy of this CLI under ~/.stroq/cli, which the hooks run, because npm prunes the cache it was started from',
    );
  });

  it('says nothing of a copy otherwise', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).not.toContain('a copy of this CLI');
  });
});

describe('runInitFlow, a note that carries a line of its own', () => {
  it('keeps a line break in a path out of the fields that hold paths', async () => {
    const hostile = '/work/p-x\nDone. Stroq is guarding Claude Code.';
    const f = flow({
      ...yes,
      deps: {
        agents: AGENTS.map((a) => (a.id === 'claude-code' ? { ...a, where: hostile } : a)),
        reads: [hostile],
        home: hostile,
      },
    });

    await f.run();

    const lines = f.fake.out().split('\n');
    expect(
      lines.filter((line) => line.trimStart().startsWith('Done. Stroq is guarding Claude Code.')),
    ).toEqual([]);
    expect(f.fake.out()).toContain('p-x\\nDone.');
  });
});

describe('runInitFlow, a warning that the hooks will not run', () => {
  const warning = (id: string): { code: number; out: string } => ({
    code: 0,
    out: installedOutput(
      `/p/.${id}/hooks.json`,
      'A .devin/hooks.json is there: the hooks above will not run there',
    ),
  });

  it('is not followed by a Done that says nothing of it', async () => {
    const f = flow({ ...yes, deps: { install: async (id) => warning(id) } });

    await f.run();

    expect(f.fake.out()).toContain('Done, but read the warning above.');
    expect(squash(f.fake.out())).toContain('the hooks above will not run there');
  });

  it('is not invented for a note that says something else', async () => {
    const f = flow(yes);

    await f.run();

    expect(f.fake.out()).not.toContain('read the warning above');
  });
});

describe('runInitFlow, where the terminal draws only ASCII', () => {
  it('writes the punctuation of an installer note as ASCII, and nothing else that is not', async () => {
    const f = flow({
      terminal: { answers: ['y'], unicode: false },
      deps: {
        install: async (id) => ({
          code: 0,
          out: installedOutput(
            `/p/.${id}/hooks.json`,
            'Write — copy the entries… then restart → done',
          ),
        }),
      },
    });

    await f.run();

    expect(f.fake.out()).toContain('Write - copy the entries... then restart -> done');
    expect(f.fake.out()).not.toMatch(/[^\x00-\x7f]/);
  });

  it('keeps it as it is where the terminal draws it', async () => {
    const f = flow({
      terminal: { answers: ['y'], unicode: true },
      deps: {
        install: async (id) => ({
          code: 0,
          out: installedOutput(`/p/.${id}/hooks.json`, 'Write — copy the entries'),
        }),
      },
    });

    await f.run();

    expect(f.fake.out()).toContain('Write — copy the entries');
  });
});

describe('runInitFlow, a step that is cut short', () => {
  it('stops the spinner and shows the cursor when what shows the result throws', async () => {
    const clock = fakeTimers();
    const f = flow({
      terminal: { answers: ['y'], interactive: true },
      deps: {
        timers: clock.timers,
        show: () => {
          throw new Error('cannot say where');
        },
      },
    });

    await expect(f.run()).rejects.toThrow('cannot say where');

    expect(clock.cleared.length).toBeGreaterThan(0);
    expect(f.fake.out().endsWith(`${ESC}[?25h`)).toBe(true);
  });

  it('shows a reason that the check gave as text, and not as what the terminal does with it', async () => {
    const f = flow({
      ...yes,
      deps: {
        check: async () => ({
          ok: false,
          allowed: { verdict: 'ask', detail: `said ask${ESC}[2Jx`, ms: 1 },
          denied: { verdict: 'deny', detail: '', ms: 1 },
        }),
      },
    });

    await f.run();

    expect(f.fake.out()).not.toContain(ESC);
    expect(f.fake.out()).toContain('\\u001b[2J');
  });
});

describe('runInitFlow, the default of the question', () => {
  it('asks for a yes that is typed, not a yes that is the answer to nothing', async () => {
    const f = flow({ terminal: { answers: ['n'] } });

    await f.run();

    expect(f.fake.prompts[0]).toContain('(Y/n)');
  });

  it('is declined by the end of the input, so that a closed terminal installs nothing', async () => {
    const f = flow({ terminal: { answers: [] } as { answers: never[] } });
    const deps: FlowDeps = f.deps;

    const code = await f.run();

    expect(code).toBe(1);
    expect(deps.install).not.toHaveBeenCalled();
  });
});
