import { describe, expect, it } from 'vitest';
import type { FlowAgent } from '../../src/commands/init-flow.js';
import { fakeTimers } from '../helpers/fake-terminal.js';
import { AGENTS, flow, squash } from '../helpers/flow-deps.js';

const ESC = '\u001b';
const CODEX_HERE: FlowAgent = {
  id: 'codex',
  label: 'Codex CLI',
  found: true,
  where: '.codex/hooks.json',
};

describe('runInitFlow, how it words things', () => {
  const yes = { yes: true } as const;

  it('names the agent when there is one', async () => {
    const f = flow({ deps: { ...yes, chosen: ['claude-code'] } });

    await f.run();

    expect(f.fake.out()).toContain('? Guard Claude Code in this project? yes (--yes)');
    expect(squash(f.fake.out())).toContain(
      "adds Stroq's hooks to .claude/settings.json (in this project)",
    );
  });

  it('counts the agents when there are several', async () => {
    const f = flow({
      deps: {
        ...yes,
        agents: [...AGENTS, CODEX_HERE].filter((a) => a.found),
        chosen: ['claude-code', 'cursor', 'codex'],
      },
    });

    await f.run();

    expect(f.fake.out()).toContain('? Guard these 3 agents in this project? yes (--yes)');
  });

  it('says "in your user config" for the user scope, of one agent', async () => {
    const f = flow({ deps: { ...yes, scope: 'user', chosen: ['claude-code'] } });

    await f.run();

    expect(f.fake.out()).toContain('? Guard Claude Code in your user config? yes (--yes)');
    expect(squash(f.fake.out())).toContain(
      "adds Stroq's hooks to .claude/settings.json (in your user config)",
    );
  });

  it('says "in your user config" for the user scope, of several', async () => {
    const f = flow({ deps: { ...yes, scope: 'user' } });

    await f.run();

    expect(f.fake.out()).toContain('? Guard these 2 agents in your user config? yes (--yes)');
    expect(squash(f.fake.out())).toContain('that is marked (in your user config)');
  });

  it('asks with the same words as it prints under --yes', async () => {
    const asked = flow({ terminal: { answers: ['y'] }, deps: { scope: 'user' } });

    await asked.run();

    expect(asked.fake.prompts[0]).toContain('Guard these 2 agents in your user config?');
  });

  it('guards an agent that was chosen although it was not found', async () => {
    const elsewhere: FlowAgent = { ...CODEX_HERE, found: false };
    const f = flow({ deps: { ...yes, agents: [elsewhere], chosen: ['codex'] } });

    const code = await f.run();

    expect(code).toBe(0);
    expect(f.install.mock.calls).toEqual([['codex']]);
    expect(f.fake.out()).toMatch(/– Codex CLI\s+not found/);
    expect(squash(f.fake.out())).toContain("adds Stroq's hooks to .codex/hooks.json");
  });

  it('shows the credential files that exist, when there are some', async () => {
    const f = flow({ deps: { ...yes, reads: ['~/.aws/credentials', '~/.npmrc'] } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'must not send out: ~/.aws/credentials, ~/.npmrc. Only salted hashes are kept, never the values.',
    );
  });

  it('says which kinds of file it reads when there are none yet', async () => {
    const f = flow({ deps: { ...yes, reads: [] } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'reads credential files and project .env files, if there are any, to know which of your own keys your agent must not send out. Only salted hashes are kept, never the values.',
    );
  });

  it('says where it keeps what it records', async () => {
    const f = flow({ deps: { ...yes, home: '/srv/stroq' } });

    await f.run();

    expect(squash(f.fake.out())).toContain(
      'writes /srv/stroq: the audit log, and what each session has read',
    );
  });
});

describe('runInitFlow, with colour', () => {
  const colour = { color: true, color256: true } as const;

  it('draws a tick in green, a dash dim, and a cross in red', async () => {
    const good = flow({ terminal: colour, deps: { yes: true, check: async () => null } });
    const bad = flow({
      terminal: colour,
      deps: { yes: true, install: async () => ({ code: 1, out: 'boom\n' }) },
    });

    await good.run();
    await bad.run();

    expect(good.fake.out()).toContain(`${ESC}[32m✔${ESC}[39m Claude Code`);
    expect(good.fake.out()).toContain(`${ESC}[2m–${ESC}[22m Codex CLI`);
    expect(bad.fake.out()).toContain(`${ESC}[31m✘${ESC}[39m Claude Code: boom`);
  });

  it('gives the product its one colour: orange with 256 colours, yellow with 8', async () => {
    const orange = flow({ terminal: colour, deps: { yes: true } });
    const yellow = flow({ terminal: { color: true, color256: false }, deps: { yes: true } });

    await orange.run();
    await yellow.run();

    const tagline = 'Action firewall for AI coding agents';
    expect(orange.fake.out()).toContain(`${ESC}[38;5;208m${tagline}${ESC}[39m`);
    expect(yellow.fake.out()).toContain(`${ESC}[33m${tagline}${ESC}[39m`);
  });

  it('puts the commands to type next in the accent colour', async () => {
    const f = flow({ terminal: colour, deps: { yes: true } });

    await f.run();

    expect(f.fake.out()).toContain(`${ESC}[38;5;208mstroq sent --last${ESC}[39m`);
  });
});

describe('runInitFlow, on a terminal that animates', () => {
  const HIDE_CURSOR = `${ESC}[?25l`;
  const SHOW_CURSOR = `${ESC}[?25h`;
  const count = (text: string, part: string): number => text.split(part).length - 1;

  it('turns a spinner for each thing it does, on the clock it is given', async () => {
    const clock = fakeTimers();
    const f = flow({ terminal: { interactive: true }, deps: { yes: true, timers: clock.timers } });

    await f.run();

    // Two agents installed, two agents checked.
    expect(clock.started).toHaveLength(4);
    expect(clock.cleared).toEqual(clock.started.map((interval) => interval.handle));
  });

  it('hides the cursor for a step and shows it again, as often as it does the one', async () => {
    const clock = fakeTimers();
    const f = flow({ terminal: { interactive: true }, deps: { yes: true, timers: clock.timers } });

    await f.run();

    expect(count(f.fake.out(), HIDE_CURSOR)).toBe(4);
    expect(count(f.fake.out(), SHOW_CURSOR)).toBe(4);
  });

  it('shows the cursor again after a step that failed, too', async () => {
    const clock = fakeTimers();
    const f = flow({
      terminal: { interactive: true },
      deps: { yes: true, timers: clock.timers, install: async () => ({ code: 1, out: 'boom\n' }) },
    });

    await f.run();

    expect(count(f.fake.out(), HIDE_CURSOR)).toBe(2);
    expect(count(f.fake.out(), SHOW_CURSOR)).toBe(2);
  });

  it('starts no timer on a terminal that does not animate', async () => {
    const clock = fakeTimers();
    const f = flow({ terminal: { interactive: false }, deps: { yes: true, timers: clock.timers } });

    await f.run();

    expect(clock.started).toHaveLength(0);
    expect(f.fake.out()).not.toContain(HIDE_CURSOR);
  });
});

// A step is started before what it waits for, and nothing finishes it when that throws: its timer
// goes on turning (a ref'd interval, so `stroq init` never exits) and the cursor stays hidden.
describe('runInitFlow, when something it awaits throws', () => {
  const HIDE_CURSOR = `${ESC}[?25l`;
  const SHOW_CURSOR = `${ESC}[?25h`;
  const count = (text: string, part: string): number => text.split(part).length - 1;

  it.each([
    [
      'the installer',
      {
        install: async () => {
          throw new Error('boom');
        },
      },
    ],
    [
      'the self-check',
      {
        check: async () => {
          throw new Error('EBUSY: resource busy or locked, rmdir');
        },
      },
    ],
  ] as const)(
    'leaves no spinner turning and no hidden cursor behind when %s throws',
    async (_name, deps) => {
      const clock = fakeTimers();
      const f = flow({
        terminal: { interactive: true },
        deps: { yes: true, timers: clock.timers, ...deps },
      });

      // However it ends, with the error or with an exit code: a timer that is still running keeps
      // the process alive, redrawing a spinner for a step that is over, and a hidden cursor stays
      // hidden at the person's prompt.
      await f.run().catch(() => 1);

      expect(clock.cleared).toEqual(clock.started.map((interval) => interval.handle));
      expect(count(f.fake.out(), SHOW_CURSOR)).toBe(count(f.fake.out(), HIDE_CURSOR));
    },
  );
});
