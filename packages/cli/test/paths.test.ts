import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupsDirIn,
  bindingsFileIn,
  cliDirIn,
  hardenDirIn,
  keysDirIn,
  liveDirIn,
  openclawPluginDirIn,
  passportsFileIn,
  pluginCliDirIn,
  policyFile,
  policyFileIn,
  stroqHome,
  storeDirIn,
  tasksDirIn,
} from '../src/paths.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stroqHome', () => {
  it('is the directory STROQ_HOME names', () => {
    vi.stubEnv('STROQ_HOME', '/srv/stroq-home');

    expect(stroqHome()).toBe('/srv/stroq-home');
  });

  it('is ~/.stroq where STROQ_HOME is not set', () => {
    vi.stubEnv('STROQ_HOME', undefined as unknown as string);
    delete process.env['STROQ_HOME'];

    expect(stroqHome()).toBe(join(homedir(), '.stroq'));
  });

  // A fifth review: an empty variable was a directory named "", and what Stroq keeps (the install record,
  // the audit log) was written in the folder it was run in.
  it('is ~/.stroq where STROQ_HOME is empty: an empty variable is not a directory', () => {
    vi.stubEnv('STROQ_HOME', '');

    expect(stroqHome()).toBe(join(homedir(), '.stroq'));
  });
});

// The layout of a home, for what has to be named once: `run/sandbox.ts` protects these, and a
// name that is spelled twice is a name that can be changed in one place.
describe('the layout of a Stroq home', () => {
  const HOME = '/srv/stroq-home';

  // Pinned by hand, on purpose. Other software knows these by name: the hook that `init` writes
  // points into `cli/<version>`, the plugin wrapper builds `plugin-cli/<version>` in shell, the
  // Gateway loads `openclaw-plugin`, and a `policy.yaml` is the file a user wrote. Changing one
  // is a migration, and this makes it a decision.
  it('names the policy and the three directories that hold the code the hooks run', () => {
    expect(policyFileIn(HOME)).toBe(join(HOME, 'policy.yaml'));
    expect(cliDirIn(HOME)).toBe(join(HOME, 'cli'));
    expect(pluginCliDirIn(HOME)).toBe(join(HOME, 'plugin-cli'));
    expect(openclawPluginDirIn(HOME)).toBe(join(HOME, 'openclaw-plugin'));
  });

  it('names the places that features still to come keep their state, ahead of them', () => {
    expect(keysDirIn(HOME)).toBe(join(HOME, 'keys'));
    expect(liveDirIn(HOME)).toBe(join(HOME, 'live'));
    expect(hardenDirIn(HOME)).toBe(join(HOME, 'harden'));
    expect(backupsDirIn(HOME)).toBe(join(HOME, 'backups'));
    expect(storeDirIn(HOME)).toBe(join(HOME, 'store'));
    expect(passportsFileIn(HOME)).toBe(join(HOME, 'passports.json'));
    expect(tasksDirIn(HOME)).toBe(join(HOME, 'tasks'));
    expect(bindingsFileIn(HOME)).toBe(join(HOME, 'bindings.yaml'));
  });

  it('puts the policy in the real home when asked for the real one', () => {
    vi.stubEnv('STROQ_HOME', '/srv/real-home');
    expect(policyFile()).toBe(join('/srv/real-home', 'policy.yaml'));
    expect(policyFile()).toBe(policyFileIn(stroqHome()));
  });

  it('gives every name a path of its own, under the home and nowhere else', () => {
    const paths = [
      policyFileIn,
      cliDirIn,
      pluginCliDirIn,
      openclawPluginDirIn,
      keysDirIn,
      liveDirIn,
      hardenDirIn,
      backupsDirIn,
      storeDirIn,
      passportsFileIn,
      tasksDirIn,
      bindingsFileIn,
    ].map((path) => path(HOME));
    expect(new Set(paths).size).toBe(paths.length);
    const root = `${join(HOME)}${sep}`;
    for (const path of paths) expect(path.startsWith(root), path).toBe(true);
  });
});
