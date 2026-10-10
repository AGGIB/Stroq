import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runRun } from '../../src/commands/run.js';
import { cliDirIn, pluginCliDirIn, policyFileIn, secretsFileIn } from '../../src/paths.js';
import { stroqVersion } from '../../src/version.js';
import { SRT, capture, sandboxRun, scratch, useWorlds, world } from '../helpers/run-world.js';
import { under } from '../run/state-names.js';

/**
 * What `stroq run --sandbox` says about the config it generates (`reportSandbox`). The config itself is
 * `run/sandbox.test.ts`; whether srt enforces it is `run/sandbox.live.test.ts`; how the file for srt is
 * written is `run-sandbox-config.test.ts`.
 */

useWorlds();

describe('what the sandbox report says is not protected', () => {
  describe('on a platform other than macOS', () => {
    it('names the protected names that are not there, and what the agent can do with them', async () => {
      const w = world();
      writeFileSync(secretsFileIn(w.home), '{}');
      mkdirSync(cliDirIn(w.home));
      const text = await sandboxRun(w, { plat: 'linux' });
      const line = text.split('\n').find((l) => /not protected/i.test(l)) ?? '';
      expect(line).not.toBe('');
      // The names that are absent, as words of the line, and not the two that are there.
      const words = line.split(/[\s,():;]+/);
      for (const name of ['policy.yaml', 'trust.json', 'plugin-cli', 'keys', 'bindings.yaml'])
        expect(words, name).toContain(name);
      expect(words).not.toContain('secrets.json');
      expect(words).not.toContain('cli');
      // The consequence: a policy.yaml the agent makes is read as the policy.
      expect(line).toMatch(/policy\.yaml/);
      expect(line).toMatch(/create/i);
      expect(line).toMatch(/replaces the policy/i);
      // One line, and it says where.
      expect(line).toContain(w.home);
    });

    it('says nothing of the kind when every protected name is there', async () => {
      const w = world();
      for (const path of under(w.home)) {
        if (path.endsWith('.json') || path.endsWith('.yaml')) writeFileSync(path, '');
        else mkdirSync(path);
      }
      const text = await sandboxRun(w, { plat: 'linux' });
      expect(text).not.toMatch(/not protected/i);
    });

    it.each(['freebsd', 'win32'] as const)('says it on %s as well', async (plat) => {
      const w = world();
      const text = await sandboxRun(w, { plat });
      expect(text).toMatch(/not protected/i);
      expect(text).toContain('policy.yaml');
    });

    it('lists no name that is there', async () => {
      const w = world();
      writeFileSync(policyFileIn(w.home), 'rules: []\n');
      const text = await sandboxRun(w, { plat: 'linux' });
      const line = text.split('\n').find((l) => /not protected/i.test(l)) ?? '';
      // The names come before the home they are in; the sentence after it names policy.yaml for what it does.
      const names = line.slice(0, line.indexOf('(in '));
      expect(names).not.toContain('policy.yaml');
      expect(names).toContain('trust.json');
    });
  });

  describe('on macOS', () => {
    it('does not say that names are unprotected, as every one of them is listed', async () => {
      const w = world();
      const text = await sandboxRun(w, { plat: 'darwin' });
      expect(text).not.toMatch(/not protected/i);
    });
  });

  describe.each(['darwin', 'linux', 'win32'] as const)('on %s', (plat) => {
    // The hooks are entries in the host's own configuration, which the config leaves writable: the
    // agent's state directory has to be, or the agent does not start. A program that is run outside what the
    // gate of Stroq's own commands reads can edit them.
    it('says what the config does not cover: the hook entries of the host stay writable', async () => {
      const w = world();
      const text = await sandboxRun(w, { plat });
      const line = text.split('\n').find((l) => /not covered/i.test(l)) ?? '';
      expect(line).not.toBe('');
      expect(line).toContain('settings.json');
      expect(line).toContain('hooks.json');
      expect(line).toMatch(/plugin cache/i);
      expect(line).toMatch(/writable/i);
      expect(line).toMatch(/switch the firewall off/i);
      expect(line).toMatch(/task mode/i);
    });
  });

  it('says nothing about a sandbox when there is none', async () => {
    const w = world();
    const out = capture();
    try {
      await runRun(['--dry-run', '--force', '--no-inspect', '--', 'claude'], w.cwd, {
        srt: () => SRT,
        plat: 'linux',
        userHome: w.userHome,
      });
    } finally {
      out.restore();
    }
    expect(out.text()).not.toMatch(/not protected|not covered|sandbox:/i);
  });
});

describe('a dry run lists what the real run uses', () => {
  /** The settings JSON a dry run prints after "would run". */
  function printedSettings(text: string): unknown {
    const from = text.indexOf('{\n  "filesystem"');
    expect(from, text).toBeGreaterThan(-1);
    return JSON.parse(text.slice(from, text.lastIndexOf('}') + 1));
  }

  it('prints the settings that the launch writes for srt', async () => {
    const w = world();
    // A credential file in the user's home and one in the project: the lists have something in them.
    mkdirSync(join(w.userHome, '.aws'));
    writeFileSync(
      join(w.userHome, '.aws', 'credentials'),
      '[default]\naws_secret_access_key = x\n',
    );
    writeFileSync(join(w.cwd, '.env'), 'TOKEN=abc\n');
    const dry = printedSettings(await sandboxRun(w, { plat: 'darwin' }));
    let written: unknown = null;
    await sandboxRun(
      w,
      {
        plat: 'darwin',
        launch: async ({ args }) => {
          written = JSON.parse(readFileSync(args[1] as string, 'utf8'));
          return 0;
        },
      },
      [],
    );
    expect(written).toEqual(dry);
    const lists = (written as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
    expect(lists).toContain(join(w.userHome, '.aws', 'credentials'));
    expect(lists).toContain(join(w.cwd, '.env'));
  });
});

describe('the copy of the CLI that the plugin’s wrapper installs, which the sandbox does not let it make', () => {
  // `stroq-hook.sh` makes `plugin-cli/<version>` itself (mkdir -p, mv), and on macOS a directory that is
  // denied and does not exist yet cannot be made. A sandboxed Claude Code with the plugin, started before the
  // wrapper ever ran, cannot start its hook.
  const NOTE = /run once without the sandbox so the wrapper can install its pinned copy/;

  it('is said on macOS when plugin-cli/<version> is not there, with the path and the version', async () => {
    const w = world();
    const text = await sandboxRun(w, { plat: 'darwin' });
    const line = text.split('\n').find((l) => NOTE.test(l)) ?? '';
    expect(line).not.toBe('');
    expect(line).toContain(join(pluginCliDirIn(w.home), stroqVersion()));
  });

  it('is not said when the copy is there', async () => {
    const w = world();
    mkdirSync(join(pluginCliDirIn(w.home), stroqVersion()), { recursive: true });
    expect(await sandboxRun(w, { plat: 'darwin' })).not.toMatch(NOTE);
  });

  it('is said for the version of the CLI that is run, and not for another one', async () => {
    const w = world();
    mkdirSync(join(pluginCliDirIn(w.home), '0.0.1'), { recursive: true });
    expect(await sandboxRun(w, { plat: 'darwin' })).toMatch(NOTE);
  });

  it.each(['linux', 'win32'] as const)(
    'is not said on %s, where the name is not denied',
    async (plat) => {
      const w = world();
      expect(await sandboxRun(w, { plat })).not.toMatch(NOTE);
    },
  );

  it('is not said when srt is not there and no sandbox is made', async () => {
    const w = world();
    const out = capture();
    try {
      await runRun(['--dry-run', '--force', '--no-inspect', '--sandbox', '--', 'claude'], w.cwd, {
        srt: () => null,
        plat: 'darwin',
        userHome: w.userHome,
      });
    } finally {
      out.restore();
    }
    expect(out.text()).not.toMatch(NOTE);
  });
});

describe('paths that srt would read as patterns', () => {
  it('refuses a Stroq home that holds one, and says so', async () => {
    const w = world();
    const odd = join(dirname(w.home), 'st[roq]');
    mkdirSync(odd);
    vi.stubEnv('STROQ_HOME', odd);
    const text = await sandboxRun(w, { plat: 'darwin' });
    const line = text.split('\n').find((l) => /refused/.test(l) && l.includes(odd)) ?? '';
    expect(line, text).not.toBe('');
    expect(line).toMatch(/pattern/i);
    expect(line).toMatch(/Stroq/);
    // And the home is not a root the agent can write.
    expect(text).not.toContain(`can write: ${odd}`);
  });

  // A wider root (here the workspace) still lets the agent write in a home that is refused as a root, and the
  // denies for its state are patterns that match nothing: the names are unprotected, and for that reason, on any
  // platform, whether they exist or not.
  it.each(['darwin', 'linux'] as const)(
    'names the state of such a home as unprotected when another root covers it, on %s',
    async (plat) => {
      const w = world();
      const odd = join(w.cwd, 'st[roq]');
      mkdirSync(odd);
      writeFileSync(policyFileIn(odd), 'rules: []\n');
      vi.stubEnv('STROQ_HOME', odd);
      const text = await sandboxRun(w, { plat });
      const line = text.split('\n').find((l) => /not protected/i.test(l)) ?? '';
      expect(line, text).not.toBe('');
      expect(line).toContain('policy.yaml');
      expect(line).toContain(odd);
      expect(line).toMatch(/pattern/i);
      expect(line).not.toMatch(/do not exist/i);
    },
  );

  it('says that a credential file under such a path is not protected', async () => {
    const w = world();
    const userHome = join(scratch('stroq-run-pattern-'), 'me[1]');
    mkdirSync(join(userHome, '.aws'), { recursive: true });
    writeFileSync(join(userHome, '.aws', 'credentials'), '[default]\naws_secret_access_key = x\n');
    const text = await sandboxRun({ ...w, userHome }, { plat: 'darwin' });
    const line = text.split('\n').find((l) => /cannot deny/i.test(l)) ?? '';
    expect(line, text).not.toBe('');
    expect(line).toContain(join(userHome, '.aws', 'credentials'));
    expect(line).toMatch(/pattern/i);
  });

  it('says nothing of patterns for ordinary paths', async () => {
    const w = world();
    mkdirSync(join(w.userHome, '.aws'));
    writeFileSync(
      join(w.userHome, '.aws', 'credentials'),
      '[default]\naws_secret_access_key = x\n',
    );
    const text = await sandboxRun(w, { plat: 'darwin' });
    expect(text).not.toMatch(/cannot deny|pattern/i);
  });
});
