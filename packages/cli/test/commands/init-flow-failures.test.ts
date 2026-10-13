import { describe, expect, it } from 'vitest';
import type { FlowDeps } from '../../src/commands/init-flow.js';
import type { SelfCheck } from '../../src/commands/init-selfcheck.js';
import { PASSING, flow, installedOutput, lineWith, squash } from '../helpers/flow-deps.js';

describe('runInitFlow, when an installer fails', () => {
  const failing = (failId: string, out: string): Partial<FlowDeps> => ({
    yes: true,
    install: async (id) =>
      id === failId
        ? { code: 1, out }
        : { code: 0, out: installedOutput(`/proj/.${id}/config.json`) },
  });

  it('shows a failure line with the first note the installer printed', async () => {
    const out = 'cannot parse /proj/.claude/settings.json: boom\nsecond line\n';
    const f = flow({ deps: failing('claude-code', out) });

    await f.run();

    expect(f.fake.out()).toContain(
      '  ✘ Claude Code: cannot parse /proj/.claude/settings.json: boom\n',
    );
    expect(f.fake.out()).not.toContain('second line');
  });

  it('skips the config lines when it looks for the first note', async () => {
    const out = '  PreToolUse → Bash\nStroq hooks installed in /x\nthe real reason\n';
    const f = flow({ deps: failing('claude-code', out) });

    await f.run();

    expect(f.fake.out()).toContain('Claude Code: the real reason\n');
  });

  it('says how to see everything the installer said', async () => {
    const f = flow({ deps: failing('claude-code', 'boom\n') });

    await f.run();

    expect(f.fake.out()).toContain(
      '    Run `stroq init --agent claude-code --no-input` to see everything it said.\n',
    );
  });

  it('exits 1, says something did not work, and does not claim Done', async () => {
    const f = flow({ deps: failing('claude-code', 'boom\n') });

    const code = await f.run();

    expect(code).toBe(1);
    expect(squash(f.fake.out())).toContain('Something above did not work.');
    expect(squash(f.fake.out())).toContain('`stroq doctor` says what is wrong with each agent');
    expect(f.fake.out()).not.toContain('Done.');
    expect(f.fake.out()).not.toContain('Try next');
  });

  it('still installs the other agents', async () => {
    const f = flow({ deps: failing('claude-code', 'boom\n') });

    await f.run();

    expect(f.install.mock.calls).toEqual([['claude-code'], ['cursor']]);
    expect(f.fake.out()).toContain('✔ Cursor  hooks installed in /proj/.cursor/config.json');
  });

  it('checks only the agents that were installed', async () => {
    const f = flow({ deps: failing('claude-code', 'boom\n') });

    await f.run();

    expect(f.check.mock.calls.map(([id]) => id)).toEqual(['cursor']);
  });

  it('fails when the last agent is the one that fails', async () => {
    const f = flow({ deps: failing('cursor', 'boom\n') });

    const code = await f.run();

    expect(code).toBe(1);
    expect(f.fake.out()).toContain('✔ Claude Code  hooks installed in');
    expect(f.fake.out()).toContain('✘ Cursor: boom');
  });

  // `notesOf(out)[0] ?? out.split('\n')[0] ?? 'the installer failed'`: for no output the second
  // operand is '' (split never returns an empty array), so the fallback is never reached and the
  // line is left saying "Claude Code: " and nothing more.
  it('says that the installer failed when it printed nothing', async () => {
    const f = flow({ deps: failing('claude-code', '') });

    await f.run();

    expect(f.fake.out()).toContain('✘ Claude Code: the installer failed\n');
  });
});

describe('runInitFlow, the self-check', () => {
  const yes = { yes: true } as const;
  const asked = (verdict: SelfCheck['allowed']['verdict'], detail = ''): SelfCheck['allowed'] => ({
    verdict,
    detail,
    ms: 1,
  });

  it('is skipped with a word on why when the agent cannot be tested from here', async () => {
    const f = flow({ deps: { ...yes, check: async () => null } });

    const code = await f.run();

    expect(code).toBe(0);
    expect(f.fake.out()).toContain(
      "  – Claude Code  can't be tested from here: start it, then run `stroq doctor`\n",
    );
  });

  it('is said, in Done, to be still to do when no agent could be tested', async () => {
    const f = flow({ deps: { ...yes, check: async () => null } });

    await f.run();

    // The line is longer than 80 columns, so it is wrapped: said whole, it is a line that wraps on
    // the terminal and leaves the second half at the left margin.
    expect(squash(f.fake.out())).toContain(
      'Done. Stroq is guarding Claude Code and Cursor (start it once, then run `stroq doctor` to see the first call).',
    );
    expect(
      f.fake
        .out()
        .split('\n')
        .every((line) => line.length <= 80),
    ).toBe(true);
  });

  it('is said to be still to do only for the agent that was not tested', async () => {
    const f = flow({
      deps: { ...yes, check: async (id) => (id === 'cursor' ? PASSING : null) },
    });

    await f.run();

    // A fifth review found "guarding Claude Code and Windsurf" said after "Windsurf can't be tested".
    expect(squash(f.fake.out())).toContain(
      'Done. Stroq is guarding Claude Code and Cursor (start Claude Code once, then run `stroq doctor` to see the first call).',
    );
  });

  it('says nothing of a first call to wait for when every agent was tested', async () => {
    const f = flow({ deps: { ...yes, check: async () => PASSING } });

    await f.run();

    expect(f.fake.out()).toContain('  Done. Stroq is guarding Claude Code and Cursor.\n');
  });

  it('is not run for an agent with no recorded command, and leaves no line for it', async () => {
    const f = flow({ deps: { ...yes, command: () => null } });

    const code = await f.run();

    expect(code).toBe(0);
    expect(f.check).not.toHaveBeenCalled();
    expect(f.fake.out()).not.toContain('answered a harmless action');
    expect(f.fake.out()).not.toContain('Checking');
    expect(squash(f.fake.out())).toContain(
      '(start it once, then run `stroq doctor` to see the first call)',
    );
  });

  it.each([
    [
      'the harmless action was asked about',
      { ok: false, allowed: asked('ask', 'said ask'), denied: PASSING.denied },
      'a harmless action said ask',
    ],
    [
      'the fetch into a shell was allowed',
      { ok: false, allowed: PASSING.allowed, denied: asked('allow', 'said allow') },
      'a `curl | sh` said allow',
    ],
    [
      'both were wrong',
      {
        ok: false,
        allowed: asked('unreadable', 'did not start'),
        denied: asked('unreadable', 'did not start'),
      },
      'a harmless action did not start; a `curl | sh` did not start',
    ],
    [
      'the hook gave no reason for a wrong allow',
      { ok: false, allowed: asked('ask'), denied: PASSING.denied },
      'a harmless action was not allowed',
    ],
    [
      'the hook gave no reason for a wrong deny',
      { ok: false, allowed: PASSING.allowed, denied: asked('allow') },
      'a `curl | sh` was not denied',
    ],
    [
      'the hook did not answer in time',
      { ok: false, allowed: asked('unreadable', 'did not answer in time'), denied: PASSING.denied },
      'a harmless action did not answer in time',
    ],
  ] as const satisfies readonly (readonly [string, SelfCheck, string])[])(
    'fails, saying what was wrong, when %s',
    async (_name, result, said) => {
      const f = flow({ deps: { ...yes, chosen: ['claude-code'], check: async () => result } });

      const code = await f.run();

      expect(code).toBe(1);
      expect(f.fake.out()).toContain(`  ✘ Claude Code  ${said}\n`);
      expect(squash(f.fake.out())).toContain(
        'The command that was written does not do what a hook must. Run `stroq doctor` to see why.',
      );
      expect(squash(f.fake.out())).toContain('Something above did not work.');
      expect(f.fake.out()).not.toContain('Done.');
    },
  );

  it('names only what was wrong, not what was right', async () => {
    const result: SelfCheck = {
      ok: false,
      allowed: asked('ask', 'said ask'),
      denied: PASSING.denied,
    };
    const f = flow({ deps: { ...yes, chosen: ['claude-code'], check: async () => result } });

    await f.run();

    expect(lineWith(f.fake.out(), '✘ Claude Code  ')).not.toContain('curl');
  });

  it('goes on to the next agent after one that failed', async () => {
    const bad: SelfCheck = { ok: false, allowed: asked('ask', 'said ask'), denied: PASSING.denied };
    const f = flow({
      deps: { ...yes, check: async (id) => (id === 'claude-code' ? bad : PASSING) },
    });

    const code = await f.run();

    expect(code).toBe(1);
    expect(f.check).toHaveBeenCalledTimes(2);
    // Beside the agent where it fits and under it where it does not: here, under it.
    expect(squash(f.fake.out())).toContain('✔ Cursor answered a harmless action');
  });
});
