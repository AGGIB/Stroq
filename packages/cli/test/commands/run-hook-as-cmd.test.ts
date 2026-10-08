import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Call {
  readonly file: string;
  readonly args: readonly string[] | undefined;
  readonly options: Record<string, unknown>;
}

const calls: Call[] = [];

/** A child that exits at once with nothing to say, so that only the way it was started can be looked at. */
function fakeChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  kill: () => boolean;
} {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 4242,
    kill: () => true,
  });
  child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
  return child;
}

vi.mock('node:child_process', () => ({
  spawn: (file: string, second?: unknown, third?: unknown) => {
    const args = Array.isArray(second) ? (second as string[]) : undefined;
    const options = (args === undefined ? second : third) as Record<string, unknown>;
    calls.push({ file, args, options });
    return fakeChild();
  },
}));

afterEach(() => {
  calls.length = 0;
});

describe('how the self-check starts a hook line', () => {
  it('hands the line to a shell, as a Unix host or Node with shell: true does, by default', async () => {
    const { runHook } = await import('../../src/commands/init-selfcheck.js');

    await runHook('node entry.js hook claude-code', '{}', {}, '/tmp');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('node entry.js hook claude-code');
    expect(calls[0]?.options['shell']).toBe(true);
  });

  it('hands it to cmd.exe /d /c as one argument, with no shell between, as Antigravity does', async () => {
    const { runHookAsCmd } = await import('../../src/commands/init-selfcheck.js');
    const line = 'C:\\PROGRA~1\\nodejs\\node.exe C:\\stroq\\index.js hook antigravity pre';

    await runHookAsCmd(line, '{}', {}, '/tmp');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toMatch(/cmd\.exe$/i);
    // One argument holding the whole line, which the C runtime's rules then quote: a quote in the line becomes
    // `\"`, which is the way a line with a quote in it cannot start. `shell: true` would put the line in quotes
    // that cmd.exe is told to strip, and the failure would not be seen.
    expect(calls[0]?.args).toEqual(['/d', '/c', line]);
    expect(calls[0]?.options['shell']).toBeUndefined();
    expect(calls[0]?.options['windowsVerbatimArguments']).toBeUndefined();
  });

  it('starts cmd.exe from the ComSpec of the environment, where there is one', async () => {
    const { runHookAsCmd } = await import('../../src/commands/init-selfcheck.js');
    const before = process.env['ComSpec'];
    process.env['ComSpec'] = 'C:\\Windows\\System32\\cmd.exe';
    try {
      await runHookAsCmd('x', '{}', {}, '/tmp');
    } finally {
      if (before === undefined) delete process.env['ComSpec'];
      else process.env['ComSpec'] = before;
    }

    expect(calls[0]?.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});

describe('which way selfCheck starts a hook line by default', () => {
  async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      return await fn();
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
  }

  it.each(['antigravity', 'cursor', 'codex'])(
    'goes through cmd.exe, as the host does, for %s on Windows',
    async (agent) => {
      const { selfCheck } = await import('../../src/commands/init-selfcheck.js');

      await withPlatform('win32', () => selfCheck(agent, `node entry.js hook ${agent}`));

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.file).toMatch(/cmd\.exe$/i);
        expect(call.args?.slice(0, 2)).toEqual(['/d', '/c']);
      }
    },
  );

  it.each(['claude-code'])('goes through a shell for %s on Windows', async (agent) => {
    const { selfCheck } = await import('../../src/commands/init-selfcheck.js');

    await withPlatform('win32', () => selfCheck(agent, `node entry.js hook ${agent}`));

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options['shell']).toBe(true);
  });

  it('goes through a shell for Antigravity anywhere but Windows', async () => {
    const { selfCheck } = await import('../../src/commands/init-selfcheck.js');

    await withPlatform('darwin', () => selfCheck('antigravity', 'node entry.js hook antigravity'));

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options['shell']).toBe(true);
  });
});
