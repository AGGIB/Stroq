import { describe, expect, it } from 'vitest';
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
