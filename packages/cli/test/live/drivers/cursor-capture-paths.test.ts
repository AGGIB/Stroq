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
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createThrowawayRoot } from '../../../src/live/throwaway.js';

const script = resolve('scripts/capture-cursor-fixture.ts');
const run = (action: string, raw: string, extra?: string) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', script, action, raw, ...(extra === undefined ? [] : [extra])],
    { encoding: 'utf8', timeout: 15_000 },
  );

function preparedProject() {
  const raw = mkdtempSync(join(tmpdir(), 'stroq-cursor-path-raw-'));
  const made = createThrowawayRoot('stroq-cursor-path-project-');
  writeFileSync(join(raw, 'location.json'), JSON.stringify(made));
  const cursorDir = join(made.project, '.cursor');
  mkdirSync(cursorDir);
  const hooksFile = join(cursorDir, 'hooks.json');
  const original = JSON.stringify({
    version: 1,
    hooks: {
      preToolUse: [
        { command: `${process.execPath} ${join(raw, 'record-hook.mjs')}`, failClosed: true },
      ],
      afterFileEdit: [{ command: 'observation' }],
    },
  });
  writeFileSync(hooksFile, original);
  const moveCursorOutside = () => {
    const outside = join(raw, 'outside-cursor');
    renameSync(cursorDir, outside);
    symlinkSync(outside, cursorDir, 'junction');
    return join(outside, 'hooks.json');
  };
  return { raw, made, hooksFile, original, moveCursorOutside };
}

describe('Cursor capture path boundaries (synthetic inputs, no host)', () => {
  it.skipIf(process.platform === 'win32')(
    'prepares runnable absolute recorder and log paths from a relative raw directory',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'stroq-cursor-relative-'));
      const fakeVersion = join(root, 'synthetic-cursor-version');
      writeFileSync(fakeVersion, '#!/bin/sh\nprintf "3.24.18\\n"\n', { mode: 0o700 });
      const raw = join(root, 'raw');
      const prepared = run('prepare', relative(process.cwd(), raw), fakeVersion);
      expect(prepared.status, prepared.stderr).toBe(0);
      const made = JSON.parse(readFileSync(join(raw, 'location.json'), 'utf8'));
      const hooks = JSON.parse(readFileSync(join(made.project, '.cursor/hooks.json'), 'utf8'));
      const command = hooks.hooks.preToolUse[0].command as string;
      const recorder = command.match(/"([^"]*record-hook\.mjs)"$/)?.[1];
      expect(recorder).toBeDefined();
      expect(isAbsolute(recorder!)).toBe(true);
      const input = {
        conversation_id: 'synthetic-relative-capture',
        hook_event_name: 'preToolUse',
        workspace_roots: [made.project],
        tool_name: 'Write',
        tool_input: { file_path: join(made.project, 'scratch', 'ordinary.txt'), content: 'data' },
      };
      const response = spawnSync(process.execPath, [recorder!], {
        cwd: made.project,
        input: JSON.stringify(input),
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(response.status, response.stderr).toBe(0);
      expect(JSON.parse(response.stdout)).toEqual({ permission: 'allow' });
      const recorded = JSON.parse(readFileSync(join(raw, 'hooks.jsonl'), 'utf8').trim());
      expect(recorded.input).toEqual(input);
      expect(recorded.stdout).toBe(response.stdout);
    },
  );

  it('refuses control when a descendant directory links outside the prepared project', () => {
    const f = preparedProject();
    const outsideFile = f.moveCursorOutside();
    const result = run('control', f.raw);
    expect(result.status).not.toBe(0);
    expect(readFileSync(outsideFile, 'utf8')).toBe(f.original);
    expect(existsSync(join(f.raw, 'enforcing-hooks.json'))).toBe(false);
    expect(existsSync(join(f.raw, 'control-hooks-config.json'))).toBe(false);
  });

  it('refuses restore when the control configuration has moved outside the prepared project', () => {
    const f = preparedProject();
    const control = run('control', f.raw);
    expect(control.status, control.stderr).toBe(0);
    const outsideFile = f.moveCursorOutside();
    const before = readFileSync(outsideFile, 'utf8');
    const result = run('restore', f.raw);
    expect(result.status).not.toBe(0);
    expect(readFileSync(outsideFile, 'utf8')).toBe(before);
    expect(readFileSync(join(f.raw, 'enforcing-hooks.json'), 'utf8')).toBe(f.original);
  });

  it('refuses to snapshot file content reached through an escaping parent link', () => {
    const f = preparedProject();
    const outside = join(f.raw, 'outside-settings');
    mkdirSync(outside);
    const outsideFile = join(outside, 'settings.json');
    const before = '{"outside":"test-data"}\n';
    writeFileSync(outsideFile, before);
    symlinkSync(outside, join(f.made.project, '.claude'), 'junction');
    const result = run('snapshot', f.raw, 'before');
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.raw, 'before.snapshot.json'))).toBe(false);
    expect(readFileSync(outsideFile, 'utf8')).toBe(before);
  });

  it('permits an intentionally linked marked root while keeping operations inside its project', () => {
    const f = preparedProject();
    const linkedRoot = join(f.raw, 'linked-capture-root');
    symlinkSync(f.made.root, linkedRoot, 'junction');
    writeFileSync(
      join(f.raw, 'location.json'),
      JSON.stringify({ ...f.made, root: linkedRoot, project: join(linkedRoot, 'project') }),
    );
    const controlled = run('control', f.raw);
    expect(controlled.status, controlled.stderr).toBe(0);
    const restored = run('restore', f.raw);
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(f.hooksFile, 'utf8')).toBe(f.original);
    const snapshot = run('snapshot', f.raw, 'linked-root');
    expect(snapshot.status, snapshot.stderr).toBe(0);
    expect(existsSync(join(f.raw, 'linked-root.snapshot.json'))).toBe(true);
  });
});
