import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autorunOf, isStroqOwnHook } from '../../src/card/autorun.js';
import { mergeCursorHooks } from '../../src/commands/cursor-hooks.js';
import { windowsHookCommands, windowsTools } from '../../src/commands/hook-command.js';

describe.skipIf(process.platform !== 'win32')('own hooks written by init on Windows', () => {
  let root: string;
  let home: string;
  let node: string;
  let entry: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stroq-card-windows-'));
    home = join(root, 'stroq');
    node = join(root, 'node.exe');
    entry = join(home, 'cli', 'index.js');
    project = join(root, 'project');
    mkdirSync(dirname(entry), { recursive: true });
    mkdirSync(join(project, '.cursor'), { recursive: true });
    writeFileSync(node, 'fixture');
    writeFileSync(entry, '// fixture');
    vi.stubEnv('STROQ_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('omits a project whose Cursor hooks only start the installed Stroq', () => {
    const [forward, backward] = windowsHookCommands(node, entry, 'cursor');
    for (const command of [forward!, backward!]) {
      expect(command).not.toContain('"');
      writeFileSync(
        join(project, '.cursor', 'hooks.json'),
        JSON.stringify(mergeCursorHooks({}, command)),
      );
      expect(autorunOf(project)).toBeNull();
    }
  });

  it('resolves the Windows alias to its real file before checking the install', () => {
    const short = windowsTools().shortPath(root);
    expect(short).not.toBeNull();
    expect(realpathSync.native(short!)).toBe(realpathSync.native(root));
    expect(
      isStroqOwnHook(
        `${join(short!, 'node.exe')} ${join(short!, 'stroq', 'cli', 'index.js')} hook codex`,
        project,
        home,
      ),
    ).toBe(true);
  });

  it('keeps hooks with a project entry, shell syntax, or an implicit program on the card', () => {
    const local = join(project, 'index.js');
    writeFileSync(local, '// foreign');
    for (const command of [
      `${node} ${local} hook codex`,
      `node ${entry} hook codex`,
      `${node} ${entry} hook claude-code`,
      `${node} ${entry} hook codex & whoami`,
      `${node} ${entry} hook codex\n`,
    ])
      expect(isStroqOwnHook(command, project, home), command).toBe(false);
  });
});
