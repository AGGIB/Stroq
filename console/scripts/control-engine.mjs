import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { runtimeLayout } from './runtime-layout.mjs';

const layout = runtimeLayout();
export const REPOSITORY = layout.repository;
export const ENGINE_PATHS = Object.freeze({
  cli: layout.cli,
  core: layout.core,
  package: layout.package,
  manifest: layout.manifest,
  manifestRoot: layout.manifestRoot,
});
const ARGS = Object.freeze({
  doctor: ['doctor', '--json', '--all'],
  'policy-check': ['policy', 'check', '--json'],
  'guard-test': ['policy', 'test', '--json'],
});
const TIMEOUTS = {
  doctor: 20_000,
  'policy-check': 10_000,
  'guard-test': 60_000,
  'content-scan': 8_000,
};
const MAX_OUTPUT = 2 * 1024 * 1024;
const ENV_NAMES = [
  'PATH',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'SystemRoot',
  'WINDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
];

function builtVersion(cli) {
  return new Promise((resolveVersion) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', cli, '--version'], {
      shell: false,
      windowsHide: true,
      env: {},
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolveVersion(value);
    };
    const timer = setTimeout(() => finish(null), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 128) finish(null);
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 ? output.trim() : null));
  });
}

export async function engineAvailability(paths = ENGINE_PATHS) {
  try {
    for (const path of [paths.cli, paths.core, paths.package]) {
      const stat = await lstat(path);
      const limit = path === paths.package ? 64 * 1024 : 16 * 1024 * 1024;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error();
    }
    const raw = JSON.parse(await readFile(paths.package, 'utf8'));
    if (
      typeof raw.version !== 'string' ||
      !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9.-]{1,30})?$/.test(raw.version)
    )
      throw new Error();
    const version = await builtVersion(paths.cli);
    if (version !== raw.version) throw new Error();
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

/** Environment names are server-selected. Secrets and Node loader injection are not inherited. */
export function engineEnvironment({ home, userHome = homedir(), environment = process.env } = {}) {
  const inherited = Object.fromEntries(
    ENV_NAMES.flatMap((key) =>
      typeof environment[key] === 'string' ? [[key, environment[key]]] : [],
    ),
  );
  return {
    ...inherited,
    HOME: userHome,
    USERPROFILE: userHome,
    STROQ_HOME: home ?? environment.STROQ_HOME ?? join(userHome, '.stroq'),
    NO_COLOR: '1',
  };
}

function runCli(kind, options) {
  const args = ARGS[kind];
  if (!args) return Promise.reject(new Error('invalid-report'));
  return new Promise((resolveRun, reject) => {
    const child = (options.spawn ?? spawn)(
      process.execPath,
      ['--max-old-space-size=256', options.paths.cli, ...args],
      {
        cwd: options.project,
        env: engineEnvironment(options),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let closed = false,
      problem = null;
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* The child may already have exited. */
      }
    };
    const finish = (error, value) => {
      if (settled) return;
      if (error && !closed) {
        problem ??= error;
        stop();
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) {
        reject(new Error(error));
      } else resolveRun(value);
    };
    const abort = () => finish('server-stopped');
    const timer = setTimeout(
      () => finish('deadline-exceeded'),
      options.timeoutMs ?? TIMEOUTS[kind],
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      if (problem) return;
      bytes += chunk.length;
      if (bytes > (options.maxOutput ?? MAX_OUTPUT)) return finish('output-limit');
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      // Errors are never forwarded. Still count them so a noisy child is bounded.
      bytes += chunk.length;
      if (bytes > (options.maxOutput ?? MAX_OUTPUT)) finish('output-limit');
    });
    child.once('error', () => finish('engine-failed'));
    child.once('close', (code) => {
      if (settled) return;
      closed = true;
      if (problem) return finish(problem);
      if (code !== 0 && code !== 1) return finish('engine-failed');
      if (chunks.length === 0) return finish('engine-failed');
      try {
        const raw = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (raw?.ok !== (code === 0)) return finish('invalid-report');
        finish(null, raw);
      } catch {
        finish('invalid-report');
      }
    });
  });
}

function runScan(input, options) {
  return new Promise((resolveRun, reject) => {
    const worker = new (options.Worker ?? Worker)(
      new URL('./control-scan-worker.mjs', import.meta.url),
      {
        workerData: { corePath: options.paths.core, content: input.content, target: input.target },
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      },
    );
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      try {
        await worker.terminate();
      } catch {
        error = 'engine-failed';
      }
      if (error) reject(new Error(error));
      else resolveRun(value);
    };
    const abort = () => finish('server-stopped');
    const timer = setTimeout(
      () => finish('deadline-exceeded'),
      options.timeoutMs ?? TIMEOUTS['content-scan'],
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.stdout.resume();
    worker.stderr.resume();
    worker.once('message', (value) =>
      value?.error ? finish('engine-failed') : finish(null, value),
    );
    worker.once('error', () => finish('engine-failed'));
    worker.once('exit', () => finish('engine-failed'));
  });
}

/** Called only with validated input. No user argument can become executable code. */
export function executeRun(input, options = {}) {
  const resolved = { paths: ENGINE_PATHS, project: REPOSITORY, ...options };
  return input.kind === 'content-scan' ? runScan(input, resolved) : runCli(input.kind, resolved);
}
