import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseTaskArgv } from '../../src/task/args.js';
import { runTask } from '../../src/commands/task.js';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { prepareTask } from '../../src/task/prepare.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-task-test-'));
  dirs.push(dir);
  return dir;
};

describe('task command', () => {
  it('removes protected runtime and temporary home when preparation fails', () => {
    const home = temp();
    const entry = join(temp(), 'source.ts');
    writeFileSync(entry, 'test fixture');
    const taskId = `cleanup-failure-${Date.now()}`;
    expect(() => prepareTask(home, taskId, entry)).toThrow('built CLI');
    expect(readdirSync(join(home, 'task-runs'))).toEqual([]);
    expect(
      readdirSync(tmpdir()).filter((name) => name.startsWith(`stroq-${taskId}-home-`)),
    ).toEqual([]);
  });
  it('refuses project-local host executables before asking or signing', async () => {
    const launch = vi.fn();
    const confirm = vi.fn();
    const home = temp();
    const options = { home, srt: () => '/trusted/srt', managed: () => false, launch, confirm };
    await expect(
      runTask(['--', 'fix'], dirname(process.execPath), {
        ...options,
        claude: process.execPath,
      }),
    ).rejects.toThrow(/Node executable/);
    const cwd = temp();
    const agent = join(cwd, 'claude');
    writeFileSync(agent, 'test fixture');
    await expect(runTask(['--', 'fix'], cwd, { ...options, claude: agent })).rejects.toThrow(
      /agent runtime/,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'tasks'))).toBe(false);
  });
  it('refuses a pre-existing linked runtime directory', () => {
    const home = temp();
    symlinkSync(temp(), join(home, 'task-runs'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => prepareTask(home, 'linked-task', CLI_ENTRY)).toThrow(/linked|canonical/);
  });
  it('refuses managed hosts before asking or launching', async () => {
    const launch = vi.fn();
    const confirm = vi.fn();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runTask(['--', 'fix'], temp(), {
        home: temp(),
        srt: () => '/trusted/srt',
        managed: () => true,
        launch,
        confirm,
        claude: process.execPath,
      }),
    ).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
  it('launches through srt with protected state and a fresh immutable hook configuration', async () => {
    const home = temp();
    const cwd = temp();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const launch = vi.fn(
      async ({
        command,
        args,
        env,
      }: {
        command: string;
        args: readonly string[];
        env: NodeJS.ProcessEnv;
      }) => {
        expect(command).toBe('/trusted/srt');
        expect(args.slice(0, 3)).toEqual(['--settings', expect.any(String), '--']);
        expect(args[3]).toBe(process.execPath);
        const settings = JSON.parse(readFileSync(args[1] as string, 'utf8'));
        expect(settings.filesystem.denyWrite).toContain(home);
        expect(settings.filesystem.allowWrite).toContain(env['HOME']);
        expect(args).toContain('--restricted');
        expect(args[args.lastIndexOf('--setting-sources') + 1]).toBe('');
        expect(settings.network.allowedDomains).toContain('api.anthropic.com:443');
        return 0;
      },
    );
    expect(
      await runTask(['--', 'fix'], cwd, {
        home,
        srt: () => '/trusted/srt',
        claude: process.execPath,
        launch,
        confirm: async () => true,
        entry: CLI_ENTRY,
        managed: () => false,
      }),
    ).toBe(0);
    expect(launch).toHaveBeenCalledOnce();
  });
  it('parses repeated path restrictions and a bounded ttl', () => {
    expect(
      parseTaskArgv([
        '--read',
        'src/**',
        '--read',
        'test/**',
        '--write',
        'src/**',
        '--ttl',
        '30m',
        '--',
        'fix tests',
      ]),
    ).toMatchObject({
      read: ['src/**', 'test/**'],
      write: ['src/**'],
      ttlMs: 1_800_000,
      task: 'fix tests',
    });
  });
  it.each([
    [],
    ['--', ''],
    ['--ttl', '0m', '--', 'x'],
    ['--ttl', '25h', '--', 'x'],
    ['--profile', 'unknown', '--', 'x'],
    ['--bad', '--', 'x'],
    ['--read', '--', 'x'],
    ['--ttl', 'invalid', '--', 'x'],
    ['--', 'x', 'y'],
  ])('rejects malformed argv %j', (...argv) => {
    expect(() => parseTaskArgv(argv)).toThrow();
  });
  it('refuses to silently downgrade without srt', async () => {
    const launch = vi.fn();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runTask(['--', 'fix'], temp(), { home: temp(), env: { PATH: temp() }, launch }),
    ).toBe(1);
    expect(launch).not.toHaveBeenCalled();
  });
  it('refuses a missing Claude executable before confirmation', async () => {
    const confirm = vi.fn();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runTask(['--hook-only', '--', 'fix'], temp(), {
        home: temp(),
        env: { PATH: temp() },
        confirm,
      }),
    ).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('starts nothing without an interactive confirmation or after preview expiry', async () => {
    const home = temp();
    const launch = vi.fn();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const options = { home, claude: process.execPath, launch };
    expect(await runTask(['--hook-only', '--', 'fix'], temp(), options)).toBe(1);
    await expect(
      runTask(['--hook-only', '--', 'fix'], temp(), {
        ...options,
        now: () => new Date(Date.now() - 31 * 60_000),
        confirm: async () => true,
      }),
    ).rejects.toThrow('preview expired');
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'tasks'))).toBe(false);
  });
  it('shows scope before confirmation and writes nothing when declined', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const launch = vi.fn();
    const confirm = vi.fn(async () => {
      expect(out.mock.calls.flat().join('')).toContain('repo-edit-and-test');
      return false;
    });
    expect(
      await runTask(['--hook-only', '--', 'fix'], temp(), {
        home: temp(),
        confirm,
        launch,
        claude: process.execPath,
      }),
    ).toBe(1);
    expect(launch).not.toHaveBeenCalled();
  });
  it('pins the permit and uses a fake home and a receipt even when launch throws', async () => {
    const home = temp();
    const cwd = temp();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const launch = vi.fn(
      async ({ env, args }: { env: NodeJS.ProcessEnv; args: readonly string[] }) => {
        expect(env['HOME']).not.toBe(home);
        expect(env['STROQ_TASK_HASH']).toMatch(/^[a-f0-9]{64}$/);
        expect(env['STROQ_TASK_KEY_ID']).toMatch(/^[a-f0-9]{16}$/);
        expect(args).toContain('--settings');
        throw new Error('launch failed');
      },
    );
    await expect(
      runTask(['--hook-only', '--', 'fix'], cwd, {
        home,
        confirm: async () => true,
        launch,
        taskId: () => 'test-task',
        entry: CLI_ENTRY,
        claude: process.execPath,
      }),
    ).rejects.toThrow('launch failed');
    expect(
      JSON.parse(readFileSync(join(home, 'tasks/test-task/receipt.json'), 'utf8')),
    ).toMatchObject({ taskId: 'test-task', calls: [] });
  });
  it('runs the copied packaged hook against the parent without a real model', async () => {
    const home = join(temp(), "quoted' task");
    mkdirSync(home);
    const cwd = temp();
    let fakeHome = '';
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const launch = async ({ env, args }: { env: NodeJS.ProcessEnv; args: readonly string[] }) => {
      fakeHome = env['HOME'] as string;
      const permit = JSON.parse(readFileSync(join(home, 'tasks/test-task/permit.json'), 'utf8'));
      const entry = join(dirname(args[args.indexOf('--settings') + 1] as string), 'dist/index.js');
      const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
      const settings = JSON.parse(
        readFileSync(args[args.indexOf('--settings') + 1] as string, 'utf8'),
      );
      const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
      for (const phase of ['PreToolUse', 'PostToolUse']) {
        await new Promise<void>((resolve, reject) => {
          const child = existsSync(shell)
            ? spawn(shell, ['-c', command], { env, stdio: 'pipe' })
            : spawn(process.execPath, [entry, 'task-hook'], { env, stdio: 'pipe' });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
          });
          child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
          });
          child.on('error', reject);
          child.on('close', (code) => {
            try {
              expect(code, stderr).toBe(0);
              expect(stdout).toBe('');
              resolve();
            } catch (err) {
              reject(err);
            }
          });
          child.stdin.end(
            JSON.stringify({
              session_id: permit.body.sessionId,
              tool_use_id: 'packaged-call',
              hook_event_name: phase,
              tool_name: 'Read',
              tool_input: { file_path: `${cwd.replaceAll('\\', '/')}/source.ts` },
              cwd: permit.body.projectRoot,
              tool_response: 'ok',
            }),
          );
        });
      }
      return 0;
    };
    expect(
      await runTask(['--hook-only', '--', 'fix'], cwd, {
        home,
        confirm: async () => true,
        launch,
        taskId: () => 'test-task',
        entry: CLI_ENTRY,
        claude: process.execPath,
      }),
    ).toBe(0);
    expect(
      JSON.parse(readFileSync(join(home, 'tasks/test-task/receipt.json'), 'utf8')).calls[0],
    ).toMatchObject({ callId: 'packaged-call', status: 'host-reported' });
    expect(existsSync(fakeHome)).toBe(false);
  });
});
