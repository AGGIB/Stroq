import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliDirIn, policyFileIn, secretsFileIn } from '../../src/paths.js';
import { generateSandbox, type SandboxHost } from '../../src/run/sandbox.js';
import { under } from './state-names.js';

/**
 * The generated config, made against the file system it runs on instead of one a test makes up:
 * what exists is asked of the disk, and a home that is reached through a symlink is resolved. The
 * unit tests in `sandbox.test.ts` pass both in; these pass neither, with real temporary
 * directories.
 */

const denyWriteFor = (stroqHome: string, host?: SandboxHost): readonly string[] =>
  generateSandbox(
    {
      workspace: '/work/repo',
      stroqHome,
      userHome: '/home/me',
      tmp: [],
      agentState: [],
      secretPaths: [],
      allowedDomains: [],
    },
    host,
  ).settings.filesystem.denyWrite;

// Every directory a test makes is under this one, made before the tests and removed after them. Its real
// path: where a link leads is not what these tests are about.
let root = '';

/** A home with a secret index and a copy of the CLI in it, and none of the rest. */
function homeWithTwo(): string {
  const dir = mkdtempSync(join(root, 'home-'));
  writeFileSync(secretsFileIn(dir), '{}');
  mkdirSync(cliDirIn(dir));
  return dir;
}

describe.skipIf(process.platform === 'win32')('the config against the real file system', () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-sandbox-real-fs-')));
  });
  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  it('lists a name where it is on disk, on a platform that is not macOS', () => {
    const dir = homeWithTwo();
    expect(denyWriteFor(dir, { platform: 'linux' })).toEqual([secretsFileIn(dir), cliDirIn(dir)]);
  });

  // A link that points nowhere is something at that path, whatever it points to: `existsSync` says
  // it is not there, and a name that is there is one that is listed.
  it('counts a link that points nowhere as there', () => {
    const dir = homeWithTwo();
    symlinkSync(join(dir, 'nowhere'), policyFileIn(dir));
    expect(denyWriteFor(dir, { platform: 'linux' })).toEqual([
      policyFileIn(dir),
      secretsFileIn(dir),
      cliDirIn(dir),
    ]);
  });

  it.skipIf(process.platform !== 'darwin')('lists every name on this macOS, found or not', () => {
    const dir = homeWithTwo();
    expect(denyWriteFor(dir)).toEqual(under(dir));
  });

  it.skipIf(process.platform === 'darwin')(
    'lists only what is there on this platform, which is not macOS',
    () => {
      const dir = homeWithTwo();
      expect(denyWriteFor(dir)).toEqual([secretsFileIn(dir), cliDirIn(dir)]);
    },
  );

  // Measured on macOS (srt 0.0.77, `sandbox.live.test.ts`): a denied path that exists is matched
  // however it is written, but one that does not exist yet is matched only by its real path.
  // Written through `/tmp` or `/var`, which are links there, it was not denied and the write
  // created the file. A `STROQ_HOME` under a link is not unheard of, so the names are built from
  // the real path of the home.
  describe('a home reached through a symlink', () => {
    const MAC: SandboxHost = { platform: 'darwin' };

    function link(): { readonly real: string; readonly link: string } {
      const real = mkdtempSync(join(root, 'real-'));
      const holder = mkdtempSync(join(root, 'holder-'));
      const link = join(holder, 'stroq-home-link');
      symlinkSync(real, link);
      return { real, link };
    }

    it('names every state path by the real path of the home', () => {
      const { real, link: viaLink } = link();
      const denied = denyWriteFor(viaLink, MAC);
      expect(denied).toEqual(under(real));
      expect(denied.some((path) => path.startsWith(viaLink))).toBe(false);
    });

    it('resolves the part of the home that exists, and leaves the part that does not', () => {
      const { real, link: viaLink } = link();
      const denied = denyWriteFor(join(viaLink, 'not', 'made', 'yet'), MAC);
      expect(denied).toEqual(under(join(real, 'not', 'made', 'yet')));
    });

    it('resolves a link that is in the middle of the path', () => {
      const { real, link: viaLink } = link();
      mkdirSync(join(real, 'inner'));
      expect(denyWriteFor(join(viaLink, 'inner'), MAC)).toEqual(under(join(real, 'inner')));
    });

    it('leaves a home alone when it is reached by no link', () => {
      const dir = homeWithTwo();
      expect(denyWriteFor(dir, MAC)).toEqual(under(dir));
    });

    it('is asked of the same function that is injected, for every part of the path in turn', () => {
      const asked: string[] = [];
      const denied = denyWriteFor('/srv/a/b/stroq-home', {
        platform: 'darwin',
        realpath: (path) => {
          asked.push(path);
          if (path === '/srv/a') return '/mnt/real-a';
          throw new Error('ENOENT');
        },
      });
      expect(denied).toEqual(under('/mnt/real-a/b/stroq-home'));
      expect(asked).toEqual(['/srv/a/b/stroq-home', '/srv/a/b', '/srv/a']);
    });

    it('keeps the path as it was when nothing of it can be resolved', () => {
      const denied = denyWriteFor('/srv/a/b', {
        platform: 'darwin',
        realpath: () => {
          throw new Error('ENOENT');
        },
      });
      expect(denied).toEqual(under('/srv/a/b'));
    });
  });
});
