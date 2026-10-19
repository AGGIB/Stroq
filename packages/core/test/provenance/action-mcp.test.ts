import { describe, expect, it } from 'vitest';
import { readActionAtoms } from '../../src/provenance/action-atoms.js';
import { commandTexts, isExecStyleTool } from '../../src/provenance/mcp-commands.js';

// The arguments of an MCP call are text, except the ones that are a command line: an argument
// under a key that names one, at any depth, and every argument of a tool that executes what it is
// given. Those are read as a shell reads them, besides the reading of the rest as text.

const NAME = 'evil-helper-fix';
const read = (tool: string, input: Record<string, unknown>) =>
  readActionAtoms(tool, input, '/nonexistent');

describe('a body or a title is text', () => {
  it.each([
    ['mcp__github__create_pull_request', { title: 'Docs', body: 'Run `npm install ev$X` first' }],
    ['mcp__notion__create_page', { content: 'npx $X, then pip install a*b' }],
    ['mcp__slack__post_message', { text: 'try npm i $X' }],
  ])('%s: a launcher in it is a mention', (tool, input) => {
    expect(read(tool, input).unread).toBe(false);
  });
});

describe('an argument under a key that names a command line', () => {
  it.each([
    ['command', 'npm install ev$X'],
    ['cmd', 'npm install ev$X'],
    ['script', 'npx $X'],
    ['shell', 'npx $X'],
    ['run', 'npx $X'],
    ['exec', 'npx $X'],
    ['commandLine', 'npx $X'],
    ['Command', 'npx $X'],
    ['COMMANDLINE', 'npx $X'],
  ])('%s is a command line', (key, value) => {
    const result = read('mcp__github__create_pull_request', { title: 'x', [key]: value });
    expect(result.unread).toBe(true);
    expect(result.unreadCause).toBe('name');
  });

  it.each([
    ['args', ['npx', '$X']],
    ['argv', ['npm', 'install', 'ev$X']],
  ])('%s is read joined, as an argv', (key, value) => {
    expect(read('mcp__github__create_pull_request', { [key]: value }).unread).toBe(true);
  });

  it('is found at any depth', () => {
    expect(read('mcp__x__go', { options: { Command: 'npx $X' } }).unread).toBe(true);
    expect(read('mcp__x__go', { params: [{ steps: { cmd: 'npm i $X' } }] }).unread).toBe(true);
  });

  it('names the packages in it, besides the ones in the text', () => {
    const result = read('mcp__github__create_pull_request', {
      body: 'see `npx other-tool`',
      command: `npx ${NAME}`,
    });
    const names = result.atoms.map((atom) => atom.value);
    expect(names).toContain(NAME);
    expect(names).toContain('other-tool');
  });
});

describe('a tool that executes what it is given', () => {
  it.each([
    'mcp__desktop-commander__execute_command',
    'mcp__shell__run',
    'mcp__ssh__terminal_send',
    'mcp__x__bash',
    'mcp__x__cmd_run',
    'mcp__x__run_command',
    'mcp__x__Exec',
  ])('%s reads every string argument as a command', (tool) => {
    expect(isExecStyleTool(tool)).toBe(true);
    expect(read(tool, { input: 'npm install ev$X' }).unread).toBe(true);
    expect(read(tool, { lines: ['ls', 'npx $X'] }).unread).toBe(true);
  });

  it.each(['mcp__github__create_pull_request', 'mcp__notion__create_page', 'mcp__slack__post'])(
    '%s is no executor',
    (tool) => {
      expect(isExecStyleTool(tool)).toBe(false);
    },
  );
});

describe('the command lines of an input', () => {
  it('are the strings under the keys, and an argv joined', () => {
    expect(commandTexts({ a: 'x', command: 'ls', args: ['npm', 'i', 'y'] }, false, 1000)).toEqual(
      expect.arrayContaining(['ls', 'npm i y', 'npm', 'i', 'y']),
    );
  });

  it('are all the strings for an executor', () => {
    expect(commandTexts({ a: 'x', b: { c: 'y' } }, true, 1000).sort()).toEqual(['x', 'y']);
  });

  it('are bounded', () => {
    expect(commandTexts({ command: 'x'.repeat(5000) }, false, 100).length).toBe(1);
    expect(commandTexts({ a: ['x'.repeat(10)] }, true, 5).length).toBeLessThanOrEqual(1);
  });

  it('survive a value nested thousands of levels deep', () => {
    let deep: unknown = { command: 'npm i x' };
    for (let i = 0; i < 20_000; i += 1) deep = { a: deep };
    expect(() => commandTexts({ deep }, false, 1000)).not.toThrow();
  });
});

describe('an object that has a command and its arguments', () => {
  const NAME = 'evil-helper-fix';
  const names = (tool: string, input: Record<string, unknown>): string[] =>
    read(tool, input)
      .atoms.filter((atom) => atom.kind === 'pkg')
      .map((atom) => atom.value);

  it.each([
    [{ command: 'npx', args: ['-y', NAME] }],
    [{ command: 'npx', args: [NAME] }],
    [{ cmd: 'npm', argv: ['install', NAME] }],
    [{ command: 'pip', arguments: ['install', NAME] }],
    [{ Command: 'yarn', Args: ['add', NAME] }],
    [{ server: { command: 'uvx', args: [NAME, '--stdio'] } }],
    [{ servers: [{ other: 1 }, { command: 'pnpm', args: ['dlx', NAME] }] }],
  ])('is read as one command line, whatever the tool: %j', (input) => {
    for (const tool of ['mcp__fs__spawn', 'mcp__github__create_pull_request', 'mcp__x__y'])
      expect(names(tool, input), tool).toContain(NAME);
  });

  it('reads a name nobody can tell in the arguments as a doubt', () => {
    const result = read('mcp__fs__spawn', { command: 'npx', args: ['-y', 'ev$X'] });
    expect(result.unread).toBe(true);
    expect(result.unreadCause).toBe('name');
  });

  it('leaves an object that is not a command alone', () => {
    expect(names('mcp__notion__create_page', { title: 'npx', tags: ['a', NAME] })).toEqual([]);
    expect(names('mcp__x__y', { command: 'ls', args: ['-la', NAME] })).toEqual([]);
  });

  it('ignores an argument that is not a string, and still reads the others', () => {
    expect(names('mcp__x__y', { command: 'npx', args: [1, null, NAME] })).toContain(NAME);
    expect(names('mcp__x__y', { command: 'npx', args: [NAME, { nested: true }] })).toContain(NAME);
  });
});
