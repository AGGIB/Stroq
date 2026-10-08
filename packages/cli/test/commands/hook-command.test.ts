import { describe, expect, it, vi } from 'vitest';
import {
  CMD_AGENTS,
  chooseHookCommand,
  hookCommand,
  isBare,
  unspelledPaths,
  windowsHookCommands,
  type Started,
  type WindowsTools,
} from '../../src/commands/hook-command.js';
import { escapeArg, startsProgram, type Machine } from '../helpers/cmd-model.js';

/**
 * The machine of the report: Node in `C:\Program Files\nodejs`, Stroq installed globally with npm under the
 * profile, and the 8.3 name `PROGRA~1` that every Windows has for `Program Files`.
 */
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NODE_SHORT = 'C:\\PROGRA~1\\nodejs\\node.exe';
const ENTRY = 'C:\\Users\\ann\\AppData\\Roaming\\npm\\node_modules\\@stroq\\cli\\dist\\index.js';

const MACHINE: Machine = {
  files: new Set([NODE, NODE_SHORT, ENTRY].map((p) => p.toLowerCase())),
  onPath: new Set(['node']),
};

const tools = (overrides: Partial<WindowsTools> = {}): WindowsTools => ({
  shortPath: (path) => (path === NODE ? NODE_SHORT : null),
  sameFile: (a, b) =>
    [a, b].every((p) => p.toLowerCase() === NODE.toLowerCase() || p === NODE_SHORT) ||
    a.toLowerCase() === b.toLowerCase(),
  ...overrides,
});

/** Starts a line on the machine of the report, as the model says Windows would. */
const startsOnMachine =
  (machine: Machine = MACHINE) =>
  async (line: string): Promise<Started> => {
    const started = startsProgram(`${line} pre`, machine);
    return started.ok ? { ok: true, detail: '' } : { ok: false, detail: started.message };
  };

describe('the line Stroq used to write for Antigravity, on the machine of the report', () => {
  const written = `${hookCommand(NODE, ENTRY, 'antigravity')} pre`;

  it('is the line of the report', () => {
    expect(written).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ann\\AppData\\Roaming\\npm\\node_modules\\@stroq\\cli\\dist\\index.js" hook antigravity pre',
    );
  });

  it('does not start: cmd.exe is given a program named with the escaped quotes, as the report says', () => {
    const started = startsProgram(written, MACHINE);

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.message).toBe(
      '\'\\"C:\\Program Files\\nodejs\\node.exe\\"\' is not recognized as an internal or external command, operable program or batch file.',
    );
  });

  it('is handed over with each quote escaped, which is the whole of the trouble', () => {
    expect(escapeArg(written)).toContain('\\"C:\\Program Files\\nodejs\\node.exe\\"');
  });
});

describe('windowsHookCommands', () => {
  it('writes the paths bare, with the 8.3 name for the blank, and no quote at all, first for Antigravity', () => {
    const lines = windowsHookCommands(NODE, ENTRY, 'antigravity', tools());

    expect(lines[0]).toBe(`${NODE_SHORT} ${ENTRY} hook antigravity`);
  });

  it('starts, for every line but the last, on the machine of the report', async () => {
    const lines = windowsHookCommands(NODE, ENTRY, 'antigravity', tools());

    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(0, -1)) {
      expect(line, line).not.toContain('"');
      expect((await startsOnMachine()(line)).ok, line).toBe(true);
    }
  });

  it('keeps the quoted line as the last, for a host that can read it', () => {
    const lines = windowsHookCommands(NODE, ENTRY, 'antigravity', tools());

    expect(lines.at(-1)).toBe(hookCommand(NODE, ENTRY, 'antigravity'));
  });

  it('puts forward slashes first for the agents that have not been seen, backslashes first for Antigravity', () => {
    expect(windowsHookCommands(NODE, ENTRY, 'cursor', tools())[0]).toBe(
      'C:/PROGRA~1/nodejs/node.exe C:/Users/ann/AppData/Roaming/npm/node_modules/@stroq/cli/dist/index.js hook cursor',
    );
    expect(windowsHookCommands(NODE, ENTRY, 'codex', tools())[0]).toContain('C:/PROGRA~1/');
    expect(windowsHookCommands(NODE, ENTRY, 'antigravity', tools())[0]).toContain('C:\\PROGRA~1\\');
  });

  it('never writes a bare `node`: cmd.exe looks for it in the current directory first, which a repository fills', () => {
    // The Node has no 8.3 name here, and the search path finds the same one: still a path or nothing.
    const lines = windowsHookCommands(NODE, ENTRY, 'antigravity', tools({ shortPath: () => null }));

    expect(lines).toEqual([hookCommand(NODE, ENTRY, 'antigravity')]);
    for (const agent of CMD_AGENTS)
      for (const line of windowsHookCommands(NODE, ENTRY, agent, tools()))
        expect(/^node[ .]/i.test(line), line).toBe(false);
  });

  it('offers nothing but the quoted line when the entry cannot be written without a blank', () => {
    const entry =
      'C:\\Users\\Ivan Petrov\\AppData\\Roaming\\npm\\node_modules\\@stroq\\cli\\dist\\index.js';

    expect(
      windowsHookCommands(NODE, entry, 'antigravity', tools({ shortPath: () => null })),
    ).toEqual([hookCommand(NODE, entry, 'antigravity')]);
  });

  it('takes the 8.3 name of the entry too, where the profile has a blank and a short name', () => {
    const entry =
      'C:\\Users\\Ivan Petrov\\AppData\\Roaming\\npm\\node_modules\\@stroq\\cli\\dist\\index.js';
    const short =
      'C:\\Users\\IVANPE~1\\AppData\\Roaming\\npm\\node_modules\\@stroq\\cli\\dist\\index.js';

    const lines = windowsHookCommands(
      NODE,
      entry,
      'antigravity',
      tools({
        shortPath: (path) => (path === NODE ? NODE_SHORT : path === entry ? short : null),
        sameFile: () => true,
      }),
    );

    expect(lines[0]).toBe(`${NODE_SHORT} ${short} hook antigravity`);
  });

  it.each([
    ['one that still has a blank', 'C:\\Other Dir\\node.exe'],
    ['one that is another file', 'C:\\PROGRA~1\\other\\node.exe'],
  ])('does not take a short name that is %s', (_name, short) => {
    const lines = windowsHookCommands(
      NODE,
      ENTRY,
      'antigravity',
      tools({ shortPath: () => short, sameFile: (a, b) => a.toLowerCase() === b.toLowerCase() }),
    );

    expect(lines).toEqual([hookCommand(NODE, ENTRY, 'antigravity')]);
    expect(lines.some((line) => line.includes(short))).toBe(false);
  });

  it('does not take the long name back for a short one, where the drive keeps no 8.3 names', () => {
    // `%~s` of a path with no short name is the path, blank and all, and it is the same file.
    const lines = windowsHookCommands(
      NODE,
      ENTRY,
      'antigravity',
      tools({ shortPath: (path) => path, sameFile: (a, b) => a.toLowerCase() === b.toLowerCase() }),
    );

    expect(lines).toEqual([hookCommand(NODE, ENTRY, 'antigravity')]);
    expect(lines.slice(0, -1).some((line) => line.includes('Program Files'))).toBe(false);
  });

  it('carries the tsx loader of a TypeScript entry in every line, as the quoted line does', () => {
    const entry = 'C:\\src\\stroq\\packages\\cli\\src\\index.ts';
    const lines = windowsHookCommands(NODE, entry, 'cursor', tools());

    expect(lines.every((line) => line.includes(' --import tsx '))).toBe(true);
  });

  it('writes the agent name last, which is how init recognises its own entry', () => {
    for (const agent of CMD_AGENTS)
      for (const line of windowsHookCommands(NODE, ENTRY, agent, tools()))
        expect(line.endsWith(` hook ${agent}`), line).toBe(true);
  });

  it('has no line twice', () => {
    const lines = windowsHookCommands(NODE, ENTRY, 'antigravity', tools());

    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('unspelledPaths', () => {
  const ENTRY_WITH_BLANK =
    'C:\\Users\\Ivan Petrov\\AppData\\Roaming\\npm\\node_modules\\@stroq\\cli\\dist\\index.js';

  it('names nothing when both paths can be written without a quote', () => {
    expect(unspelledPaths(NODE, ENTRY, tools())).toEqual([]);
  });

  it('names the path that has no spelling without a blank, and only that one', () => {
    expect(unspelledPaths(NODE, ENTRY_WITH_BLANK, tools())).toEqual([ENTRY_WITH_BLANK]);
    expect(unspelledPaths(NODE, ENTRY_WITH_BLANK, tools({ shortPath: () => null }))).toEqual([
      NODE,
      ENTRY_WITH_BLANK,
    ]);
  });
});

describe('isBare', () => {
  it.each([
    'C:\\PROGRA~1\\nodejs\\node.exe',
    'C:/Users/ann/AppData/Roaming/npm/node_modules/@stroq/cli/dist/index.js',
    '/opt/homebrew/bin/node',
    'C:\\Users\\Иван\\scoop\\apps\\nodejs\\current\\node.exe',
    'node',
  ])('takes %s', (path) => {
    expect(isBare(path)).toBe(true);
  });

  it.each([
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\x\\node.exe',
    'C:\\a&b\\node.exe',
    'C:\\100%\\node.exe',
    'C:\\a,b\\node.exe',
    'C:\\a;b\\node.exe',
    'C:\\a=b\\node.exe',
    'C:\\a^b\\node.exe',
    'C:\\a$b\\node.exe',
    'C:\\"a"\\node.exe',
    "C:\\a'b\\node.exe",
    '',
  ])('does not take %s', (path) => {
    expect(isBare(path)).toBe(false);
  });
});

describe('chooseHookCommand', () => {
  const quoted = (agent: string): string => hookCommand(NODE, ENTRY, agent);

  it.each(['linux', 'darwin'] as const)(
    'writes the quoted line, and asks nothing of the machine, on %s',
    async (platform) => {
      const probe = vi.fn(async () => ({ ok: false, detail: 'x' }));

      const chosen = await chooseHookCommand(NODE, ENTRY, 'antigravity', { platform, probe });

      expect(chosen).toEqual({ command: quoted('antigravity'), warning: null, refused: null });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each(['claude-code', 'copilot', 'windsurf', 'openclaw'])(
    'leaves the quoted line for %s on Windows: its host reads that line',
    async (agent) => {
      const probe = vi.fn(async () => ({ ok: false, detail: 'x' }));

      const chosen = await chooseHookCommand(NODE, ENTRY, agent, {
        platform: 'win32',
        tools: tools(),
        probe,
      });

      expect(chosen.command).toBe(quoted(agent));
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it('writes the first line that starts, for Antigravity on the machine of the report', async () => {
    const chosen = await chooseHookCommand(NODE, ENTRY, 'antigravity', {
      platform: 'win32',
      tools: tools(),
      probe: startsOnMachine(),
    });

    expect(chosen.refused).toBeNull();
    expect(chosen.warning).toBeNull();
    expect(chosen.command).toBe(`${NODE_SHORT} ${ENTRY} hook antigravity`);
    expect(chosen.command).not.toContain('"');
  });

  it('goes on to the next line when the first does not start, and says nothing of it', async () => {
    const seen: string[] = [];

    const chosen = await chooseHookCommand(NODE, ENTRY, 'antigravity', {
      platform: 'win32',
      tools: tools(),
      probe: async (line) => {
        seen.push(line);
        return seen.length < 3 ? { ok: false, detail: 'did not start' } : { ok: true, detail: '' };
      },
    });

    expect(seen).toHaveLength(3);
    expect(chosen.command).toBe(seen[2]);
    expect(chosen.refused).toBeNull();
  });

  it('writes nothing for Antigravity when no line starts, and says what each came to and what to do', async () => {
    const chosen = await chooseHookCommand(NODE, ENTRY, 'antigravity', {
      platform: 'win32',
      tools: tools({ shortPath: () => null }),
      probe: startsOnMachine(),
    });

    expect(chosen.refused).not.toBeNull();
    expect(chosen.refused).toContain('No hook was written for Antigravity');
    expect(chosen.refused).toContain('blocks every tool call');
    expect(chosen.refused).toContain('is not recognized as an internal or external command');
    expect(chosen.refused).toContain(`Windows has no spelling without a blank of ${NODE}.`);
    expect(chosen.refused).toContain('stroq init --agent antigravity');
    expect(chosen.warning).toBeNull();
  });

  it('says how to take out a hook that already blocks Antigravity, for the project and for the user', async () => {
    const chosen = await chooseHookCommand(NODE, ENTRY, 'antigravity', {
      platform: 'win32',
      tools: tools({ shortPath: () => null }),
      probe: startsOnMachine(),
    });

    expect(chosen.refused).toContain('"stroq uninstall --agent antigravity" for this project');
    expect(chosen.refused).toContain('"stroq uninstall --agent antigravity --user"');
    // The advice on where to put Stroq: a folder the search path has, or the next step cannot be run.
    expect(chosen.refused).toContain('add C:\\npm to PATH');
  });

  it('writes no line of the refusal or the warning indented, which a first-run screen would take for a command', async () => {
    const refused = await chooseHookCommand(NODE, ENTRY, 'antigravity', {
      platform: 'win32',
      tools: tools({ shortPath: () => null }),
      probe: startsOnMachine(),
    });
    const warned = await chooseHookCommand(NODE, ENTRY, 'cursor', {
      platform: 'win32',
      tools: tools(),
      probe: async () => ({ ok: false, detail: 'did not answer' }),
    });

    for (const text of [refused.refused ?? '', warned.warning ?? ''])
      for (const line of text.split('\n')) expect(line, line).not.toMatch(/^\s/);
  });

  it('tries the quoted line too, and only that, where no spelling without a quote exists', async () => {
    const seen: string[] = [];

    await chooseHookCommand(NODE, ENTRY, 'antigravity', {
      platform: 'win32',
      tools: tools({ shortPath: () => null }),
      probe: async (line) => {
        seen.push(line);
        return { ok: false, detail: 'did not start' };
      },
    });

    expect(seen).toEqual([hookCommand(NODE, ENTRY, 'antigravity')]);
  });

  it.each(['cursor', 'codex'])(
    'keeps the quoted line for %s, with a warning, when no line starts: nobody has run it on Windows',
    async (agent) => {
      const chosen = await chooseHookCommand(NODE, ENTRY, agent, {
        platform: 'win32',
        tools: tools(),
        probe: async () => ({ ok: false, detail: 'did not answer' }),
      });

      expect(chosen.refused).toBeNull();
      expect(chosen.command).toBe(quoted(agent));
      expect(chosen.warning).toContain(`no line for ${agent}`);
      expect(chosen.warning).toContain('did not answer');
    },
  );

  it('takes the first line without asking, for a dry run', async () => {
    const probe = vi.fn(async () => ({ ok: false, detail: 'x' }));

    const chosen = await chooseHookCommand(NODE, ENTRY, 'antigravity', {
      platform: 'win32',
      tools: tools(),
      dryRun: true,
      probe,
    });

    expect(chosen.command).toBe(`${NODE_SHORT} ${ENTRY} hook antigravity`);
    expect(probe).not.toHaveBeenCalled();
  });

  it('reads the line that was probed as the line that is written', async () => {
    let probed = '';

    const chosen = await chooseHookCommand(NODE, ENTRY, 'cursor', {
      platform: 'win32',
      tools: tools(),
      probe: async (line) => {
        probed = line;
        return { ok: true, detail: '' };
      },
    });

    expect(chosen.command).toBe(probed);
  });
});
