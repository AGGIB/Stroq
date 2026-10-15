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
import { buildCopilotHooks } from '../../../src/commands/copilot-hooks.js';
import { createThrowawayRoot, type Throwaway } from '../../../src/live/throwaway.js';

const script = resolve('scripts/capture-copilot-fixture.ts');
const run = (action: string, raw: string, extra?: string) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', script, action, raw, ...(extra === undefined ? [] : [extra])],
    { encoding: 'utf8', timeout: 15_000 },
  );

const hookFiles = (made: Throwaway): string[] => [
  join(made.project, '.github', 'hooks', 'stroq.json'),
  join(made.home, '.copilot', 'hooks', 'stroq.json'),
  join(made.home, 'hooks', 'stroq.json'),
];

function preparedCapture() {
  const raw = mkdtempSync(join(tmpdir(), 'stroq-copilot-path-raw-'));
  const made = createThrowawayRoot('stroq-copilot-path-project-');
  writeFileSync(join(raw, 'location.json'), JSON.stringify(made));
  const recorder = join(raw, 'record-hook.mjs');
  const built = buildCopilotHooks(
    `"${process.execPath}" "${recorder}" pre`,
    `"${process.execPath}" "${recorder}" post`,
  );
  const files = hookFiles(made);
  const originals = files.map((file, i) => {
    mkdirSync(dirname(file), { recursive: true });
    // Different content and formatting make copying the project file over a user file observable.
    const text =
      JSON.stringify({ ...built, syntheticCopy: i }, null, i * 2) + (i === 1 ? '' : '\n');
    writeFileSync(file, text);
    return readFileSync(file);
  });
  const escapeParent = (index: number): string => {
    const parent = dirname(files[index]!);
    const outside = join(raw, `outside-hooks-${index}`);
    renameSync(parent, outside);
    symlinkSync(outside, parent, 'junction');
    return join(outside, 'stroq.json');
  };
  return { raw, made, files, originals, escapeParent, backup: join(raw, 'hook.backup.json') };
}

describe('Copilot capture path boundaries (synthetic inputs, no host)', () => {
  it('restores every distinct original byte for byte and refuses repeated control', () => {
    const f = preparedCapture();
    expect(new Set(f.originals.map(String)).size).toBe(3);
    const controlled = run('control', f.raw);
    expect(controlled.status, controlled.stderr).toBe(0);
    for (const [i, file] of f.files.entries()) {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      expect(current.hooks.preToolUse).toEqual([]);
      expect(current.hooks.postToolUse).toEqual(
        JSON.parse(f.originals[i]!.toString()).hooks.postToolUse,
      );
    }
    const backup = readFileSync(f.backup);
    const controls = f.files.map((file) => readFileSync(file));
    expect(run('control', f.raw).status).not.toBe(0);
    expect(readFileSync(f.backup)).toEqual(backup);
    f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(controls[i]));

    const restored = run('restore', f.raw);
    expect(restored.status, restored.stderr).toBe(0);
    f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(f.originals[i]));
    // Even after restoration, an existing backup cannot be replaced by a second control run.
    expect(run('control', f.raw).status).not.toBe(0);
    expect(readFileSync(f.backup)).toEqual(backup);
    f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(f.originals[i]));
  });

  it('restores a partially applied control without confusing an original for an external edit', () => {
    const f = preparedCapture();
    const controlled = run('control', f.raw);
    expect(controlled.status, controlled.stderr).toBe(0);
    writeFileSync(f.files[0]!, f.originals[0]!);
    const restored = run('restore', f.raw);
    expect(restored.status, restored.stderr).toBe(0);
    f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(f.originals[i]));
  });

  it('preflights all control copies before restoring any when one was edited externally', () => {
    const f = preparedCapture();
    const controlled = run('control', f.raw);
    expect(controlled.status, controlled.stderr).toBe(0);
    const changed = '{"syntheticExternalEdit":true}\n';
    writeFileSync(f.files[2]!, changed);
    const before = f.files.map((file) => readFileSync(file));
    const backup = readFileSync(f.backup);
    expect(run('restore', f.raw).status).not.toBe(0);
    f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(before[i]));
    expect(readFileSync(f.backup)).toEqual(backup);
  });

  it.each([0, 1, 2])('refuses control through an escaping parent of hook copy %i', (index) => {
    const f = preparedCapture();
    const outside = f.escapeParent(index);
    expect(run('control', f.raw).status).not.toBe(0);
    expect(readFileSync(outside)).toEqual(f.originals[index]);
    f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(f.originals[i]));
    expect(existsSync(f.backup)).toBe(false);
  });

  it('refuses restore through an escaping user parent before changing any other copy', () => {
    const f = preparedCapture();
    const controlled = run('control', f.raw);
    expect(controlled.status, controlled.stderr).toBe(0);
    const before = f.files.map((file) => readFileSync(file));
    const backup = readFileSync(f.backup);
    const outside = f.escapeParent(2);
    expect(run('restore', f.raw).status).not.toBe(0);
    expect(readFileSync(outside)).toEqual(before[2]);
    f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(before[i]));
    expect(readFileSync(f.backup)).toEqual(backup);
  });

  it.each(['project', 'home', 'stroqHome'] as const)(
    'refuses a forged %s identity even if it names another marked throwaway',
    (key) => {
      const f = preparedCapture();
      const foreign = createThrowawayRoot('stroq-copilot-path-foreign-');
      const foreignFiles = hookFiles(foreign);
      foreignFiles.forEach((file, i) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, f.originals[i]!);
      });
      writeFileSync(
        join(f.raw, 'location.json'),
        JSON.stringify({ ...f.made, [key]: foreign[key] }),
      );
      expect(run('control', f.raw).status).not.toBe(0);
      expect(existsSync(f.backup)).toBe(false);
      f.files.forEach((file, i) => expect(readFileSync(file)).toEqual(f.originals[i]));
      foreignFiles.forEach((file, i) => expect(readFileSync(file)).toEqual(f.originals[i]));
    },
  );

  it('refuses to read a snapshot file through an escaping parent', () => {
    const f = preparedCapture();
    const outside = join(f.raw, 'outside-settings');
    mkdirSync(outside);
    const file = join(outside, 'settings.json');
    const original = '{"syntheticOutside":"unchanged"}\n';
    writeFileSync(file, original);
    symlinkSync(outside, join(f.made.project, '.claude'), 'junction');
    expect(run('snapshot', f.raw, 'before').status).not.toBe(0);
    expect(existsSync(join(f.raw, 'before.snapshot.json'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('keeps an existing snapshot unchanged instead of overwriting its evidence', () => {
    const f = preparedCapture();
    const first = run('snapshot', f.raw, 'before');
    expect(first.status, first.stderr).toBe(0);
    const file = join(f.raw, 'before.snapshot.json');
    const before = readFileSync(file);
    writeFileSync(join(f.made.project, 'sample.txt'), 'synthetic later content');
    expect(run('snapshot', f.raw, 'before').status).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'isolates the version query inside the prepared fake home',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'stroq-copilot-version-isolation-'));
      const executable = join(root, 'synthetic-copilot-version');
      const recorded = join(root, 'environment.txt');
      const quoted = `'${recorded.replace(/'/g, `'\\''`)}'`;
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' "$HOME" "$USERPROFILE" "$COPILOT_HOME" "$STROQ_HOME" > ${quoted}\nprintf 'GitHub Copilot CLI 1.0.98\\n'\n`,
        { mode: 0o700 },
      );
      const raw = join(root, 'raw');
      const result = run('prepare', raw, executable);
      expect(result.status, result.stderr).toBe(0);
      const made = JSON.parse(readFileSync(join(raw, 'location.json'), 'utf8')) as Throwaway;
      expect(readFileSync(recorded, 'utf8').trimEnd().split('\n')).toEqual([
        made.home,
        made.home,
        made.home,
        made.stroqHome,
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a raw parent link that resolves inside the repository',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'stroq-copilot-raw-boundary-'));
      const repo = join(root, 'synthetic-repository');
      const dist = join(repo, 'packages', 'cli', 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'index.js'), '// synthetic build, never executed\n');
      writeFileSync(join(repo, 'packages', 'cli', 'package.json'), '{"version":"0.0.0"}\n');
      const parentLink = join(root, 'outside-link');
      symlinkSync(repo, parentLink, 'junction');
      const executable = join(root, 'synthetic-copilot-version');
      writeFileSync(executable, '#!/bin/sh\nprintf "GitHub Copilot CLI 1.0.98\\n"\n', {
        mode: 0o700,
      });
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          resolve('node_modules/tsx/dist/loader.mjs'),
          script,
          'prepare',
          join(parentLink, 'raw'),
          executable,
        ],
        { cwd: repo, encoding: 'utf8', timeout: 15_000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('outside');
      expect(existsSync(join(repo, 'raw'))).toBe(false);
    },
  );
});
