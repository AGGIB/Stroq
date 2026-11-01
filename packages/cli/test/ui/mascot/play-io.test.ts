import { describe, expect, it, vi } from 'vitest';

// The two writers that skip the safe-output filter, replaced: what playGreeting writes by default
// must go through them, and through no other.
vi.mock('../../../src/terminal-safe.js', () => ({
  writeUnfiltered: vi.fn(),
  writeErrUnfiltered: vi.fn(),
}));

import { writeErrUnfiltered, writeUnfiltered } from '../../../src/terminal-safe.js';
import { playGreeting } from '../../../src/ui/mascot/play.js';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const instantly = async (): Promise<void> => undefined;

describe('playGreeting: where it writes', () => {
  it('writes to standard output through writeUnfiltered, whose escape codes the safe filter would mangle', async () => {
    vi.mocked(writeUnfiltered).mockClear();
    vi.mocked(writeErrUnfiltered).mockClear();

    await playGreeting({ colorMode: 'ansi16', textLines: ['Hoo'], sleep: instantly });

    const calls = vi.mocked(writeUnfiltered).mock.calls.map(([text]) => text);
    expect(calls[0]).toBe(HIDE_CURSOR);
    expect(calls.at(-1)).toBe(SHOW_CURSOR);
    expect(calls.length).toBe(8);
    expect(writeErrUnfiltered).not.toHaveBeenCalled();
  });

  it('writes to standard error through writeErrUnfiltered when it is asked to', async () => {
    vi.mocked(writeUnfiltered).mockClear();
    vi.mocked(writeErrUnfiltered).mockClear();

    await playGreeting({
      colorMode: 'truecolor',
      textLines: ['Hoo'],
      stream: 'stderr',
      sleep: instantly,
    });

    const calls = vi.mocked(writeErrUnfiltered).mock.calls.map(([text]) => text);
    expect(calls[0]).toBe(HIDE_CURSOR);
    expect(calls.at(-1)).toBe(SHOW_CURSOR);
    expect(writeUnfiltered).not.toHaveBeenCalled();
  });

  it('prefers a writer it is given to both', async () => {
    vi.mocked(writeUnfiltered).mockClear();
    const write = vi.fn();

    await playGreeting({ colorMode: 'ansi16', textLines: [], write, sleep: instantly });

    expect(write).toHaveBeenCalled();
    expect(writeUnfiltered).not.toHaveBeenCalled();
  });
});
