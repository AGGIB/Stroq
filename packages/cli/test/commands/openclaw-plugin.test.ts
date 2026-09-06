import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OPENCLAW_COMMAND_FILE,
  OPENCLAW_PLUGIN_FILES,
  OPENCLAW_PLUGIN_ID,
  installOpenClawPlugin,
  isStroqOpenClawPlugin,
  openclawInstallArgv,
  openclawInstallCommands,
  openclawOnPath,
  openclawPluginDir,
  packagedPluginDir,
  runOpenClawInstall,
  type RunCommand,
} from '../../src/commands/openclaw-plugin.js';

const cliDir = join(import.meta.dirname, '../..');
const command = ['/usr/bin/node', '/opt/stroq/dist/index.js'];
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe('the packaged plugin', () => {
  it('is found from the built entry and from the TypeScript source', () => {
    // `import.meta.url` is `dist/index.js` in a published install and
    // `src/commands/openclaw-plugin.ts` under tsx, which are different depths.
    for (const from of [join(cliDir, 'dist'), join(cliDir, 'src/commands'), cliDir])
      expect(packagedPluginDir(from), from).toBe(join(cliDir, 'openclaw-plugin'));
    expect(() => packagedPluginDir(tmp('stroq-openclaw-nowhere-'))).toThrow(/cannot find/);
  });

  it('ships exactly the four files the manifest needs', () => {
    expect(OPENCLAW_PLUGIN_FILES).toEqual([
      'openclaw.plugin.json',
      'package.json',
      'index.js',
      'README.md',
    ]);
    for (const name of OPENCLAW_PLUGIN_FILES)
      expect(existsSync(join(packagedPluginDir(), name)), name).toBe(true);
  });

  it('declares the id, the entry and no dependencies', () => {
    const dir = packagedPluginDir();
    const manifest = JSON.parse(readFileSync(join(dir, 'openclaw.plugin.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest['id']).toBe(OPENCLAW_PLUGIN_ID);
    expect(manifest['configSchema']).toBeDefined();
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg['type']).toBe('module');
    expect(pkg['openclaw']).toEqual({ extensions: [{ entry: 'index.js' }] });
    // The Gateway runs `npm install --ignore-scripts` on a linked plugin; a plugin
    // with dependencies is one that can fail to install inside someone else's process.
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['devDependencies']).toBeUndefined();
  });

  it('carries the CLI version, so a release bump cannot leave it behind', () => {
    const version = (
      JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    for (const name of ['openclaw.plugin.json', 'package.json']) {
      const json = JSON.parse(readFileSync(join(packagedPluginDir(), name), 'utf8')) as {
        version: string;
      };
      expect(json.version, name).toBe(version);
    }
  });

  it('is small enough to review in one sitting', () => {
    // Every line here runs inside the Gateway process and is not covered by the
    // engine's own suite; 200 is the budget the plan sets.
    const lines = readFileSync(join(packagedPluginDir(), 'index.js'), 'utf8').split('\n').length;
    expect(lines).toBeLessThanOrEqual(200);
  });

  it('is listed in the package files, so it actually ships', () => {
    const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('openclaw-plugin');
  });
});

describe('openclawPluginDir', () => {
  it('lives under the Stroq home, and honours STROQ_HOME', () => {
    expect(openclawPluginDir({ STROQ_HOME: '/opt/stroq-home' })).toBe(
      '/opt/stroq-home/openclaw-plugin',
    );
    expect(openclawPluginDir({})).toMatch(/\.stroq\/openclaw-plugin$/);
    // An empty variable is not a home directory.
    expect(openclawPluginDir({ STROQ_HOME: '' })).toMatch(/\.stroq\/openclaw-plugin$/);
  });
});

describe('installOpenClawPlugin', () => {
  it('copies the four files, records the command, and is idempotent', () => {
    const dir = join(tmp('stroq-openclaw-install-'), 'openclaw-plugin');
    const written = installOpenClawPlugin(dir, command);
    expect(written).toHaveLength(5);
    for (const name of [...OPENCLAW_PLUGIN_FILES, OPENCLAW_COMMAND_FILE])
      expect(existsSync(join(dir, name)), name).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, OPENCLAW_COMMAND_FILE), 'utf8'))).toEqual({
      command,
    });
    expect(isStroqOpenClawPlugin(dir)).toBe(true);

    const before = readFileSync(join(dir, 'index.js'), 'utf8');
    installOpenClawPlugin(dir, command);
    expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe(before);
  });

  it('replaces a plugin an older Stroq installed, command included', () => {
    const dir = join(tmp('stroq-openclaw-install-'), 'openclaw-plugin');
    installOpenClawPlugin(dir, ['/old/node', '/old/index.js']);
    installOpenClawPlugin(dir, command);
    expect(readFileSync(join(dir, OPENCLAW_COMMAND_FILE), 'utf8')).not.toContain('/old/node');
  });
});

describe('isStroqOpenClawPlugin', () => {
  it('recognises only a directory carrying Stroq’s own entry and manifest', () => {
    const empty = tmp('stroq-openclaw-empty-');
    expect(isStroqOpenClawPlugin(empty)).toBe(false);

    const wrong = tmp('stroq-openclaw-foreign-');
    writeFileSync(join(wrong, 'index.js'), 'export const register = () => {};');
    // An entry with no manifest, and a manifest belonging to somebody else, are both
    // "not installed": reporting either as installed would promise protection the
    // Gateway is not actually loading.
    expect(isStroqOpenClawPlugin(wrong)).toBe(false);
    writeFileSync(join(wrong, 'openclaw.plugin.json'), '{"id":"someone-else"}');
    expect(isStroqOpenClawPlugin(wrong)).toBe(false);
    writeFileSync(join(wrong, 'openclaw.plugin.json'), '{ not json');
    expect(isStroqOpenClawPlugin(wrong)).toBe(false);
  });
});

describe('the two openclaw commands', () => {
  it('links the directory and enables the id, quoting only when it has to', () => {
    expect(openclawInstallArgv('/home/dev/.stroq/openclaw-plugin')).toEqual([
      ['plugins', 'install', '--link', '/home/dev/.stroq/openclaw-plugin'],
      ['plugins', 'enable', 'stroq'],
    ]);
    expect(openclawInstallCommands('/home/dev/.stroq/openclaw-plugin')).toEqual([
      'openclaw plugins install --link /home/dev/.stroq/openclaw-plugin',
      'openclaw plugins enable stroq',
    ]);
    expect(openclawInstallCommands('/home/my dev/.stroq/openclaw-plugin')[0]).toBe(
      "openclaw plugins install --link '/home/my dev/.stroq/openclaw-plugin'",
    );
  });

  it('runs both, so an already-linked plugin still gets enabled', () => {
    const calls: string[][] = [];
    const run: RunCommand = (file, args) => {
      calls.push([file, ...args]);
      // The first command failing is the ordinary "already installed" case.
      return { status: args[1] === 'install' ? 1 : 0, output: `ran ${args[1]}\n` };
    };
    const outcomes = runOpenClawInstall('/usr/bin/openclaw', '/w/plugin', run);
    expect(calls).toEqual([
      ['/usr/bin/openclaw', 'plugins', 'install', '--link', '/w/plugin'],
      ['/usr/bin/openclaw', 'plugins', 'enable', 'stroq'],
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([false, true]);
    expect(outcomes[0]?.line).toBe('openclaw plugins install --link /w/plugin');
    expect(outcomes[1]?.output).toBe('ran enable\n');
  });
});

describe('openclawOnPath', () => {
  it('finds an executable openclaw on PATH and nothing else', () => {
    const dir = tmp('stroq-openclaw-path-');
    const other = tmp('stroq-openclaw-path-');
    expect(openclawOnPath({ PATH: [other, dir].join(delimiter) })).toBeNull();
    expect(openclawOnPath({})).toBeNull();

    // A file that is not executable is not a binary anyone can run.
    const bin = join(dir, 'openclaw');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o644);
    expect(openclawOnPath({ PATH: dir })).toBeNull();
    chmodSync(bin, 0o755);
    expect(openclawOnPath({ PATH: [other, dir].join(delimiter) })).toBe(bin);
  });

  it('skips empty PATH entries rather than probing the working directory', () => {
    // `join('', 'openclaw')` is a relative path, which would probe whatever directory
    // the process happens to be in — never a place a Gateway CLI is looked for.
    expect(openclawOnPath({ PATH: `${delimiter}${delimiter}` })).toBeNull();
    expect(openclawOnPath({ PATH: '' })).toBeNull();
  });
});
