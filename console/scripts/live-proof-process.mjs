import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { engineEnvironment } from './control-engine.mjs';

/** Login files remain local; API keys, executable overrides and Node loaders are never inherited. */
export function liveEnvironment(options) {
  const env = engineEnvironment(options);
  const source = options.environment ?? process.env;
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (
      typeof source[key] === 'string' &&
      source[key].length <= 4096 &&
      !/[\u0000-\u001f]/.test(source[key])
    )
      env[key] = source[key];
  }
  return { ...env, NODE_DISABLE_COMPILE_CACHE: '1' };
}

function kill(pid, child, signal, options) {
  try {
    if ((options.platform ?? process.platform) === 'win32') {
      if (pid)
        execFileSync(
          join(
            options.environment?.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows',
            'System32/taskkill.exe',
          ),
          ['/PID', String(pid), '/T', '/F'],
          { timeout: 2000, windowsHide: true, stdio: 'ignore' },
        );
      else child?.kill(signal);
    } else if (pid) process.kill(-pid, signal);
    else child?.kill(signal);
  } catch {
    if (pid === child?.pid) {
      try {
        child.kill(signal);
      } catch {
        /* Already gone. */
      }
    }
  }
}

/** Only the fixed bundled engine is started. PIDs of detached official hosts arrive over private IPC. */
export function executeLiveEngine(operation, input, options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('server-stopped'));
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=384', options.adapter, '--stroq-console-live-engine'],
      {
        cwd: options.project,
        env: liveEnvironment(options),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const hosts = new Set();
    let done = false;
    let problem = null;
    let output = 0;
    let answer;
    let forced;
    let final;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forced);
      clearTimeout(final);
      options.signal?.removeEventListener('abort', abort);
      for (const pid of hosts) kill(pid, null, 'SIGKILL', options);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (problem || answer === undefined) reject(new Error(problem ?? 'invalid-report'));
      else resolve(answer);
    };
    const stop = (code) => {
      if (done || problem) return;
      problem = code;
      kill(child.pid, child, 'SIGTERM', options);
      for (const pid of hosts) kill(pid, null, 'SIGKILL', options);
      forced = setTimeout(() => {
        kill(child.pid, child, 'SIGKILL', options);
        for (const pid of hosts) kill(pid, null, 'SIGKILL', options);
        final = setTimeout(finish, 1000);
      }, 2500);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(
      () => stop('deadline-exceeded'),
      options.timeoutMs ?? (operation === 'run' ? input.maxRequests * 96_000 + 20_000 : 12_000),
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => {
        output += chunk.length;
        if (output > 256 * 1024) stop('output-limit');
      });
    child.once('spawn', () =>
      child.send({ operation, input }, (error) => {
        if (error) stop('engine-unavailable');
      }),
    );
    child.on('message', (message) => {
      if (done || !message || typeof message !== 'object') return stop('invalid-report');
      if (
        message.type === 'child' &&
        Number.isSafeInteger(message.pid) &&
        message.pid > 1 &&
        message.pid !== process.pid
      ) {
        hosts.add(message.pid);
        if (problem) kill(message.pid, null, 'SIGKILL', options);
        return;
      }
      if (message.type === 'child-closed' && hosts.has(message.pid)) {
        hosts.delete(message.pid);
        return;
      }
      if (
        message.type === 'result' &&
        answer === undefined &&
        Buffer.byteLength(JSON.stringify(message.result)) <= 64 * 1024
      ) {
        answer = message.result;
        return;
      }
      if (message.type === 'error')
        return stop(
          ['preview-stale', 'configuration-unreadable'].includes(message.error)
            ? message.error
            : 'live-check-failed',
        );
      stop('invalid-report');
    });
    child.once('error', () => {
      problem = 'engine-unavailable';
      finish();
    });
    child.once('close', (code) => {
      if (!problem && code !== 0) problem = 'live-check-failed';
      finish();
    });
  });
}
