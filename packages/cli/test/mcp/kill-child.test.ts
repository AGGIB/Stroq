import { describe, expect, it } from 'vitest';
import { killChildTree, type KillSpawn } from '../../src/mcp/kill-child.js';

/**
 * Killing a wrapped or probed MCP server, away from any real process.
 *
 * The property that matters is not visible from one platform: on POSIX a signal to
 * the child is the whole job, while on Windows there are no signals at all and the
 * child is nearly always a `cmd.exe` running an `npx.cmd` shim, with the real server
 * one level below it. `child.kill()` there terminates the shim and leaves the server
 * running — a probe that timed out, or a client that exited, walks away from a live
 * process holding whatever credentials it was started with. Both the platform and
 * the spawner are injected so the Windows branch can be exercised on a Mac.
 */

/** Just enough of a ChildProcess for this helper, recording what it was asked to do. */
function fakeChild(pid: number | undefined) {
  const signals: (string | undefined)[] = [];
  return {
    pid,
    kill: (signal?: NodeJS.Signals): boolean => {
      signals.push(signal);
      return true;
    },
    signals,
  };
}

/** Records spawns and hands back an object with the one method the helper uses. */
function recordingSpawn(): KillSpawn & { calls: { file: string; args: readonly string[] }[] } {
  const calls: { file: string; args: readonly string[] }[] = [];
  const fn: KillSpawn = (file, args) => {
    calls.push({ file, args });
    return { on: () => undefined, unref: () => undefined };
  };
  return Object.assign(fn, { calls });
}

describe('killChildTree', () => {
  it('sends the signal and spawns nothing on POSIX', () => {
    const child = fakeChild(4242);
    const spawn = recordingSpawn();
    killChildTree(child, 'SIGTERM', 'linux', spawn);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(spawn.calls).toEqual([]);
  });

  it('takes the whole tree down on Windows, where the child is only a shim', () => {
    const child = fakeChild(4242);
    const spawn = recordingSpawn();
    killChildTree(child, 'SIGTERM', 'win32', spawn);
    // `/T` is the point of the call: it is what reaches the `node` process that the
    // `npx.cmd` shim started. `/F` is not an escalation over what Node would have
    // done — `child.kill('SIGTERM')` on Windows is already a TerminateProcess.
    expect(spawn.calls).toEqual([{ file: 'taskkill', args: ['/pid', '4242', '/T', '/F'] }]);
  });

  it('still signals the child on Windows, so a missing taskkill is not a live server', () => {
    const child = fakeChild(4242);
    killChildTree(child, 'SIGTERM', 'win32', recordingSpawn());
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('falls back to the signal alone when the child never got a pid', () => {
    // A child that failed to spawn has no pid, and `taskkill /pid undefined` would
    // either error or, worse, be handed some other process's id.
    const child = fakeChild(undefined);
    const spawn = recordingSpawn();
    killChildTree(child, 'SIGKILL', 'win32', spawn);
    expect(spawn.calls).toEqual([]);
    expect(child.signals).toEqual(['SIGKILL']);
  });

  it('does not throw when taskkill cannot be started at all', () => {
    const child = fakeChild(4242);
    const throwing = (() => {
      throw new Error('spawn taskkill ENOENT');
    }) as unknown as KillSpawn;
    expect(() => killChildTree(child, 'SIGTERM', 'win32', throwing)).not.toThrow();
    expect(child.signals).toEqual(['SIGTERM']);
  });
});
