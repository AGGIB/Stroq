import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleStdoutError } from '../src/stdout-errors.js';
import { onInterrupt } from '../src/ui/cleanup.js';

const error = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;

afterEach(() => {
  process.exitCode = undefined;
});

describe('handleStdoutError', () => {
  it('ends quietly with the exit code so far when the reader of a pipe is done', () => {
    const exit = vi.fn();

    handleStdoutError(error('EPIPE'), exit);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps the exit code that was already set when the reader of a pipe is done', () => {
    const exit = vi.fn();
    process.exitCode = 3;

    handleStdoutError(error('EPIPE'), exit);

    expect(exit).toHaveBeenCalledWith(3);
  });

  // A hang-up: the terminal is gone, the write fails with EIO, and what a screen made is still on disk.
  it('undoes what is registered, and ends as a hang-up ends a process, when the terminal went away', () => {
    const exit = vi.fn();
    const undo = vi.fn();
    onInterrupt(undo);

    handleStdoutError(error('EIO'), exit);

    expect(undo).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(129);
  });

  it('throws any other error: it is a failure', () => {
    const exit = vi.fn();

    expect(() => handleStdoutError(error('ENOSPC'), exit)).toThrow('ENOSPC');
    expect(exit).not.toHaveBeenCalled();
  });
});
