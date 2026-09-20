import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  exitCodeFor,
  launch,
  type LaunchChild,
  type LaunchSpawn,
  type SignalSource,
} from '../../src/run/launch.js';

class FakeChild extends EventEmitter implements LaunchChild {
  readonly pid = 4242;
  readonly killed: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

class FakeSignals implements SignalSource {
  private readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();
  on(signal: NodeJS.Signals, listener: () => void): this {
    (this.listeners.get(signal) ?? this.listeners.set(signal, new Set()).get(signal)!).add(
      listener,
    );
    return this;
  }
  off(signal: NodeJS.Signals, listener: () => void): this {
    this.listeners.get(signal)?.delete(listener);
    return this;
  }
  fire(signal: NodeJS.Signals): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }
  count(signal: NodeJS.Signals): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

function harness() {
  const child = new FakeChild();
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const spawnFn: LaunchSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    return child;
  };
  const signals = new FakeSignals();
  const written: string[] = [];
  return {
    child,
    calls,
    signals,
    written,
    spawnFn,
    stderr: { write: (s: string) => written.push(s) },
  };
}

describe('exitCodeFor', () => {
  it('passes the child’s own status through untouched', () => {
    expect(exitCodeFor(0, null, 'linux')).toBe(0);
    expect(exitCodeFor(42, null, 'linux')).toBe(42);
  });

  // The shell's convention, and the one a CI script reads: an agent stopped with
  // Ctrl-C must not look like an agent that finished cleanly.
  it('reports a signal death as 128 plus the signal number', () => {
    expect(exitCodeFor(null, 'SIGINT', 'linux')).toBe(130);
    expect(exitCodeFor(null, 'SIGTERM', 'linux')).toBe(143);
  });

  it('reports a Windows termination as a plain failure, because it carried no signal', () => {
    expect(exitCodeFor(null, 'SIGTERM', 'win32')).toBe(1);
  });

  it('never returns 0 for an outcome it cannot read', () => {
    expect(exitCodeFor(null, null, 'linux')).toBe(1);
    expect(exitCodeFor(null, 'SIGNOSUCH' as NodeJS.Signals, 'linux')).toBe(1);
  });
});

describe('launch', () => {
  it('hands the agent its own argv, the environment it was given, and the terminal', async () => {
    const h = harness();
    const done = launch({
      command: 'claude',
      args: ['--model', 'opus'],
      env: { PATH: '/bin', GIT_CONFIG_COUNT: '2' },
      plat: 'linux',
      spawnFn: h.spawnFn,
      signals: h.signals,
      stderr: h.stderr,
    });
    h.child.emit('close', 0, null);
    expect(await done).toBe(0);
    expect(h.calls[0]?.file).toBe('claude');
    expect(h.calls[0]?.args).toEqual(['--model', 'opus']);
    expect(h.calls[0]?.options).toMatchObject({
      stdio: 'inherit',
      env: { PATH: '/bin', GIT_CONFIG_COUNT: '2' },
    });
  });

  it('returns the agent’s exit code', async () => {
    const h = harness();
    const done = launch({
      command: 'claude',
      args: [],
      env: {},
      plat: 'linux',
      spawnFn: h.spawnFn,
      signals: h.signals,
      stderr: h.stderr,
    });
    h.child.emit('close', 7, null);
    expect(await done).toBe(7);
  });

  // A launcher that dies on Ctrl-C before its child does loses the child's status
  // and can leave it running, which is worse than not being there at all.
  it('relays a signal to the agent and stays alive for the agent’s own answer', async () => {
    const h = harness();
    const killed: { signal: NodeJS.Signals }[] = [];
    const done = launch({
      command: 'claude',
      args: [],
      env: {},
      plat: 'linux',
      spawnFn: h.spawnFn,
      signals: h.signals,
      stderr: h.stderr,
      kill: (_child, signal) => killed.push({ signal }),
    });
    h.signals.fire('SIGINT');
    expect(killed).toEqual([{ signal: 'SIGINT' }]);
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    h.child.emit('close', null, 'SIGINT');
    expect(await done).toBe(130);
  });

  it('leaves no signal listener behind when it returns', async () => {
    const h = harness();
    const done = launch({
      command: 'claude',
      args: [],
      env: {},
      plat: 'linux',
      spawnFn: h.spawnFn,
      signals: h.signals,
      stderr: h.stderr,
    });
    expect(h.signals.count('SIGINT')).toBe(1);
    h.child.emit('close', 0, null);
    await done;
    expect(h.signals.count('SIGINT')).toBe(0);
    expect(h.signals.count('SIGTERM')).toBe(0);
  });

  it('reports a program that is not there as 127, naming it', async () => {
    const h = harness();
    const done = launch({
      command: 'claude',
      args: [],
      env: {},
      plat: 'linux',
      spawnFn: h.spawnFn,
      signals: h.signals,
      stderr: h.stderr,
    });
    h.child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    expect(await done).toBe(127);
    expect(h.written.join('')).toContain('claude');
  });

  it('reports any other spawn failure as 1 rather than as a clean exit', async () => {
    const h = harness();
    const done = launch({
      command: 'claude',
      args: [],
      env: {},
      plat: 'linux',
      spawnFn: h.spawnFn,
      signals: h.signals,
      stderr: h.stderr,
    });
    h.child.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect(await done).toBe(1);
  });

  it('kills the process tree on Windows, where a signal reaches one process only', async () => {
    const h = harness();
    const killSpawns: string[] = [];
    const done = launch({
      command: 'claude',
      args: [],
      env: {},
      plat: 'win32',
      spawnFn: h.spawnFn,
      signals: h.signals,
      stderr: h.stderr,
      killSpawn: ((file: string) => {
        killSpawns.push(file);
        return { on: () => undefined, unref: () => undefined };
      }) as never,
    });
    h.signals.fire('SIGTERM');
    expect(killSpawns).toEqual(['taskkill']);
    h.child.emit('close', null, 'SIGTERM');
    expect(await done).toBe(1);
  });
});
