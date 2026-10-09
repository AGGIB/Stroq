import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canaryFilesFileIn,
  installRecordFileIn,
  secretsFileIn,
  stroqHome,
  trustFileIn,
} from '../../src/paths.js';
import { generateSandbox, srtArgv } from '../../src/run/sandbox.js';

const inputs = (over: Partial<Parameters<typeof generateSandbox>[0]> = {}) =>
  generateSandbox({
    workspace: '/work/repo',
    stroqHome: '/home/me/.stroq',
    userHome: '/home/me',
    tmp: ['/tmp'],
    agentState: ['/home/me/.claude'],
    secretPaths: ['/home/me/.aws/credentials', '/work/repo/.env'],
    allowedDomains: [],
    ...over,
  });

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
// their state there. That left the agent able to rewrite the files the NEXT call is judged by:
// the policy, the secret index, the trust and canary records. These tests pin the generated
// config only. Nothing here runs srt, so whether srt enforces a `denyWrite` entry inside an
// `allowWrite` directory is not shown by them; a live test against the real srt has to.
describe.skipIf(process.platform === 'win32')(
  'the Stroq state the generated config denies writes to',
  () => {
    afterEach(() => vi.unstubAllEnvs());

    const HOME = '/home/me/.stroq';
    const CREDENTIALS = ['/home/me/.aws/credentials', '/work/repo/.env'];
    /**
     * Written out by hand, not read back from the module, so that a typo in the module is
     * caught. The names that no feature creates yet are here on purpose.
     */
    const STATE = [
      'policy.yaml',
      'secrets.json',
      'trust.json',
      'canary-files.json',
      'install.json',
      'keys',
      'live',
      'harden',
      'backups',
      'store',
      'passports.json',
      'tasks',
      'bindings.yaml',
    ];
    const under = (home: string): string[] => STATE.map((name) => join(home, name));
    const denyWriteOf = (over: Partial<Parameters<typeof generateSandbox>[0]> = {}) =>
      inputs(over).settings.filesystem.denyWrite;

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

    it('names the files paths.ts names, so that renaming one there cannot leave it unprotected', () => {
      const denied = denyWriteOf();
      for (const file of [secretsFileIn, trustFileIn, canaryFilesFileIn, installRecordFileIn])
        expect(denied).toContain(file(HOME));
    });

    it('keeps the whole home writable, because the hooks inside the sandbox write their state there', () => {
      const { allowWrite } = inputs().settings.filesystem;
      expect(allowWrite).toContain(HOME);
      for (const path of under(HOME))
        expect(
          allowWrite.some((root) => path.startsWith(`${root}/`)),
          path,
        ).toBe(true);
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
    });

    it('does not hide the state: reads and the other lists are as they were', () => {
      const { settings } = inputs();
      expect(settings.filesystem.denyRead).toEqual(CREDENTIALS);
      expect(settings.filesystem.allowWrite).toEqual([
        '/work/repo',
        '/tmp',
        '/home/me/.stroq',
        '/home/me/.claude',
      ]);
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
