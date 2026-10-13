import { describe, expect, it } from 'vitest';
import {
  FLOW_FLAGS,
  explicitAgent,
  installerArgs,
  isAgentFlag,
  mayDraw,
} from '../../src/commands/init-args.js';
import { HOOK_AGENTS } from '../../src/commands/init.js';

describe('FLOW_FLAGS', () => {
  it('holds the flags of the first-run screen and no others', () => {
    expect([...FLOW_FLAGS].sort()).toEqual(['--no-input', '--yes']);
  });
});

describe('isAgentFlag', () => {
  it.each(['--agent', '--agent=cursor', '--agent='])('is true for %s', (arg) => {
    expect(isAgentFlag(arg)).toBe(true);
  });

  it.each(['--agents', '--agent-x', 'agent', '-agent', '--user', '--yes', 'cursor', ''])(
    'is false for %j',
    (arg) => {
      expect(isAgentFlag(arg)).toBe(false);
    },
  );
});

describe('explicitAgent', () => {
  it('reads the name after --agent', () => {
    expect(explicitAgent(['--agent', 'cursor'])).toBe('cursor');
  });

  it('reads the name after --agent=', () => {
    expect(explicitAgent(['--agent=cursor'])).toBe('cursor');
  });

  it('is null when no agent is named', () => {
    expect(explicitAgent([])).toBeNull();
    expect(explicitAgent(['--user', '--yes'])).toBeNull();
  });

  // `--agent` with nothing after it names nothing, which is not the same as no `--agent`: the first
  // is a usage error for the installer to say, and the second is the default.
  it('is an empty name for an --agent with nothing after it', () => {
    expect(explicitAgent(['--agent'])).toBe('');
    expect(explicitAgent(['--user', '--agent'])).toBe('');
  });

  it('finds the flag wherever it is among the others', () => {
    expect(explicitAgent(['--user', '--agent', 'codex', '--yes'])).toBe('codex');
    expect(explicitAgent(['--yes', '--agent=codex', '--user'])).toBe('codex');
  });

  // The installer reads the last one (`parseArgs`), and the screen must read the same agent.
  it('takes the last when the flag is given twice', () => {
    expect(explicitAgent(['--agent', 'a', '--agent=b'])).toBe('b');
    expect(explicitAgent(['--agent=a', '--agent', 'b'])).toBe('b');
    expect(explicitAgent(['--agent', 'mcp', '--agent', 'cursor'])).toBe('cursor');
  });

  it('gives the empty name of --agent= as it is, not as no name', () => {
    expect(explicitAgent(['--agent='])).toBe('');
  });

  it('does not take a different flag that starts the same way for the agent', () => {
    expect(explicitAgent(['--agents', 'cursor'])).toBeNull();
    expect(explicitAgent(['--agent-name=cursor'])).toBeNull();
  });
});

describe('installerArgs', () => {
  it('drops --yes and --no-input, which the installer has no use for', () => {
    expect(installerArgs(['--yes'])).toEqual([]);
    expect(installerArgs(['--no-input'])).toEqual([]);
    expect(installerArgs(['--yes', '--no-input', '--user'])).toEqual(['--user']);
  });

  it('drops --agent and the name after it, which the screen passes on its own', () => {
    expect(installerArgs(['--agent', 'cursor'])).toEqual([]);
  });

  it('drops --agent=<name> too', () => {
    expect(installerArgs(['--agent=cursor'])).toEqual([]);
  });

  it('drops an --agent that has no name after it', () => {
    expect(installerArgs(['--user', '--agent'])).toEqual(['--user']);
  });

  it.each([['--user'], ['--cloak'], ['--unwrap'], ['--dry-run'], ['--config', '/etc/mcp.json']])(
    'keeps %j',
    (...args) => {
      expect(installerArgs(args)).toEqual(args);
    },
  );

  it('keeps the rest, in the order it was given, around what it drops', () => {
    const args = ['--user', '--yes', '--agent', 'cursor', '--config', '/p/mcp.json', '--cloak'];

    expect(installerArgs(args)).toEqual(['--user', '--config', '/p/mcp.json', '--cloak']);
  });

  it('keeps a value that only looks like the name of an agent when no --agent is before it', () => {
    expect(installerArgs(['--config', 'cursor'])).toEqual(['--config', 'cursor']);
  });

  it('does not change what it was given, and answers with a new array', () => {
    const args = Object.freeze(['--yes', '--user']);

    const result = installerArgs(args);

    expect(args).toEqual(['--yes', '--user']);
    expect(result).not.toBe(args);
  });
});

describe('mayDraw', () => {
  it.each([
    ['--dry-run', ['--dry-run']],
    ['--no-input', ['--no-input']],
    ['--agent mcp', ['--agent', 'mcp']],
    ['--agent=mcp', ['--agent=mcp']],
    ['--agent nonsense', ['--agent', 'nonsense']],
    ['--agent=nonsense', ['--agent=nonsense']],
    ['--agent= with no name', ['--agent=']],
    ['--dry-run with a hook agent', ['--agent', 'cursor', '--dry-run']],
    ['--no-input with a hook agent', ['--agent', 'cursor', '--no-input']],
    ['--no-input and --yes', ['--yes', '--no-input']],
    // What the installer would refuse is for it to say, before a question that it cannot honour.
    ['a positional word', ['foo']],
    ['--', ['--']],
    ['--yes with a value', ['--yes=true']],
    ['--config with the next flag as its value', ['--config', '--agent', 'cursor']],
    ['an unknown flag', ['--bogus']],
    ['--agent with nothing after it', ['--user', '--agent']],
    [
      '--agent mcp, and then one that is a hook agent: the last is the one',
      ['--agent', 'cursor', '--agent', 'mcp'],
    ],
  ] as const)('is false for %s', (_name, args) => {
    expect(mayDraw(args)).toBe(false);
  });

  it.each([
    ['no arguments', []],
    ['--agent cursor', ['--agent', 'cursor']],
    ['--agent=cursor', ['--agent=cursor']],
    ['--user', ['--user']],
    ['--yes', ['--yes']],
    ['--yes and --user', ['--yes', '--user']],
    ['--yes and a hook agent', ['--yes', '--agent', 'copilot']],
    [
      '--agent mcp, and then one that is a hook agent: the last is the one',
      ['--agent', 'mcp', '--agent', 'cursor'],
    ],
  ] as const)('is true for %s', (_name, args) => {
    expect(mayDraw(args)).toBe(true);
  });

  it.each(HOOK_AGENTS)('is true for the hook agent %s, named either way', (agent) => {
    expect(mayDraw(['--agent', agent])).toBe(true);
    expect(mayDraw([`--agent=${agent}`])).toBe(true);
  });

  it('is false for an agent that is a hook agent only in another case', () => {
    expect(mayDraw(['--agent', 'Cursor'])).toBe(false);
  });
});
