import { describe, expect, it } from 'vitest';
import type { FlowDeps } from '../../src/commands/init-flow.js';
import { fakeTimers } from '../helpers/fake-terminal.js';
import { AGENTS, flow, installedOutput, squash } from '../helpers/flow-deps.js';

/**
 * Much of what the first-run screen prints was written by someone else: the path of a config file
 * (it comes from a project folder), the names of the credential files in it, the words of an
 * installer that quotes an error. All of it traces back to a repository the person has just cloned,
 * so none of it may reach their terminal as a command to the terminal.
 */
const ESC = '\u001b';
const HOSTILE = [
  'evil',
  `${ESC}[2K${ESC}]52;c;eA==\u0007`,
  '\rfake',
  '‮txt.sh',
  '⁦x⁩',
  '\u009b31m',
].join('');
/** The same kinds of character in few enough that a path made of it still fits a line whole. */
const SHORT = 'a\u001b[2K\rb\u202ec';
/** Every character that moves a cursor, rings a bell, writes a clipboard or flips the text. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

const PLAIN = { interactive: false, color: false } as const;

/** What the flow prints on a terminal that draws nothing of its own, for deps that say `deps`. */
async function printed(deps: Partial<FlowDeps>): Promise<string> {
  const f = flow({ terminal: PLAIN, deps: { yes: true, ...deps } });
  await f.run();
  return f.fake.out();
}

/** The same agents, with Claude Code's config said to be at `where`. */
const claudeAt = (where: string): FlowDeps['agents'] => [
  { id: 'claude-code', label: 'Claude Code', found: true, where },
  ...AGENTS.slice(1),
];

describe('runInitFlow, text from outside', () => {
  it('writes the path of an agent config out as visible escapes, with the readable part intact', async () => {
    const out = await printed({ agents: claudeAt(`/p/${SHORT}/s.json`) });

    expect(out).not.toMatch(CONTROL);
    expect(out).toContain('/p/a\\u001b[2K\\u000db\\u202ec/s.json');
  });

  it('does the same for that path in the line that says what is added', async () => {
    const out = await printed({
      agents: claudeAt(`/p/${SHORT}/s.json`),
      chosen: ['claude-code'],
    });

    expect(out).not.toMatch(CONTROL);
    expect(out).toContain("adds     Stroq's hooks to /p/a\\u001b[2K\\u000db\\u202ec/s.json");
  });

  it('does the same for the credential files it says it reads', async () => {
    const out = await printed({ reads: [`/h/${HOSTILE}/.env`, '~/.aws/credentials'] });

    expect(out).not.toMatch(CONTROL);
    expect(out).toContain('\\u001b[2K');
    expect(out).toContain('~/.aws/credentials');
  });

  it('does the same for the place it keeps what it records', async () => {
    const out = await printed({ home: `/h/${HOSTILE}/.stroq` });

    expect(out).not.toMatch(CONTROL);
    expect(out).toContain('\\u001b[2K');
  });

  it('does the same for the file an installer says it wrote', async () => {
    const out = await printed({
      install: async () => ({ code: 0, out: installedOutput(`/p/${HOSTILE}/settings.json`) }),
    });

    expect(out).not.toMatch(CONTROL);
    expect(out).toContain('hooks installed in');
  });

  it('does the same for the reason an installer failed', async () => {
    const out = await printed({
      install: async () => ({ code: 1, out: `cannot parse /p/${HOSTILE}/settings.json: boom\n` }),
    });

    expect(out).not.toMatch(CONTROL);
    // What follows the words is one long word, and it goes on the next line whole.
    expect(squash(out)).toContain('Claude Code: cannot parse /p/evil');
  });

  // The notes go to the screen through `para`, and `term.write` is the unfiltered writer: a note is
  // made safe before it is written, or an escape in it (a path in a warning, say) reaches the terminal.
  it('does the same for the notes an installer printed for a person to read', async () => {
    const out = await printed({
      install: async (id) => ({
        code: 0,
        out: installedOutput(`/p/.${id}/hooks.json`, `Warning: ${HOSTILE} defines hooks`),
      }),
    });

    expect(out).not.toMatch(CONTROL);
    expect(squash(out)).toContain('Warning: evil');
  });

  it('does not let a carriage return in a note take the cursor back over the line', async () => {
    const out = await printed({
      install: async (id) => ({
        code: 0,
        out: installedOutput(`/p/.${id}/hooks.json`, 'Restart it.\rALL CLEAR'),
      }),
    });

    expect(out).not.toContain('\r');
  });

  it('shows only its own escape sequences on a terminal that animates and colours', async () => {
    const f = flow({
      terminal: { interactive: true, color: true, color256: true },
      deps: {
        yes: true,
        timers: fakeTimers().timers,
        agents: claudeAt(`/p/${SHORT}/s.json`),
        reads: [`/h/${HOSTILE}/.env`],
        home: `/h/${HOSTILE}/.stroq`,
        install: async (id) => ({
          code: id === 'cursor' ? 1 : 0,
          out: installedOutput(`/p/${HOSTILE}/${id}.json`),
        }),
      },
    });

    await f.run();

    // Every ESC that is left is the start of a colour, the line clear or the cursor: the module's own.
    const strays = f.fake.out().match(/\u001b(?!\[(?:\?25[lh]|2K|[0-9;]*m))/g);
    expect(strays).toBeNull();
    expect(f.fake.out()).not.toContain('‮');
    expect(f.fake.out()).not.toContain('\u0007');
  });
});
