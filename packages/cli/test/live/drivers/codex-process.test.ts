import { describe, expect, it, vi } from 'vitest';
import { codexSpawn, killCodexChild } from '../../../src/live/drivers/codex-process.js';
import type { HostChild } from '../../../src/live/drivers/host-process.js';
import { tmpdir } from 'node:os';

describe('Codex process cleanup', () => {
  const child = (pid?: number): HostChild => ({
    pid,
    stdout: null,
    stderr: null,
    on: () => undefined,
    kill: vi.fn(() => true),
  });
  it('terminates the specific Windows child tree', () => {
    const host = child(123);
    const taskkill = vi.fn();
    expect(killCodexChild(host, 'SIGKILL', 'win32', taskkill)).toBe(true);
    expect(taskkill).toHaveBeenCalledWith(123);
    expect(host.kill).not.toHaveBeenCalled();
  });
  it.each(['linux', 'darwin'] as const)(
    'keeps the normal child kill outside Windows: %s',
    (platform) => {
      const host = child(123);
      const taskkill = vi.fn();
      killCodexChild(host, 'SIGTERM', platform, taskkill);
      expect(host.kill).toHaveBeenCalledWith('SIGTERM');
      expect(taskkill).not.toHaveBeenCalled();
    },
  );
  it('falls back when the process has no PID or taskkill cannot run', () => {
    for (const host of [child(), child(123)]) {
      killCodexChild(host, 'SIGKILL', 'win32', () => {
        throw new Error('gone');
      });
      expect(host.kill).toHaveBeenCalledWith('SIGKILL');
    }
  });
  it('starts a native executable without a shell', async () => {
    const host = codexSpawn(process.execPath, ['-e', 'process.stdout.write("ready")'], {
      cwd: tmpdir(),
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
    let output = '';
    host.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    await new Promise<void>((done) => host.on('close', () => done()));
    expect(output).toBe('ready');
  });
  it.skipIf(process.platform !== 'win32')(
    'terminates an actual Windows child and its descendant',
    async () => {
      const source =
        'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true}); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);';
      const host = codexSpawn(process.execPath, ['-e', source], {
        cwd: tmpdir(),
        env: {},
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
      });
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      let descendant = 0;
      try {
        descendant = await new Promise<number>((done, reject) => {
          const timer = setTimeout(
            () => reject(new Error('the child did not announce its descendant')),
            5_000,
          );
          host.stdout?.once('data', (chunk) => {
            clearTimeout(timer);
            done(Number(String(chunk).trim()));
          });
        });
        expect(descendant).toBeGreaterThan(0);
        expect(alive(descendant)).toBe(true);
        host.kill('SIGKILL');
        for (let attempts = 0; attempts < 100 && alive(descendant); attempts += 1)
          await new Promise((done) => setTimeout(done, 25));
        expect(alive(descendant)).toBe(false);
        expect(host.pid === undefined ? false : alive(host.pid)).toBe(false);
      } finally {
        host.kill('SIGKILL');
      }
    },
  );
});
