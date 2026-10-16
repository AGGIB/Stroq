import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * A real `runMcpProxy` in front of `strict-server.mjs`, driven through in-memory
 * streams: what each strict-mode test needs to send a request and see exactly what the
 * client was given, what the server was sent, and what the audit and the session say.
 */

const SERVER = join(import.meta.dirname, 'strict-server.mjs');

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function startRig(options: RigOptions = {}): Rig {
  const home = mkdtempSync(join(tmpdir(), 'stroq-strict-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'stroq-strict-cwd-'));
  process.env['STROQ_HOME'] = home;
  const serverLogFile = join(cwd, 'server-received.log');
  process.env['STRICT_SERVER_LOG'] = serverLogFile;
  const extra = options.env ?? {};
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
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
    engine: createEngine(),
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

/** The `error.message` of an answer, or '' when it is not an error. */
export const errorText = (answer: Wire): string =>
  typeof answer['error'] === 'object' && answer['error'] !== null
    ? String((answer['error'] as { message?: unknown }).message)
    : '';

/** Every text the client was given, joined: what must never contain the server's own words. */
export const everythingSaid = (rig: Rig): string => [...rig.lines(), rig.stderr()].join('\n');
