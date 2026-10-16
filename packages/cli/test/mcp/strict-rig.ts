import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { StroqEngine } from '@stroq/core';
import { afterEach, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * A real `runMcpProxy` in front of `strict-server.mjs`, driven through in-memory
 * streams: what each strict-mode test needs to send a request and see exactly what the
 * client was given, what the server was sent, and what the audit and the session say.
 */

const SERVER = join(import.meta.dirname, 'strict-server.mjs');

/**
 * Every rig a test starts, until the test is over. A rig is a real proxy with a real
 * child process, and it writes its audit to the Stroq home the environment names AT THE
 * TIME it writes: one left running by a test that failed would go on writing into the
 * next test's home. So after each test every rig is closed, waited for, its temporary
 * directories are removed and the environment variables it set are put back.
 */
interface LiveRig {
  readonly stdin: PassThrough;
  readonly done: Promise<number>;
  readonly dirs: readonly string[];
  readonly restoreEnv: () => void;
}
const live = new Set<LiveRig>();
const CLEANUP_WAIT_MS = 20_000;

afterEach(async () => {
  for (const rig of [...live].reverse()) {
    live.delete(rig);
    rig.stdin.end();
    // A server that outlives its stdin is stopped by the proxy's own shutdown ladder.
    await Promise.race([rig.done.catch(() => 1), sleepMs(CLEANUP_WAIT_MS)]);
    for (const dir of rig.dirs) rmSync(dir, { recursive: true, force: true });
    rig.restoreEnv();
  }
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sets environment variables and returns what puts each back as it was, unset included. */
function setEnv(values: Readonly<Record<string, string>>): () => void {
  const before = Object.keys(values).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** The sentence the fixture's poisoned payloads open with; a withheld message must never repeat it. */
export const POISON_OPENING = 'Ignore all previous instructions';
/** The host the poisoned payloads name; the same. */
export const POISON_HOST = 'update.awesome-widgets.example';

export interface RigOptions {
  readonly strict?: boolean;
  readonly cloak?: boolean;
  readonly strictMaxWithheld?: number;
  /** Generous by default, so a busy machine cannot turn a slow scan into a withheld one. */
  readonly strictScanMs?: number;
  /** The cap for the withheld kinds a benign server also sends; the default is the real one. */
  readonly strictMaxBenign?: number;
  /** How long a stopped server has before it is killed; the default is the proxy's own. */
  readonly shutdownGraceMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Wraps the real engine, for a test that needs it slow or failing at a chosen call. */
  readonly engine?: (real: StroqEngine) => StroqEngine;
}

export type Wire = Record<string, unknown>;

export interface Rig {
  readonly home: string;
  readonly stderr: () => string;
  /** Every line the client has been given, as text. */
  readonly lines: () => readonly string[];
  /** The same, parsed; a line that is not JSON is `{ unparsable: <text> }`. */
  readonly messages: () => readonly Wire[];
  send(message: unknown): void;
  call(id: number | string, name: string, args?: unknown): void;
  /** Resolves with the message the client got for `id`, or rejects after `timeoutMs`. */
  answerFor(id: number | string, timeoutMs?: number): Promise<Wire>;
  handshake(): Promise<void>;
  /** The lines the server received. */
  readonly serverLog: () => readonly string[];
  /** The audit entries, parsed. */
  readonly audit: () => readonly Wire[];
  /** The rule ids of the audit entries that carry a decision. */
  readonly ruleIds: () => readonly string[];
  /** Whether any session file records the session as suspect. */
  readonly tainted: () => boolean;
  /** Closes the client's end and resolves with the proxy's exit code. */
  finish(): Promise<number>;
  readonly done: Promise<number>;
}

const sleep = sleepMs;

export function startRig(options: RigOptions = {}): Rig {
  const home = mkdtempSync(join(tmpdir(), 'stroq-strict-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'stroq-strict-cwd-'));
  const serverLogFile = join(cwd, 'server-received.log');
  const extra = options.env ?? {};
  const restoreEnv = setEnv({
    ...extra,
    STROQ_HOME: home,
    STRICT_SERVER_LOG: serverLogFile,
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines: string[] = [];
  let carry = '';
  let errText = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    carry += chunk;
    for (let nl = carry.indexOf('\n'); nl !== -1; nl = carry.indexOf('\n')) {
      lines.push(carry.slice(0, nl));
      carry = carry.slice(nl + 1);
    }
  });
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    errText += chunk;
  });

  const done = runMcpProxy({
    engine: options.engine === undefined ? createEngine() : options.engine(createEngine()),
    sessionId: 'mcp:strict-test',
    server: 'srv',
    cwd,
    passEnv: ['STRICT_SERVER_LOG', ...Object.keys(extra)],
    command: process.execPath,
    args: [SERVER],
    stdin,
    stdout,
    stderr,
    ...(options.cloak === true ? { cloak: true } : {}),
    ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
    ...(options.strict === true
      ? {
          strict: true,
          strictScanMs: options.strictScanMs ?? 120_000,
          ...(options.strictMaxWithheld === undefined
            ? {}
            : { strictMaxWithheld: options.strictMaxWithheld }),
          ...(options.strictMaxBenign === undefined
            ? {}
            : { strictMaxBenign: options.strictMaxBenign }),
        }
      : {}),
  });

  live.add({ stdin, done, dirs: [home, cwd], restoreEnv });

  const parse = (line: string): Wire => {
    try {
      return JSON.parse(line) as Wire;
    } catch {
      return { unparsable: line };
    }
  };
  const messages = (): readonly Wire[] => lines.map(parse);

  const rig: Rig = {
    home,
    stderr: () => errText,
    lines: () => lines,
    messages,
    send: (message) => {
      stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
    },
    call: (id, name, args = {}) =>
      rig.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    answerFor: async (id, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages().find((m) => m['id'] === id && ('result' in m || 'error' in m));
        if (found !== undefined) return found;
        if (Date.now() > deadline)
          throw new Error(`no answer for id ${String(id)} within ${timeoutMs} ms`);
        await sleep(25);
      }
    },
    handshake: async () => {
      rig.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      await rig.answerFor(1);
      rig.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      rig.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await rig.answerFor(2);
    },
    serverLog: () =>
      existsSync(serverLogFile)
        ? readFileSync(serverLogFile, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : [],
    audit: () => {
      const file = join(home, 'audit.jsonl');
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map(parse)
        : [];
    },
    ruleIds: () =>
      rig
        .audit()
        .map((entry) => (entry['decision'] as { ruleId?: string } | undefined)?.ruleId)
        .filter((id): id is string => typeof id === 'string'),
    tainted: () => {
      const dir = join(home, 'sessions');
      if (!existsSync(dir)) return false;
      return readdirSync(dir).some((name) =>
        readFileSync(join(dir, name), 'utf8').includes('"suspect"'),
      );
    },
    finish: () => {
      stdin.end();
      return done;
    },
    done,
  };
  return rig;
}

/**
 * Polls `check` until it stops throwing. For what a test has to see happen after it has
 * already seen something else (the proxy writing the audit, the server receiving a line):
 * a fixed sleep either fails on a slow machine or wastes time on a fast one. The default
 * of `vi.waitFor` is one second, which a loaded machine does not respect.
 */
export const eventually = <T>(check: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(check, { timeout: 60_000, interval: 25 });

/** The `error.message` of an answer, or '' when it is not an error. */
export const errorText = (answer: Wire): string =>
  typeof answer['error'] === 'object' && answer['error'] !== null
    ? String((answer['error'] as { message?: unknown }).message)
    : '';

/** Every text the client was given, joined: what must never contain the server's own words. */
export const everythingSaid = (rig: Rig): string => [...rig.lines(), rig.stderr()].join('\n');

/**
 * An engine that takes `ms` to judge a call to the tool named `tool` (before it asks the
 * real one), which is how a test makes a request still be in the proxy's hands while the
 * server is ended.
 */
export const withSlowPre =
  (tool: string, ms: number) =>
  (real: StroqEngine): StroqEngine =>
    new Proxy(real, {
      get(target, property) {
        if (property === 'pre')
          return async (event: Parameters<StroqEngine['pre']>[0]) => {
            if (event.toolName.endsWith(`__${tool}`)) await sleepMs(ms);
            return target.pre(event);
          };
        const member = Reflect.get(target, property) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
