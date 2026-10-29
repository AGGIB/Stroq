import { spawn, execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

const ERRORS = new Set([
  'cancelled',
  'deadline-exceeded',
  'output-limit',
  'engine-unavailable',
  'invalid-input',
  'invalid-policy',
  'invalid-report',
  'hook-check-failed',
  'cleanup-failed',
]);
const MARKER = 'made by stroq prove: everything in this directory may be removed\n';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) =>
  object(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));
const effect = (value) => ['allow', 'ask', 'deny'].includes(value);

/** Internal results are validated even though the adapter is a bundled private executable. */
export function validHookCheckEngineResult(value) {
  if (
    !exact(value, ['probes', 'status', 'standard']) ||
    !Array.isArray(value.probes) ||
    value.probes.length !== 2 ||
    !exact(value.standard, ['ordinaryAllowed', 'encodedDenied'])
  )
    return false;
  for (const [index, probe] of value.probes.entries()) {
    if (
      !exact(probe, [
        'id',
        'expectedEffect',
        'expectedWire',
        'observedEffect',
        'wireEffect',
        'auditConfirmed',
        'exitCode',
        'durationMs',
        'matched',
      ]) ||
      probe.id !== ['ordinary', 'encoded-fetch'][index] ||
      !effect(probe.expectedEffect) ||
      !effect(probe.expectedWire) ||
      !(probe.observedEffect === null || effect(probe.observedEffect)) ||
      !(effect(probe.wireEffect) || probe.wireEffect === 'unreadable') ||
      typeof probe.auditConfirmed !== 'boolean' ||
      typeof probe.matched !== 'boolean' ||
      !(
        probe.exitCode === null ||
        (Number.isInteger(probe.exitCode) && probe.exitCode >= 0 && probe.exitCode <= 255)
      ) ||
      !Number.isSafeInteger(probe.durationMs) ||
      probe.durationMs < 0 ||
      probe.durationMs > 120_000 ||
      probe.auditConfirmed !== (probe.observedEffect !== null) ||
      probe.matched !==
        (probe.expectedWire === probe.wireEffect &&
          probe.observedEffect === probe.expectedEffect &&
          probe.auditConfirmed)
    )
      return false;
  }
  const ordinaryAllowed = value.probes[0].observedEffect === 'allow';
  const encodedDenied = value.probes[1].observedEffect === 'deny';
  const status = value.probes.every((probe) => probe.matched)
    ? ordinaryAllowed && encodedDenied
      ? 'passed'
      : 'attention'
    : 'failed';
  return (
    value.standard.ordinaryAllowed === ordinaryAllowed &&
    value.standard.encodedDenied === encodedDenied &&
    value.status === status
  );
}

function kill(pid, child, signal = 'SIGKILL') {
  try {
    if (process.platform === 'win32' && pid) {
      const systemRoot = process.env.SystemRoot;
      if (
        typeof systemRoot !== 'string' ||
        !isAbsolute(systemRoot) ||
        /[\u0000-\u001f]/.test(systemRoot)
      )
        throw new Error('no-system-root');
      execFileSync(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { timeout: 1000, windowsHide: true, stdio: 'ignore', env: {} },
      );
    } else if (pid) process.kill(-pid, signal);
    else child?.kill(signal);
  } catch {
    try {
      child?.kill(signal);
    } catch {
      /* Already reaped. */
    }
  }
}

/** Only roots created by this worker and pinned over private IPC are eligible for cleanup. */
async function cleanup(root, network = false) {
  try {
    const info = await lstat(root.root);
    if (
      !info.isDirectory() ||
      info.dev !== root.dev ||
      info.ino !== root.ino ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      dirname(await realpath(root.root)) !== (await realpath(tmpdir())) ||
      !(network ? /^stroq-console-net-[A-Za-z0-9]+$/ : /^stroq-console-hook-[A-Za-z0-9]+$/).test(
        basename(root.root),
      )
    )
      throw new Error('cleanup-failed');
    const marker = join(root.root, '.stroq-live-throwaway');
    const handle = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const pin = await handle.stat();
      const buffer = Buffer.alloc(Buffer.byteLength(MARKER) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (
        !pin.isFile() ||
        pin.nlink !== 1 ||
        pin.size !== Buffer.byteLength(MARKER) ||
        bytesRead !== pin.size ||
        buffer.subarray(0, bytesRead).toString('utf8') !== MARKER
      )
        throw new Error('cleanup-failed');
    } finally {
      await handle.close();
    }
    const pinned = await lstat(root.root);
    if (pinned.dev !== root.dev || pinned.ino !== root.ino || !pinned.isDirectory())
      throw new Error('cleanup-failed');
    await rm(root.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
    try {
      await lstat(root.root);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    throw new Error('cleanup-failed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('cleanup-failed');
    // ENOENT is success only if the root itself is gone, not merely its marker.
    try {
      await lstat(root.root);
    } catch (missing) {
      if (missing?.code === 'ENOENT') return;
    }
    throw new Error('cleanup-failed');
  }
}

/** A strict supervisor for the own-CLI offline check. It never starts a vendor host or a shell. */
export async function executeHookCheck(input, options) {
  return execute(input, options, false);
}

/** Fixed native-canary variant. The caller supplies the bundled closed public result validator. */
export async function executeCodexNetworkCheck(input, options) {
  if (typeof options?.validateResult !== 'function') throw Error('invalid-input');
  return execute(input, options, true);
}

async function execute(input, options, network) {
  if (
    !options ||
    typeof options.adapterPath !== 'string' ||
    !isAbsolute(options.adapterPath) ||
    (!network && (typeof options.cliPath !== 'string' || !isAbsolute(options.cliPath)))
  )
    throw new Error('invalid-input');
  if (options.signal?.aborted) throw new Error('cancelled');
  const roots = new Map(),
    children = new Set();
  let child;
  try {
    return await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [
          '--max-old-space-size=256',
          options.adapterPath,
          network ? '--stroq-codex-network-check-engine' : '--stroq-hook-check-engine',
        ],
        {
          cwd: dirname(options.adapterPath),
          // Keep the worker's temp namespace identical to the supervisor's. No login env.
          env: { NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: tmpdir(), TEMP: tmpdir(), TMP: tmpdir() },
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let done = false,
        problem = null,
        answer,
        output = 0,
        forced,
        final;
      const send = (message) => {
        if (child.connected) child.send(message, () => undefined);
      };
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(forced);
        clearTimeout(final);
        options.signal?.removeEventListener('abort', abort);
        for (const pid of children) kill(pid);
        if (child.exitCode === null && child.signalCode === null) kill(child.pid, child);
        child.stdout.destroy();
        child.stderr.destroy();
        if (problem || answer === undefined || code !== 0)
          reject(new Error(problem ?? 'hook-check-failed'));
        else resolve(answer);
      };
      const stop = (code) => {
        if (done || problem) return;
        problem = code;
        send({ type: 'cancel' });
        for (const pid of children) kill(pid);
        // Give finally blocks a bounded opportunity to remove scratch state.
        forced = setTimeout(() => {
          for (const pid of children) kill(pid);
          kill(child.pid, child);
          final = setTimeout(() => finish(null), 750);
        }, 1000);
      };
      const abort = () => stop('cancelled');
      const timer = setTimeout(
        () => stop('deadline-exceeded'),
        Math.max(100, Math.min(options.timeoutMs ?? 30_000, 120_000)),
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          output += chunk.length;
          if (output > 128 * 1024) stop('output-limit');
        });
      child.once('spawn', () =>
        send({
          type: 'start',
          input,
          ...(!network ? { cliPath: options.cliPath } : {}),
          faults: typeof options.fault === 'function',
        }),
      );
      child.on('message', (message) => {
        if (done || !object(message)) return stop('invalid-report');
        if (
          message.type === 'child' &&
          Number.isSafeInteger(message.pid) &&
          message.pid > 1 &&
          message.pid !== process.pid &&
          message.pid !== child.pid
        ) {
          children.add(message.pid);
          if (problem) kill(message.pid);
          return;
        }
        if (message.type === 'child-closed' && children.has(message.pid)) {
          kill(message.pid);
          children.delete(message.pid);
          return;
        }
        if (
          message.type === 'scratch' &&
          object(message.root) &&
          typeof message.root.root === 'string' &&
          isAbsolute(message.root.root) &&
          Number.isSafeInteger(message.root.dev) &&
          Number.isSafeInteger(message.root.ino) &&
          roots.size < 4
        ) {
          if (roots.has(message.root.root)) return stop('invalid-report');
          roots.set(message.root.root, message.root);
          return;
        }
        if (
          message.type === 'progress' &&
          (network ? ['positive', 'native', 'cleanup'] : ['ordinary', 'encoded-fetch']).includes(
            message.id,
          )
        ) {
          try {
            options.onProgress?.(message.id);
          } catch {
            stop('hook-check-failed');
          }
          return;
        }
        if (
          message.type === 'fault' &&
          Number.isSafeInteger(message.id) &&
          typeof message.stage === 'string' &&
          object(message.details) &&
          typeof options.fault === 'function'
        ) {
          Promise.resolve()
            .then(() => options.fault(message.stage, message.details))
            .then(
              () => send({ type: 'fault-reply', id: message.id, ok: true }),
              () => {
                send({ type: 'fault-reply', id: message.id, ok: false });
                stop('hook-check-failed');
              },
            );
          return;
        }
        if (
          message.type === 'result' &&
          answer === undefined &&
          (network
            ? options.validateResult(message.result)
            : validHookCheckEngineResult(message.result))
        ) {
          if (network && (roots.size !== 1 || children.size !== 0)) return stop('invalid-report');
          answer = message.result;
          return;
        }
        if (
          message.type === 'error' &&
          (ERRORS.has(message.error) ||
            (network &&
              ['unsupported', 'native-changed', 'listener-failed'].includes(message.error)))
        ) {
          if (message.error === 'cleanup-failed') problem = 'cleanup-failed';
          else problem ??= message.error;
          return;
        }
        stop('invalid-report');
      });
      child.once('error', () => {
        problem = 'engine-unavailable';
        finish(null);
      });
      child.once('exit', () => {
        for (const pid of children) kill(pid);
        kill(child.pid, child);
      });
      child.once('close', finish);
    });
  } finally {
    for (const pid of children) kill(pid);
    if (child && child.exitCode === null && child.signalCode === null) kill(child.pid, child);
    let failed = false;
    for (const root of roots.values()) {
      try {
        await cleanup(root, network);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('cleanup-failed');
  }
}
