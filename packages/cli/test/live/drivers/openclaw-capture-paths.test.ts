import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installOpenClawPlugin } from '../../../src/commands/openclaw-plugin.js';
import { createThrowawayRoot, type Throwaway } from '../../../src/live/throwaway.js';

const script = resolve('scripts/capture-openclaw-fixture.ts');
const run = (action: string, raw: string, extra?: string) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', script, action, raw, ...(extra === undefined ? [] : [extra])],
    { encoding: 'utf8', timeout: 15_000 },
  );
function preparedCapture() {
  const raw = mkdtempSync(join(tmpdir(), 'stroq-openclaw-path-raw-'));
  const made = createThrowawayRoot('stroq-openclaw-path-project-');
  writeFileSync(join(raw, 'location.json'), JSON.stringify(made));
  const plugin = join(made.home, '.stroq', 'openclaw-plugin');
  installOpenClawPlugin(plugin, [process.execPath, join(raw, 'record-hook.mjs')]);
  const file = join(plugin, 'index.js');
  const original = readFileSync(file);
  const escape = () => {
    const outside = join(raw, 'outside-plugin');
    renameSync(plugin, outside);
    symlinkSync(outside, plugin, 'junction');
    return join(outside, 'index.js');
  };
  return {
    raw,
    made,
    file,
    original,
    escape,
    get backup() {
      return join(
        raw,
        existsSync(join(raw, 'index.backup.json')) ? 'index.backup.json' : 'index.backup.js',
      );
    },
  };
}

describe('OpenClaw capture boundaries (synthetic inputs, no host)', () => {
  it('disables only the pre gate, preserves post, restores exact bytes and refuses repeated control', () => {
    const f = preparedCapture();
    const result = run('control', f.raw);
    expect(result.status, result.stderr).toBe(0);
    const controlled = readFileSync(f.file);
    expect(controlled.equals(f.original)).toBe(false);
    const post = "api.on('after_tool_call'";
    expect(controlled.toString().slice(controlled.toString().indexOf(post))).toBe(
      f.original.toString().slice(f.original.toString().indexOf(post)),
    );
    const backup = readFileSync(f.backup);
    expect(run('control', f.raw).status).not.toBe(0);
    expect(readFileSync(f.backup)).toEqual(backup);
    expect(readFileSync(f.file)).toEqual(controlled);
    const restored = run('restore', f.raw);
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(f.file)).toEqual(f.original);
    expect(run('control', f.raw).status).not.toBe(0);
    expect(readFileSync(f.backup)).toEqual(backup);
  });
  it('refuses restore over an external plugin edit', () => {
    const f = preparedCapture();
    expect(run('control', f.raw).status).toBe(0);
    const changed = '// synthetic external edit\n';
    writeFileSync(f.file, changed);
    expect(run('restore', f.raw).status).not.toBe(0);
    expect(readFileSync(f.file, 'utf8')).toBe(changed);
  });
  it('refuses a control when the prepared gate is missing', () => {
    const f = preparedCapture();
    const changed = '// not the installed plugin\n';
    writeFileSync(f.file, changed);
    expect(run('control', f.raw).status).not.toBe(0);
    expect(readFileSync(f.file, 'utf8')).toBe(changed);
    expect(existsSync(f.backup)).toBe(false);
  });
  it.each(['control', 'restore'] as const)(
    'refuses %s through an escaping plugin parent',
    (action) => {
      const f = preparedCapture();
      if (action === 'restore') expect(run('control', f.raw).status).toBe(0);
      const before = readFileSync(f.file);
      const outside = f.escape();
      expect(run(action, f.raw).status).not.toBe(0);
      expect(readFileSync(outside)).toEqual(before);
    },
  );
  it.each(['project', 'home', 'stroqHome'] as const)(
    'refuses a forged %s even in another marked root',
    (key) => {
      const f = preparedCapture();
      const foreign = createThrowawayRoot('stroq-openclaw-foreign-');
      installOpenClawPlugin(join(foreign.home, '.stroq', 'openclaw-plugin'), [
        process.execPath,
        join(f.raw, 'record-hook.mjs'),
      ]);
      writeFileSync(
        join(f.raw, 'location.json'),
        JSON.stringify({ ...f.made, [key]: foreign[key] }),
      );
      expect(run('control', f.raw).status).not.toBe(0);
      expect(readFileSync(f.file)).toEqual(f.original);
      expect(readFileSync(join(foreign.home, '.stroq', 'openclaw-plugin', 'index.js'))).toEqual(
        f.original,
      );
    },
  );
  it('refuses reading a snapshot through an escaping parent', () => {
    const f = preparedCapture();
    const outside = join(f.raw, 'outside-settings');
    mkdirSync(outside);
    writeFileSync(join(outside, 'settings.json'), '{"syntheticOutside":true}\n');
    symlinkSync(outside, join(f.made.project, '.claude'), 'junction');
    expect(run('snapshot', f.raw, 'before').status).not.toBe(0);
    expect(existsSync(join(f.raw, 'before.snapshot.json'))).toBe(false);
  });
  it('keeps an existing snapshot unchanged', () => {
    const f = preparedCapture();
    expect(run('snapshot', f.raw, 'before').status).toBe(0);
    const file = join(f.raw, 'before.snapshot.json');
    const before = readFileSync(file);
    writeFileSync(join(f.made.project, 'sample.txt'), 'later');
    expect(run('snapshot', f.raw, 'before').status).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
  });
  it.skipIf(process.platform === 'win32')(
    'isolates the version query and records the build at preparation',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'stroq-openclaw-version-'));
      const executable = join(root, 'synthetic-openclaw');
      const recorded = join(root, 'env.txt');
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' "$HOME" "$USERPROFILE" "$OPENCLAW_STATE_DIR" "$STROQ_HOME" > '${recorded.replace(/'/g, "'\\''")}'\nprintf 'OpenClaw 2026.10.3\\n'\n`,
        { mode: 0o700 },
      );
      const raw = join(root, 'raw');
      const result = run('prepare', raw, executable);
      expect(result.status, result.stderr).toBe(0);
      const made = JSON.parse(readFileSync(join(raw, 'location.json'), 'utf8')) as Throwaway;
      expect(readFileSync(recorded, 'utf8').trimEnd().split('\n')).toEqual([
        made.home,
        made.home,
        join(made.home, '.openclaw'),
        made.stroqHome,
      ]);
      const version = JSON.parse(readFileSync(join(raw, 'version.json'), 'utf8'));
      expect(version.stroqBuild.cliSha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'refuses a raw parent link resolving inside the repository',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'stroq-openclaw-raw-'));
      const repo = join(root, 'synthetic-repository');
      const dist = join(repo, 'packages', 'cli', 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'index.js'), '// synthetic, never executed\n');
      writeFileSync(join(dirname(dist), 'package.json'), '{"version":"0.0.0"}\n');
      const link = join(root, 'outside-link');
      symlinkSync(repo, link, 'junction');
      const executable = join(root, 'synthetic-openclaw');
      writeFileSync(executable, '#!/bin/sh\nprintf "OpenClaw 2026.10.3\\n"\n', { mode: 0o700 });
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          script,
          'prepare',
          join(link, 'raw'),
          executable,
        ],
        { cwd: repo, encoding: 'utf8', timeout: 15000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('outside');
      expect(existsSync(join(repo, 'raw'))).toBe(false);
    },
  );
});
