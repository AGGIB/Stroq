import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandboxRun, scratch, useWorlds, world } from '../helpers/run-world.js';

/** How `stroq run --sandbox` writes the config that srt is given (`writeSandboxConfig`). */

useWorlds();

// `srt` reads the config before the sandbox exists, so the file only has to be there for that moment. It
// is written under the Stroq home, which the sandbox leaves writable, so a name that can be guessed
// (`srt-<pid>.json`) is one that a previous run could have planted a link at.
describe.skipIf(process.platform === 'win32')('the config file srt is given', () => {
  it('is in a directory made for it, under the run directory, that only the user can enter', async () => {
    const w = world();
    let file = '';
    await sandboxRun(
      w,
      {
        plat: 'linux',
        launch: async ({ args }) => {
          file = args[1] as string;
          const dir = dirname(file);
          expect(dirname(dir)).toBe(join(w.home, 'run'));
          expect(statSync(dir).mode & 0o777).toBe(0o700);
          // One descriptor for the mode and the content: the file is not looked at twice by name.
          const fd = openSync(file, 'r');
          try {
            expect(fstatSync(fd).mode & 0o777).toBe(0o600);
            expect(JSON.parse(readFileSync(fd, 'utf8'))).toHaveProperty('filesystem');
          } finally {
            closeSync(fd);
          }
          return 0;
        },
      },
      [],
    );
    expect(file).not.toBe('');
  });

  it('is removed with its directory when the agent has ended', async () => {
    const w = world();
    let dir = '';
    await sandboxRun(
      w,
      {
        plat: 'linux',
        launch: async ({ args }) => {
          dir = dirname(args[1] as string);
          return 0;
        },
      },
      [],
    );
    expect(dir).not.toBe('');
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(join(w.home, 'run'))).toEqual([]);
  });

  it('is a new directory for each launch', async () => {
    const w = world();
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1)
      await sandboxRun(
        w,
        {
          plat: 'linux',
          launch: async ({ args }) => {
            seen.push(dirname(args[1] as string));
            return 0;
          },
        },
        [],
      );
    expect(new Set(seen).size).toBe(3);
  });

  // The name `srt-<pid>.json` was written with the flags of `writeFileSync`, which follow a link at the
  // end of the path: a link planted there by anything that could write the run directory would have been
  // written through, and the file it points to truncated.
  it('does not write through a link planted at the name that used to be used', async () => {
    const w = world();
    const victim = join(scratch('stroq-run-victim-'), 'victim.txt');
    writeFileSync(victim, 'keep');
    mkdirSync(join(w.home, 'run'), { recursive: true });
    for (let pid = process.pid - 2; pid <= process.pid + 2; pid += 1)
      symlinkSync(victim, join(w.home, 'run', `srt-${pid}.json`));
    await sandboxRun(w, { plat: 'linux', launch: async () => 0 }, []);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('is never made where a file already stands: the directory is new every time', async () => {
    const w = world();
    mkdirSync(join(w.home, 'run'), { recursive: true });
    const decoy = join(w.home, 'run', 'srt-decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'settings.json'), 'not the config');
    let dir = '';
    await sandboxRun(
      w,
      {
        plat: 'linux',
        launch: async ({ args }) => {
          dir = dirname(args[1] as string);
          return 0;
        },
      },
      [],
    );
    expect(dir).not.toBe(decoy);
    expect(readFileSync(join(decoy, 'settings.json'), 'utf8')).toBe('not the config');
  });
});
