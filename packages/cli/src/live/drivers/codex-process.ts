import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { realSpawn, type HostChild, type HostSpawn } from './host-process.js';

/** Windows has no POSIX process groups. Terminate only this child's tree, never a name match. */
export function killCodexChild(
  child: HostChild,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  taskkill: (pid: number) => void = (pid) => {
    execFileSync(
      join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 2_000 },
    );
  },
): boolean {
  if (platform !== 'win32' || child.pid === undefined) return child.kill(signal);
  try {
    taskkill(child.pid);
    return true;
  } catch {
    return child.kill(signal);
  }
}

export const codexSpawn: HostSpawn = (file, args, options) => {
  const child = realSpawn(file, args, options);
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    on: child.on.bind(child),
    kill: (signal = 'SIGTERM') => killCodexChild(child, signal),
  };
};
