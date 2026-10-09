import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cliDirIn,
  openclawPluginDirIn,
  pluginCliDirIn,
  secretsFileIn,
  stroqHome,
} from '../../src/paths.js';
import { generateSandbox, srtArgv, type SandboxHost } from '../../src/run/sandbox.js';
import { under } from './state-names.js';

const inputs = (over: Partial<Parameters<typeof generateSandbox>[0]> = {}, host?: SandboxHost) =>
  generateSandbox(
    {
      workspace: '/work/repo',
      stroqHome: '/home/me/.stroq',
      userHome: '/home/me',
      tmp: ['/tmp'],
      agentState: ['/home/me/.claude'],
      secretPaths: ['/home/me/.aws/credentials', '/work/repo/.env'],
      allowedDomains: [],
      ...over,
    },
    host,
  );

// srt sandboxes macOS and Linux; its Windows support is an alpha and the config it
// would read there is not verified, so these POSIX paths are checked on POSIX only.
describe.skipIf(process.platform === 'win32')(
  'the srt config stroq run --sandbox generates',
  () => {
    it('denies reads on exactly the credential files the secret index knows about', () => {
      const { settings } = inputs();
      expect(settings.filesystem.denyRead).toEqual([
        '/home/me/.aws/credentials',
        '/work/repo/.env',
      ]);
    });

    // A file the agent cannot read but can truncate is still a file it can destroy,
    // and `.env` sits inside the workspace, which has to stay writable.
    it('denies writes on the same files, inside the writable workspace', () => {
      const { settings } = inputs();
      expect(settings.filesystem.denyWrite).toContain('/work/repo/.env');
    });

    it('allows writes to the workspace, temp, Stroq state and the agent state only', () => {
      const { settings } = inputs();
      expect(settings.filesystem.allowWrite).toEqual([
        '/work/repo',
        '/tmp',
        '/home/me/.stroq',
        '/home/me/.claude',
      ]);
    });

    // Stroq's own hooks run inside the sandbox and write the audit chain, the session
    // store and the secret index; without this the guard cannot record anything.
    it('keeps the Stroq home writable, because the hooks run inside the sandbox too', () => {
      expect(inputs().settings.filesystem.allowWrite).toContain('/home/me/.stroq');
    });

    it('refuses a write root broad enough to make the sandbox meaningless', () => {
      const { settings, refused } = inputs({ agentState: ['/', '/home/me'] });
      expect(refused).toEqual(['/', '/home/me']);
      expect(settings.filesystem.allowWrite).not.toContain('/');
      expect(settings.filesystem.allowWrite).not.toContain('/home/me');
    });

    it('lists each path once, however many inputs name it', () => {
      const { settings } = inputs({ tmp: ['/tmp', '/tmp'], agentState: ['/work/repo'] });
      expect(settings.filesystem.allowWrite).toEqual(['/work/repo', '/tmp', '/home/me/.stroq']);
    });

    it('leaves the network at srt’s deny-all until a domain is named', () => {
      expect(inputs().settings.network.allowedDomains).toEqual([]);
      expect(
        inputs({ allowedDomains: ['api.anthropic.com'] }).settings.network.allowedDomains,
      ).toEqual(['api.anthropic.com']);
    });

    it('never writes a deniedDomains entry of its own', () => {
      expect(inputs().settings.network.deniedDomains).toEqual([]);
    });
  },
);

// The Stroq home is an `allowWrite` root because the hooks run inside the sandbox and write
// their state there. That left the agent able to rewrite what the NEXT call is judged by (the
// policy, the secret index, the trust and canary records) and the code the hooks run (the copy of
// the CLI, the plugin wrapper's copy, the OpenClaw plugin). These tests pin the generated config.
// Whether srt enforces it is `sandbox.live.test.ts`, which runs the real srt and is opt-in.
describe.skipIf(process.platform === 'win32')(
  'the Stroq state the generated config denies writes to',
  () => {
    afterEach(() => vi.unstubAllEnvs());

    const HOME = '/home/me/.stroq';
    const CREDENTIALS = ['/home/me/.aws/credentials', '/work/repo/.env'];
    /**
     * What the tests that name paths that are not there pass: the links of a path are not resolved
     * (`/home` is a mount point on a Mac, and would come back as `/System/Volumes/Data/home`).
     */
    const PLAIN = { realpath: (path: string): string => path };
    /** macOS lists every one of them, whether it exists or not. */
    const MAC: SandboxHost = { ...PLAIN, platform: 'darwin', exists: () => false };
    const denyWriteOf = (
      over: Partial<Parameters<typeof generateSandbox>[0]> = {},
      host: SandboxHost = MAC,
    ) => inputs(over, host).settings.filesystem.denyWrite;

    it('denies writes to each one once, after the credential files, in a fixed order', () => {
      expect(denyWriteOf()).toEqual([...CREDENTIALS, ...under(HOME)]);
    });

    it('resolves them against the home it is given, and names nothing under any other', () => {
      const denied = denyWriteOf({ stroqHome: '/srv/elsewhere/stroq-home' });
      expect(denied).toEqual([...CREDENTIALS, ...under('/srv/elsewhere/stroq-home')]);
      expect(denied.some((path) => path.startsWith(HOME))).toBe(false);
    });

    // `stroq run` passes `stroqHome()`, which is where STROQ_HOME overrides the real one.
    it('follows STROQ_HOME when the home comes from stroqHome(), and the real one without it', () => {
      vi.stubEnv('STROQ_HOME', '/srv/override/.stroq');
      expect(denyWriteOf({ stroqHome: stroqHome() })).toEqual([
        ...CREDENTIALS,
        ...under('/srv/override/.stroq'),
      ]);
      vi.stubEnv('STROQ_HOME', '');
      const real = join(homedir(), '.stroq');
      expect(denyWriteOf({ stroqHome: stroqHome() })).toEqual([...CREDENTIALS, ...under(real)]);
    });

    // What hooks run is what the agent must not be able to replace: a hook that points at a file the
    // agent rewrote runs the agent's code as the firewall. Three directories under the home hold it.
    it('protects the code the hooks run: the CLI copy, the plugin wrapper’s copy, the OpenClaw plugin', () => {
      const denied = denyWriteOf();
      for (const dir of [cliDirIn, pluginCliDirIn, openclawPluginDirIn])
        expect(denied, dir(HOME)).toContain(dir(HOME));
    });

    // Named by hand as well, because other software knows them by these names: the hook that `init`
    // writes into an agent's config points into `cli/<version>`, the wrapper script builds
    // `plugin-cli/<version>` itself, and the Gateway loads `openclaw-plugin`. Renaming one is a
    // migration, and this makes it a decision.
    it('protects them under the names the producers already use', () => {
      expect(denyWriteOf()).toEqual(
        expect.arrayContaining([
          join(HOME, 'policy.yaml'),
          join(HOME, 'cli'),
          join(HOME, 'plugin-cli'),
          join(HOME, 'openclaw-plugin'),
        ]),
      );
    });

    it('keeps the whole home writable, because the hooks inside the sandbox write their state there', () => {
      const { allowWrite } = inputs({}, MAC).settings.filesystem;
      expect(allowWrite).toContain(HOME);
      for (const path of under(HOME))
        expect(
          allowWrite.some((root) => path.startsWith(`${root}/`)),
          path,
        ).toBe(true);
    });

    it('leaves the state the hooks write alone: sessions, the audit chain, the log, the stamps', () => {
      const denied = denyWriteOf();
      for (const name of ['sessions', 'audit.jsonl', 'stroq.log', 'last-hook', 'cloak', 'run'])
        expect(denied, name).not.toContain(join(HOME, name));
    });

    it('lists no path twice, whether a credential path or another input already names it', () => {
      const denied = denyWriteOf({
        secretPaths: [
          ...CREDENTIALS,
          `${HOME}/secrets.json`,
          `${HOME}/./trust.json`,
          CREDENTIALS[1]!,
        ],
      });
      expect(new Set(denied).size).toBe(denied.length);
      expect(denied.filter((path) => path === `${HOME}/secrets.json`)).toHaveLength(1);
      expect(denied.filter((path) => path === `${HOME}/trust.json`)).toHaveLength(1);
      expect(denied.slice(0, 4)).toEqual([
        ...CREDENTIALS,
        `${HOME}/secrets.json`,
        `${HOME}/trust.json`,
      ]);
    });

    it('writes no entry with a trailing separator, which srt refuses in a deny list', () => {
      for (const path of denyWriteOf()) expect(path.endsWith('/'), path).toBe(false);
      for (const path of denyWriteOf({ stroqHome: '/srv/home/' }))
        expect(path.endsWith('/')).toBe(false);
    });

    it('adds nothing for an empty home, rather than paths relative to wherever it runs', () => {
      expect(denyWriteOf({ stroqHome: '' })).toEqual(CREDENTIALS);
      expect(
        denyWriteOf({ stroqHome: '' }, { ...PLAIN, platform: 'linux', exists: () => true }),
      ).toEqual(CREDENTIALS);
    });

    it('does not hide the state: reads and the other lists are as they were', () => {
      const { settings } = inputs({}, MAC);
      expect(settings.filesystem.denyRead).toEqual(CREDENTIALS);
      expect(settings.filesystem.allowWrite).toEqual([
        '/work/repo',
        '/tmp',
        '/home/me/.stroq',
        '/home/me/.claude',
      ]);
    });

    // What was measured on macOS is that a `denyWrite` path that does not exist yet is denied and
    // nothing is created for it. On Linux, srt can only deny by mounting over a path, and for one
    // that is absent it makes an empty read-only file first (its README, "Write denies on paths
    // that do not exist yet"). `policy.yaml` is read as "a custom policy" where it exists, and an
    // empty one is no policy, so there a name is listed only if it is already there.
    describe('on a platform other than macOS', () => {
      const existing = new Set([secretsFileIn(HOME), cliDirIn(HOME), openclawPluginDirIn(HOME)]);
      const host = (platform: NodeJS.Platform): SandboxHost => ({
        ...PLAIN,
        platform,
        exists: (path) => existing.has(path),
      });

      it.each(['linux', 'freebsd', 'win32'] as const)(
        'lists the ones that exist when the config is made, on %s',
        (platform) => {
          expect(denyWriteOf({}, host(platform))).toEqual([
            ...CREDENTIALS,
            secretsFileIn(HOME),
            cliDirIn(HOME),
            openclawPluginDirIn(HOME),
          ]);
        },
      );

      it('lists none of them when none exists, and creates nothing for the ones that do not', () => {
        const asked: string[] = [];
        const denied = denyWriteOf(
          {},
          {
            ...PLAIN,
            platform: 'linux',
            exists: (path) => {
              asked.push(path);
              return false;
            },
          },
        );
        expect(denied).toEqual(CREDENTIALS);
        // It asked about every protected name, by its resolved path, and about nothing else.
        expect(asked).toEqual(under(HOME));
      });

      it('lists all of them when all exist, in the same order as on macOS', () => {
        expect(denyWriteOf({}, { ...PLAIN, platform: 'linux', exists: () => true })).toEqual(
          denyWriteOf({}, MAC),
        );
      });

      it('keeps the credential files whether or not they exist: they were found by reading them', () => {
        expect(denyWriteOf({}, { ...PLAIN, platform: 'linux', exists: () => false })).toEqual(
          CREDENTIALS,
        );
      });
    });

    describe('on macOS', () => {
      it('lists every one of them without asking whether it exists', () => {
        const asked: string[] = [];
        const denied = denyWriteOf(
          {},
          {
            ...PLAIN,
            platform: 'darwin',
            exists: (path) => {
              asked.push(path);
              return false;
            },
          },
        );
        expect(denied).toEqual([...CREDENTIALS, ...under(HOME)]);
        expect(asked).toEqual([]);
      });
    });
  },
);

describe('srtArgv', () => {
  it('names the generated config and stops flag parsing before the agent', () => {
    expect(srtArgv('/home/me/.stroq/run/1.json', 'claude', ['--model', 'opus'])).toEqual([
      '--settings',
      '/home/me/.stroq/run/1.json',
      '--',
      'claude',
      '--model',
      'opus',
    ]);
  });
});
