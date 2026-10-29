import { spawn } from 'node:child_process';
import { engineEnvironment } from './control-engine.mjs';
import { validSecretReport } from './secret-scan-safe.mjs';

// Credential-shaped environment values are delivered over private IPC only after consent,
// never as arguments, inherited loader variables, stdout, stderr or a temporary file.
export function secretEnvironment(options) {
  const environment = engineEnvironment(options);
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    const value = options.environment?.[key];
    if (typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f]/.test(value))
      environment[key] = value;
  }
  return { ...environment, NODE_DISABLE_COMPILE_CACHE: '1', NODE_NO_WARNINGS: '1' };
}

export function executeSecretScan(input, options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('cancelled'));
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=256',
        '--max-semi-space-size=16',
        options.adapter,
        '--stroq-console-secret-engine',
      ],
      {
        cwd: options.project,
        env: secretEnvironment(options),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let done = false;
    let problem = null;
    let answer;
    let output = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(final);
      options.signal?.removeEventListener('abort', abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (problem || answer === undefined) reject(new Error(problem ?? 'invalid-report'));
      else resolve(answer);
    };
    let final;
    const stop = (code) => {
      if (done || problem) return;
      problem = code;
      child.kill('SIGKILL');
      final = setTimeout(finish, 1000);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('deadline-exceeded'), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => {
        output += chunk.length;
        if (output > 64 * 1024) stop('output-limit');
      });
    child.once('spawn', () =>
      child.send(
        {
          ...input,
          project: options.project,
          userHome: options.userHome,
          home: options.home,
          environment: options.environment ?? {},
        },
        (error) => {
          if (error) stop('engine-unavailable');
        },
      ),
    );
    child.on('message', (message) => {
      if (done || problem) return;
      if (!message || typeof message !== 'object') return stop('invalid-report');
      if (message.type === 'error')
        return stop(message.error === 'input-limit' ? 'input-limit' : 'scan-failed');
      if (
        message.type !== 'result' ||
        answer !== undefined ||
        Buffer.byteLength(JSON.stringify(message.result)) > 256 * 1024 ||
        !validSecretReport(message.result) ||
        message.result.scope !== input.scope
      )
        return stop('invalid-report');
      answer = message.result;
    });
    child.once('error', () => {
      problem = 'engine-unavailable';
      finish();
    });
    child.once('close', (code) => {
      if (!problem && code !== 0) problem = 'scan-failed';
      finish();
    });
  });
}
