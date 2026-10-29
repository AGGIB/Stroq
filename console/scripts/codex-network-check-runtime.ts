import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { CodexNetworkGuardCheckPreparation } from '../lib/codex-network-guard-check-private';
import {
  NETWORK_CHECK_PINNED_NATIVE_SHA256,
  networkCheckFail,
} from './codex-network-check-protocol';

export interface NetworkScratch {
  root: string;
  project: string;
  home: string;
  stroqHome: string;
  dev: number;
  ino: number;
}
export interface NetworkEngineOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  onProgress?: (id: 'positive' | 'native' | 'cleanup') => void;
  onChild?: (pid: number) => void;
  onChildClosed?: (pid: number) => void;
  onScratch?: (scratch: NetworkScratch) => void;
  /** Private test seams. Production uses the pinned verifier and actual host platform. */
  platform?: NodeJS.Platform;
  verifyNative?: (native: CodexNetworkGuardCheckPreparation['native']) => Promise<void>;
  fault?: (stage: string, details: Record<string, any>) => void | Promise<void>;
}
export interface NetworkRuntime {
  options: NetworkEngineOptions;
  deadline: number;
}
export function active(runtime: NetworkRuntime): void {
  if (runtime.options.signal?.aborted) return networkCheckFail('cancelled');
  if (Date.now() >= runtime.deadline) return networkCheckFail('deadline-exceeded');
}
const pinKeys = ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const;
/** Same-handle bounded hash, physical file pin, and all captured parent identities. */
export async function verifyNetworkNative(
  native: CodexNetworkGuardCheckPreparation['native'],
  expectedSha = NETWORK_CHECK_PINNED_NATIVE_SHA256,
  runtime?: NetworkRuntime,
): Promise<void> {
  let handle;
  try {
    if (runtime) active(runtime);
    if (native.sha256 !== expectedSha) return networkCheckFail('native-changed');
    for (const parent of native.parents) {
      if (runtime) active(runtime);
      const s = await lstat(parent.path);
      if (
        !s.isDirectory() ||
        ['dev', 'ino', 'uid', 'mode'].some(
          (k) => s[k as keyof typeof s] !== parent[k as keyof typeof parent],
        )
      )
        return networkCheckFail('native-changed');
    }
    const named = await lstat(native.path);
    if (!named.isFile() || named.nlink !== 1 || pinKeys.some((k) => named[k] !== native.file[k]))
      return networkCheckFail('native-changed');
    handle = await open(native.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (pinKeys.some((k) => before[k] !== native.file[k]) || before.size > 512 * 1024 * 1024)
      return networkCheckFail('native-changed');
    const hash = createHash('sha256'),
      bytes = Buffer.alloc(256 * 1024);
    let position = 0;
    for (;;) {
      if (runtime) active(runtime);
      const read = await handle.read(bytes, 0, bytes.length, position);
      if (!read.bytesRead) break;
      position += read.bytesRead;
      if (position > before.size) return networkCheckFail('native-changed');
      hash.update(bytes.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(),
      current = await lstat(native.path);
    if (
      position !== before.size ||
      hash.digest('hex') !== expectedSha ||
      pinKeys.some((k) => before[k] !== after[k] || after[k] !== current[k])
    )
      return networkCheckFail('native-changed');
  } catch (e) {
    if (e instanceof Error && ['cancelled', 'deadline-exceeded'].includes(e.message)) throw e;
    return networkCheckFail('native-changed');
  } finally {
    await handle?.close();
  }
}
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
}
async function groupGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(-pid, 0);
      killGroup(pid);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
export async function runNetworkProcess(
  runtime: NetworkRuntime,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; code: number | null }> {
  active(runtime);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let total = 0,
      stdout = Buffer.alloc(0),
      problem: string | null = null,
      done = false;
    let force: NodeJS.Timeout | undefined;
    const finish = async (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(force);
      runtime.options.signal?.removeEventListener('abort', abort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.pid !== undefined) {
        killGroup(child.pid);
        if (!(await groupGone(child.pid))) problem = 'cleanup-failed';
        else {
          try {
            runtime.options.onChildClosed?.(child.pid);
          } catch {
            problem = 'cleanup-failed';
          }
        }
      }
      if (problem) return reject(new Error(problem));
      try {
        resolve({ stdout: new TextDecoder('utf-8', { fatal: true }).decode(stdout), code });
      } catch {
        resolve({ stdout: '', code });
      }
    };
    const stop = (reason: string) => {
      if (done || problem) return;
      problem = reason;
      if (child.pid !== undefined) killGroup(child.pid);
      force = setTimeout(() => void finish(null), 500);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(
      () => stop('deadline-exceeded'),
      Math.max(1, runtime.deadline - Date.now()),
    );
    runtime.options.signal?.addEventListener('abort', abort, { once: true });
    if (runtime.options.signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 64 * 1024) return stop('output-limit');
        if (stream === child.stdout) stdout = Buffer.concat([stdout, chunk]);
      });
    child.once('exit', () => {
      if (child.pid !== undefined) killGroup(child.pid);
    });
    child.once('error', () => void finish(null));
    child.once('close', (code) => void finish(code));
    try {
      if (child.pid !== undefined) runtime.options.onChild?.(child.pid);
    } catch {
      stop('invalid-report');
    }
  });
}
