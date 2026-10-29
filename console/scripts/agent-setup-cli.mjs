import { spawn } from 'node:child_process';
import { engineEnvironment } from './control-engine.mjs';

export { runtimeDigest } from './runtime-digest.mjs';

/** Fixed arguments only. Dry-run never installs hooks or starts an agent. */
export function previewFromCli(agent, scope, options) {
  return new Promise((resolve, reject) => {
    const args = [
      '--max-old-space-size=256',
      options.paths.cli,
      'init',
      '--dry-run',
      '--agent',
      agent,
    ];
    if (scope === 'user') args.push('--user');
    const child = spawn(process.execPath, args, {
      cwd: options.project,
      env: { ...engineEnvironment(options), NODE_DISABLE_COMPILE_CACHE: '1' },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0;
    let settled = false;
    const chunks = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        reject(new Error(error));
      } else resolve(Buffer.concat(chunks));
    };
    const abort = () => finish('server-stopped');
    const timer = setTimeout(() => finish('engine-timeout'), 10_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) return finish('engine-output-limit');
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) finish('engine-output-limit');
    });
    child.once('error', () => finish('engine-unavailable'));
    child.once('close', (code) => finish(code === 0 ? null : 'engine-preview-failed'));
  });
}
