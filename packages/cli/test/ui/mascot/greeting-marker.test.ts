import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { greetedFileIn, hasGreeted, markGreeted } from '../../../src/ui/mascot/greeted.js';
import { playGreeting, type PlayOptions } from '../../../src/ui/mascot/play.js';

const isWindows = process.platform === 'win32';

let home = '';

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), 'stroq-mascot-flow-')), 'home');
});

afterEach(() => {
  rmSync(join(home, '..'), { recursive: true, force: true });
});

/** How the command will use the two together: the marker is written when the greeting finished. */
const greet = (extra: Partial<PlayOptions> = {}): Promise<string> => {
  const writes: string[] = [];
  return playGreeting({
    colorMode: 'ansi16',
    textLines: ['Hoo'],
    write: (text) => {
      writes.push(text);
    },
    sleep: async (_ms, signal) => {
      await Promise.resolve();
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
    onFinished: () => {
      markGreeted(home);
    },
    ...extra,
  });
};

describe('the marker and the greeting', () => {
  it('is written once the greeting has finished, and the next run shows a still frame', async () => {
    expect(hasGreeted(home)).toBe(false);

    await expect(greet()).resolves.toBe('finished');

    expect(hasGreeted(home)).toBe(true);
    expect(existsSync(greetedFileIn(home))).toBe(true);
  });

  it('is not written when the greeting was interrupted', async () => {
    const controller = new AbortController();

    const outcome = await greet({
      signal: controller.signal,
      sleep: async (_ms, signal) => {
        controller.abort();
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });

    expect(outcome).toBe('interrupted');
    expect(existsSync(greetedFileIn(home))).toBe(false);
    expect(hasGreeted(home)).toBe(false);
  });

  it('is not written when drawing failed', async () => {
    await expect(
      greet({
        write: () => {
          throw new Error('EPIPE');
        },
      }),
    ).rejects.toThrow('EPIPE');

    expect(existsSync(greetedFileIn(home))).toBe(false);
  });

  it('is not written when the card did not fit and only a still frame was drawn', async () => {
    await expect(greet({ columns: 25 })).resolves.toBe('still');

    expect(existsSync(greetedFileIn(home))).toBe(false);
  });

  it.skipIf(isWindows)(
    'is not written through a link, and the greeting still finishes',
    async () => {
      mkdirSync(home);
      const victim = join(home, '..', 'victim.txt');
      writeFileSync(victim, 'precious');
      symlinkSync(victim, greetedFileIn(home));

      await expect(greet()).resolves.toBe('finished');

      expect(readFileSync(victim, 'utf8')).toBe('precious');
      expect(lstatSync(greetedFileIn(home)).isSymbolicLink()).toBe(true);
    },
  );

  it('does not fail the greeting when the marker cannot be written', async () => {
    mkdirSync(join(home, '..'), { recursive: true });
    writeFileSync(home, 'a file where the home should be');

    await expect(greet()).resolves.toBe('finished');

    expect(hasGreeted(home)).toBe(true);
  });
});
