import { isMainThread } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { exitOnQuit, onInterrupt, runInterruptCleanups } from '../../src/ui/cleanup.js';
import { settled, startStep } from '../../src/ui/spinner.js';
import { styleFor } from '../../src/ui/style.js';
import { symbolsFor } from '../../src/ui/symbols.js';
import { fakeTerminal, fakeTimers } from '../helpers/fake-terminal.js';

describe('what is undone if the process is interrupted', () => {
  it('runs what is registered, once each', () => {
    const first = vi.fn();
    const second = vi.fn();
    onInterrupt(first);
    onInterrupt(second);

    runInterruptCleanups();
    runInterruptCleanups();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs the one registered last first, as what was started last is ended first', () => {
    const order: string[] = [];
    onInterrupt(() => order.push('the directory is removed'));
    onInterrupt(() => order.push('the hook is killed'));

    runInterruptCleanups();

    expect(order).toEqual(['the hook is killed', 'the directory is removed']);
  });

  it('does not run what was taken back out', () => {
    const undo = vi.fn();
    const forget = onInterrupt(undo);

    forget();
    runInterruptCleanups();

    expect(undo).not.toHaveBeenCalled();
  });

  it('runs the rest when one of them throws, and does not throw', () => {
    const after = vi.fn();
    onInterrupt(() => {
      throw new Error('already gone');
    });
    onInterrupt(after);

    expect(() => runInterruptCleanups()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('a step that is quit with Ctrl-\\', () => {
  it.skipIf(process.platform === 'win32')(
    'runs what is registered and exits with 131, and does not raise the signal again',
    () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        const undo = vi.fn();
        onInterrupt(undo);
        const fake = fakeTerminal({ interactive: true });
        const known = new Set<unknown>(process.listeners('SIGQUIT'));
        const step = startStep(
          fake.term,
          styleFor({ color: false, color256: false }),
          symbolsFor(true),
          'Checking',
          fakeTimers().timers,
        );
        const added = process.listeners('SIGQUIT').filter((listener) => !known.has(listener));
        expect(added).toHaveLength(1);

        (added[0] as () => void)();

        expect(undo).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(131);
        expect(kill).not.toHaveBeenCalled();
        expect(fake.out()).toContain('\u001b[?25h');
        step.succeed();
      } finally {
        kill.mockRestore();
        exit.mockRestore();
      }
    },
  );

  it('leaves no listener behind when the step ends', () => {
    const before = process.listenerCount('SIGQUIT');
    const step = startStep(
      fakeTerminal({ interactive: true }).term,
      styleFor({ color: false, color256: false }),
      symbolsFor(true),
      'Checking',
      fakeTimers().timers,
    );

    step.succeed();

    expect(process.listenerCount('SIGQUIT')).toBe(before);
  });
});

describe('settled', () => {
  it('lets the event loop run before it resolves, so that a signal that came is delivered', async () => {
    const seen: string[] = [];
    setImmediate(() => seen.push('a turn of the loop'));

    await settled();

    expect(seen).toEqual(['a turn of the loop']);
  });

  // Only a process that has the signals (a worker thread has none: the signal would end the test run).
  it.skipIf(process.platform === 'win32' || !isMainThread)(
    'delivers a signal that came while the process was busy, before it resolves',
    async () => {
      const handler = vi.fn();
      process.once('SIGUSR2', handler);
      process.kill(process.pid, 'SIGUSR2');

      await settled();

      expect(handler).toHaveBeenCalledTimes(1);
    },
  );
});

describe('a step that is interrupted', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'runs what is registered before it raises %s again',
    (signal) => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const undo = vi.fn();
      onInterrupt(undo);
      const fake = fakeTerminal({ interactive: true });
      const known = new Set<unknown>(process.listeners(signal));
      const step = startStep(
        fake.term,
        styleFor({ color: false, color256: false }),
        symbolsFor(true),
        'Checking',
        fakeTimers().timers,
      );
      const added = process.listeners(signal).filter((listener) => !known.has(listener));

      // Called directly: emitting the signal would reach every listener there is.
      (added[0] as () => void)();

      expect(undo).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
      step.succeed();
      kill.mockRestore();
    },
  );
});

describe('exitOnQuit', () => {
  it.skipIf(process.platform === 'win32')(
    'answers Ctrl-\\ for as long as it is wanted: what is registered is undone, and the exit code is 131',
    () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        const undo = vi.fn();
        onInterrupt(undo);
        const known = new Set<unknown>(process.listeners('SIGQUIT'));

        const release = exitOnQuit();
        const added = process.listeners('SIGQUIT').filter((listener) => !known.has(listener));
        expect(added).toHaveLength(1);
        (added[0] as () => void)();

        expect(undo).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(131);

        release();
        expect(process.listeners('SIGQUIT').filter((listener) => !known.has(listener))).toEqual([]);
      } finally {
        exit.mockRestore();
      }
    },
  );
});
