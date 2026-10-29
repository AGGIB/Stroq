import { spawn, type ChildProcess } from 'node:child_process';
import { constants, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { GENESIS_HASH, hashEntry, stableStringify, type AuditEntry } from '@stroq/core';
import { createEngineAt } from '../../packages/cli/src/engine-factory.js';
import type { HookRun } from '../../packages/cli/src/commands/init-selfcheck.js';
import { policySha256 } from '../../packages/cli/src/live/policy-digest.js';
import {
  createThrowawayRoot,
  removeThrowawayRoot,
  type Throwaway,
} from '../../packages/cli/src/live/throwaway.js';
import { parseJsonDocument } from '../../packages/cli/src/harden/json-doc.js';
import { runCodexNetworkCheckEngine } from './codex-network-check-engine';
import type { CodexNetworkGuardCheckPreparation } from '../lib/codex-network-guard-check-private';
import {
  AGENTS,
  HOOK_CHECK_SUITE,
  fail,
  object,
  keys,
  effect,
  selectedPolicy,
  hookCheckEvent,
  hookCheckExpectedWire,
  decodeHookCheckWire,
  hookCheckEnvironment,
  type Input,
  type Probe,
  type ProbeId,
} from './hook-check-protocol.js';
export {
  HOOK_CHECK_SUITE,
  hookCheckEvent,
  hookCheckExpectedWire,
  decodeHookCheckWire,
  hookCheckEnvironment,
  hookCheckPolicySha256,
} from './hook-check-protocol.js';

const OUTPUT_LIMIT = 128 * 1024;
const JOURNAL_LIMIT = 128 * 1024;
const HOOK_TIMEOUT_MS = 12_000;

interface Scratch extends Throwaway {
  dev: number;
  ino: number;
}
interface Options {
  cliPath: string;
  signal?: AbortSignal;
  onProgress?: (id: ProbeId) => void;
  onChild?: (pid: number) => void;
  onChildClosed?: (pid: number) => void;
  onScratch?: (scratch: Scratch) => void;
  fault?: (stage: string, details: Record<string, unknown>) => void | Promise<void>;
}

function scratch(options: Options): Scratch {
  const root = createThrowawayRoot('stroq-console-hook-');
  const info = lstatSync(root.root);
  const result = { ...root, dev: info.dev, ino: info.ino };
  // Register the exclusively created root before any later operation can fail.
  options.onScratch?.(result);
  for (const directory of ['tmp', 'config', 'data', 'cache'])
    mkdirSync(join(root.root, directory), { mode: 0o700 });
  // Bound core's ancestor discovery to this disposable project, including env sources.
  mkdirSync(join(root.project, '.git'), { mode: 0o700 });
  return result;
}

function removeScratch(root: Scratch): void {
  try {
    const current = lstatSync(root.root);
    if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino)
      return fail('cleanup-failed');
    removeThrowawayRoot(root.root);
    try {
      lstatSync(root.root);
      return fail('cleanup-failed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('cleanup-failed');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('cleanup-failed');
  }
}

/** An existing process group is killed even after the main hook exited normally. */
function kill(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* Already reaped. */
    }
  }
}

async function runHook(
  input: Input,
  id: ProbeId,
  actual: Scratch,
  options: Options,
): Promise<HookRun> {
  if (options.signal?.aborted) return fail('cancelled');
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=256', options.cliPath, 'hook', input.agent],
      {
        cwd: actual.project,
        env: hookCheckEnvironment(actual),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (child.pid !== undefined) options.onChild?.(child.pid);
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      total = 0,
      problem: string | null = null,
      done = false;
    let force: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(force);
      options.signal?.removeEventListener('abort', abort);
      kill(child);
      if (child.pid !== undefined) options.onChildClosed?.(child.pid);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (problem !== null) reject(new Error(problem));
      else {
        try {
          const decode = new TextDecoder('utf-8', { fatal: true });
          resolve({
            stdout: decode.decode(stdout),
            stderr: decode.decode(stderr),
            code,
            timedOut: false,
            ms: Math.max(0, Math.round(performance.now() - started)),
          });
        } catch {
          resolve({ stdout: '', stderr: '', code: null, timedOut: false, ms: 0 });
        }
      }
    };
    const stop = (reason: string) => {
      if (problem !== null || done) return;
      problem = reason;
      kill(child);
      force = setTimeout(() => finish(null), 500);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('deadline-exceeded'), HOOK_TIMEOUT_MS);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > OUTPUT_LIMIT) stop('output-limit');
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > OUTPUT_LIMIT) stop('output-limit');
      else stderr = Buffer.concat([stderr, chunk]);
    });
    // Descendants may retain the pipes. Reap the group as soon as its leader exits.
    child.once('exit', () => kill(child));
    child.once('error', () => finish(null));
    child.once('close', finish);
    child.stdin.on('error', () => undefined);
    child.stdin.end(hookCheckEvent(input.agent, id, actual.project));
  });
}

/** Bounded, same-handle read of one fresh engine event, including its real chain hash. */
async function journal(root: Scratch, from: number, to: number): Promise<AuditEntry | null> {
  let handle;
  try {
    const path = join(root.stroqHome, 'audit.jsonl');
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(JOURNAL_LIMIT)) return null;
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const pinned = await handle.stat({ bigint: true });
    if (pinned.dev !== before.dev || pinned.ino !== before.ino) return null;
    const bytes = Buffer.alloc(JOURNAL_LIMIT + 1);
    let length = 0;
    for (;;) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      length += result.bytesRead;
      if (length > JOURNAL_LIMIT) return null;
      if (result.bytesRead === 0) break;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].some(
        (key) => pinned[key as keyof typeof pinned] !== after[key as keyof typeof after],
      ) ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      after.size !== BigInt(length)
    )
      return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    // Every probe owns a fresh home. Multiple, missing or truncated events are not proof.
    if (!text.endsWith('\n')) return null;
    const lines = text.trimEnd().split('\n');
    if (lines.length !== 1) return null;
    const document = parseJsonDocument(lines[0]!);
    if (!document.ok) return null;
    const entry: unknown = document.doc;
    if (
      !object(entry) ||
      entry.seq !== 1 ||
      entry.prevHash !== GENESIS_HASH ||
      typeof entry.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      typeof entry.ts !== 'string' ||
      !Number.isFinite(Date.parse(entry.ts)) ||
      new Date(entry.ts).toISOString() !== entry.ts ||
      Date.parse(entry.ts) < from - 1000 ||
      Date.parse(entry.ts) > to + 1000 ||
      entry.phase !== 'pre' ||
      entry.sessionId !== 'stroq-selftest' ||
      entry.tool !== 'Bash' ||
      !object(entry.decision) ||
      !effect(entry.decision.effect) ||
      entry.outcome !== undefined
    )
      return null;
    const { hash, ...unhashed } = entry;
    return hashEntry(unhashed as unknown as Omit<AuditEntry, 'hash'>) === hash
      ? (entry as unknown as AuditEntry)
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function auditMatches(actual: AuditEntry | null, expected: AuditEntry): boolean {
  const projection = (entry: AuditEntry) => {
    const { seq, ts, hash, prevHash, callId, ...evidence } = entry;
    return evidence;
  };
  return (
    actual !== null &&
    stableStringify(projection(actual)) === stableStringify(projection(expected)) &&
    (actual.callId === undefined || actual.callId === 'stroq-selftest') &&
    actual.taskId === undefined &&
    actual.scope === undefined &&
    actual.scan === undefined &&
    actual.operation === undefined
  );
}

/** Runs only Stroq's own hook entry. Probe command strings are stdin data and never executed. */
export async function runHookCheckEngine(input: Input, options: Options) {
  if (
    !object(input) ||
    Object.keys(input).length !== 3 ||
    !keys(input, ['agent', 'policyText', 'policySemanticSha256']) ||
    !AGENTS.includes(input.agent) ||
    (input.policyText !== null && typeof input.policyText !== 'string') ||
    !/^[a-f0-9]{64}$/.test(input.policySemanticSha256) ||
    !isAbsolute(options.cliPath)
  )
    return fail('invalid-input');
  const policy = selectedPolicy(input.policyText);
  if (policySha256(policy) !== input.policySemanticSha256) return fail('invalid-policy');
  const roots: Scratch[] = [];
  const capture = {
    ...options,
    onScratch(root: Scratch) {
      roots.push(root);
      options.onScratch?.(root);
    },
  };
  const probes: Probe[] = [];
  try {
    for (const probe of HOOK_CHECK_SUITE) {
      if (options.signal?.aborted) return fail('cancelled');
      const actual = scratch(capture),
        reference = scratch(capture);
      await options.fault?.('scratch-created', { id: probe.id, actual, reference });
      if (input.policyText !== null)
        writeFileSync(join(actual.stroqHome, 'policy.yaml'), input.policyText, {
          flag: 'wx',
          mode: 0o600,
        });
      options.onProgress?.(probe.id);
      const referenceStarted = Date.now();
      const expected = await createEngineAt({
        home: reference.stroqHome,
        userHome: reference.home,
        projectRoot: reference.project,
        policy,
        env: {},
      }).pre({
        sessionId: 'stroq-selftest',
        toolName: 'Bash',
        toolInput: { command: probe.command },
        cwd: reference.project,
      });
      const expectedAudit = await journal(reference, referenceStarted, Date.now());
      if (expectedAudit === null || expectedAudit.decision?.effect !== expected.decision.effect)
        return fail('hook-check-failed');
      const actualStarted = Date.now();
      const run = await runHook(input, probe.id, actual, options);
      const actualFinished = Date.now();
      await options.fault?.('after-hook', { id: probe.id, actual, reference });
      if (options.signal?.aborted) return fail('cancelled');
      const observed = await journal(actual, actualStarted, actualFinished);
      const auditConfirmed = auditMatches(observed, expectedAudit);
      const observedEffect = auditConfirmed ? observed!.decision!.effect : null;
      const expectedEffect = expected.decision.effect;
      const expectedWire = hookCheckExpectedWire(input.agent, expectedEffect);
      const wireEffect = decodeHookCheckWire(input.agent, run);
      probes.push({
        id: probe.id,
        expectedEffect,
        expectedWire,
        observedEffect,
        wireEffect,
        auditConfirmed,
        exitCode: run.code,
        durationMs: run.ms,
        matched: expectedWire === wireEffect && observedEffect === expectedEffect && auditConfirmed,
      });
    }
    const standard = {
      ordinaryAllowed: probes[0]!.observedEffect === 'allow',
      encodedDenied: probes[1]!.observedEffect === 'deny',
    };
    return {
      probes,
      status: probes.every((probe) => probe.matched)
        ? standard.ordinaryAllowed && standard.encodedDenied
          ? ('passed' as const)
          : ('attention' as const)
        : ('failed' as const),
      standard,
    };
  } finally {
    let failed = false;
    try {
      if (!options.signal?.aborted) await options.fault?.('before-cleanup', { roots });
    } catch {
      failed = true;
    }
    for (const root of roots) {
      try {
        removeScratch(root);
      } catch {
        failed = true;
      }
    }
    if (failed) fail('cleanup-failed');
  }
}

// The private worker protocol never forwards raw policy, audit or process output to the browser.
if (
  process.argv.includes('--stroq-hook-check-engine') &&
  !process.argv.includes('--stroq-codex-network-check-engine')
) {
  const controller = new AbortController();
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let serial = 0,
    started = false;
  const send = (message: unknown) => process.send?.(message);
  const fault = (stage: string, details: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      send({ type: 'fault', id, stage, details });
    });
  const abort = () => {
    controller.abort();
    for (const request of pending.values()) request.reject(new Error('cancelled'));
    pending.clear();
  };
  process.on('SIGTERM', abort);
  process.on('disconnect', abort);
  process.on('message', (message: unknown) => {
    if (!object(message)) return;
    if (message.type === 'cancel') return abort();
    if (message.type === 'fault-reply' && typeof message.id === 'number') {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok === true) request?.resolve();
      else request?.reject(new Error('hook-check-failed'));
      return;
    }
    if (message.type !== 'start' || started) return;
    started = true;
    void runHookCheckEngine(message.input as Input, {
      cliPath: String(message.cliPath),
      signal: controller.signal,
      onProgress: (id) => send({ type: 'progress', id }),
      onChild: (pid) => send({ type: 'child', pid }),
      onChildClosed: (pid) => send({ type: 'child-closed', pid }),
      onScratch: (root) => send({ type: 'scratch', root }),
      ...(message.faults === true ? { fault } : {}),
    }).then(
      (result) => process.send?.({ type: 'result', result }, () => process.exit(0)),
      (error: unknown) => {
        const code =
          error instanceof Error &&
          [
            'cancelled',
            'deadline-exceeded',
            'output-limit',
            'invalid-input',
            'invalid-policy',
            'cleanup-failed',
          ].includes(error.message)
            ? error.message
            : 'hook-check-failed';
        process.send?.({ type: 'error', error: code }, () => process.exit(1));
      },
    );
  });
}

// A distinct fixed dispatch shares the packaged adapter, never a model/provider entry point.
if (
  process.argv.includes('--stroq-codex-network-check-engine') &&
  !process.argv.includes('--stroq-hook-check-engine')
) {
  const controller = new AbortController();
  let started = false;
  const send = (message: unknown) => process.send?.(message);
  const abort = () => controller.abort();
  process.on('SIGTERM', abort);
  process.on('disconnect', abort);
  process.on('message', (message: unknown) => {
    if (!object(message)) return;
    if (message.type === 'cancel') return abort();
    if (message.type !== 'start' || started) return;
    started = true;
    void runCodexNetworkCheckEngine(message.input as CodexNetworkGuardCheckPreparation, {
      signal: controller.signal,
      onProgress: (id) => send({ type: 'progress', id }),
      onChild: (pid) => send({ type: 'child', pid }),
      onChildClosed: (pid) => send({ type: 'child-closed', pid }),
      onScratch: (root) => send({ type: 'scratch', root }),
    }).then(
      (result) => process.send?.({ type: 'result', result }, () => process.exit(0)),
      (error: unknown) => {
        const code =
          error instanceof Error &&
          [
            'invalid-input',
            'unsupported',
            'native-changed',
            'cancelled',
            'deadline-exceeded',
            'output-limit',
            'cleanup-failed',
            'listener-failed',
            'invalid-report',
          ].includes(error.message)
            ? error.message
            : 'engine-unavailable';
        process.send?.({ type: 'error', error: code }, () => process.exit(1));
      },
    );
  });
}
