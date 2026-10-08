import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));

const { windowsTools } = await import('../../src/commands/hook-command.js');

/** What `cmd.exe` says for `for %I in ("…") do @echo %~sI`: the 8.3 name on a line of its own. */
const answers = (stdout: string) => ({ status: 0, stdout, error: undefined });

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  spawnSync.mockReset();
  for (const name of ['ComSpec', 'SystemRoot']) saved[name] = process.env[name];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the short name of a path, as `windowsTools` asks cmd.exe for it', () => {
  it('asks `cmd.exe` by that name, from the system folder, and gives what it answers', () => {
    process.env['SystemRoot'] = 'D:\\Win';
    spawnSync.mockReturnValue(answers('C:\\PROGRA~1\\nodejs\\node.exe\r\n'));

    const short = windowsTools().shortPath('C:\\Program Files\\nodejs\\node.exe');

    expect(short).toBe('C:\\PROGRA~1\\nodejs\\node.exe');
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnSync.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe('cmd.exe');
    expect(args).toEqual([
      '/d',
      '/s',
      '/c',
      '"for %I in ("C:\\Program Files\\nodejs\\node.exe") do @echo %~sI"',
    ]);
    // The folder searched first is the system's, so a `cmd.exe` in a project is not the one that runs.
    expect(options['cwd']).toBe(join('D:\\Win', 'System32'));
    expect(options['windowsVerbatimArguments']).toBe(true);
  });

  it('does not take the program from the environment', () => {
    process.env['ComSpec'] = 'C:\\somewhere\\else\\cmd.exe';
    spawnSync.mockReturnValue(answers('C:\\X\r\n'));

    windowsTools().shortPath('C:\\Program Files');

    expect((spawnSync.mock.calls[0] as [string])[0]).toBe('cmd.exe');
  });

  it('asks about a path with parentheses, an apostrophe and letters of another alphabet', () => {
    spawnSync.mockReturnValue(answers('C:\\X\r\n'));

    for (const path of [
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      "C:\\Users\\O'Brien\\index.js",
      'C:\\Users\\Иван\\index.js',
    ])
      expect(windowsTools().shortPath(path), path).toBe('C:\\X');
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it.each([
    'C:\\a"b\\x',
    'C:\\100%\\x',
    'C:\\a%PATH%b\\x',
    'C:\\a&b\\x',
    'C:\\a|b\\x',
    'C:\\a<b\\x',
    'C:\\a>b\\x',
    'C:\\a^b\\x',
    'C:\\a!b\\x',
    'C:\\a,b\\x',
    'C:\\a;b\\x',
    'C:\\a=b\\x',
    'C:\\a`b\\x',
    'C:\\a\nb\\x',
    '',
  ])('does not ask about %j: cmd.exe would read more than a name in it', (path) => {
    spawnSync.mockReturnValue(answers('C:\\X\r\n'));

    expect(windowsTools().shortPath(path)).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    ['cmd.exe could not be started', { status: null, stdout: '', error: new Error('ENOENT') }],
    ['it exited with an error', { status: 1, stdout: '', error: undefined }],
    ['it printed nothing', { status: 0, stdout: '\r\n', error: undefined }],
  ])('gives none when %s', (_why, result) => {
    spawnSync.mockReturnValue(result);

    expect(windowsTools().shortPath('C:\\Program Files')).toBeNull();
  });

  it('takes the first line of the answer', () => {
    spawnSync.mockReturnValue(answers('C:\\PROGRA~1\r\nsomething else\r\n'));

    expect(windowsTools().shortPath('C:\\Program Files')).toBe('C:\\PROGRA~1');
  });
});
