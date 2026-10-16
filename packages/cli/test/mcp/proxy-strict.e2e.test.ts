import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

/**
 * `stroq mcp --strict` as a client launches it: the built CLI, real pipes, the flags on
 * the command line. The in-process tests cover each behaviour; this covers the wiring a
 * user depends on — the flags are accepted, the withheld request is answered, a refusal
 * to start is loud — and that the exit code says what happened.
 */

const server = join(import.meta.dirname, 'strict-server.mjs');
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of children) if (!child.killed) child.kill('SIGKILL');
  children.clear();
});

interface Run {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[];
  readonly stderr: () => string;
  /** Resolves with the exit code when the proxy ends, however it ends. */
  readonly closed: Promise<number | null>;
  send(value: unknown): void;
  answer(id: number): Promise<Record<string, unknown>>;
  /** Closes the client's end, then waits for the proxy to end. */
  exit(): Promise<number | null>;
}

function start(extra: readonly string[]): Run {
  const home = mkdtempSync(join(tmpdir(), 'stroq-strict-e2e-'));
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      'mcp',
      '--server',
      'demo',
      '--client',
      'e2e',
      '--cwd',
      home,
      '--pass-env',
      '',
      ...extra,
      '--',
      process.execPath,
      server,
    ],
    { env: { ...process.env, HOME: home, STROQ_HOME: join(home, 'stroq') }, stdio: 'pipe' },
  );
  children.add(child);
  // Registered at spawn: a proxy that ends a server exits within moments of writing its
  // last answer, and a listener added after that would wait for an event already gone.
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const lines: string[] = [];
  let carry = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    carry += chunk;
    for (let nl = carry.indexOf('\n'); nl !== -1; nl = carry.indexOf('\n')) {
      lines.push(carry.slice(0, nl));
      carry = carry.slice(nl + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const run: Run = {
    child,
    lines,
    stderr: () => err,
    send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`),
    answer: async (id) => {
      for (let i = 0; i < 400; i += 1) {
        const hit = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((m) => m['id'] === id);
        if (hit !== undefined) return hit;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no answer for ${id}`);
    },
    closed,
    exit: () => {
      child.stdin.end();
      return closed;
    },
  };
  return run;
}

const call = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('stroq mcp --strict, as a client launches it', () => {
  it('answers a request whose result it withheld, and exits 0 when the client closes', async () => {
    const run = start(['--strict']);
    run.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await run.answer(1);
    run.send(call(3, 'extrakey'));
    const answer = await run.answer(3);
    expect(JSON.stringify(answer)).toContain('(unread-content)');
    expect(run.lines.join('\n')).not.toContain('Ignore all previous instructions');
    expect(await run.exit()).toBe(0);
  });

  it('exits non-zero, saying why on stderr, when it ends a server for withholding too much', async () => {
    const run = start(['--strict', '--strict-max-withheld', '5']);
    run.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await run.answer(1);
    run.send(call(3, 'floodsampling'));
    const answer = await run.answer(3);
    expect(JSON.stringify(answer)).toContain('more than 5 withheld');
    const code = await run.closed;
    expect(code).toBe(1);
    expect(run.stderr()).toContain('strict mode ended the server');
  });

  it('does not change the default: without the flag the same result is forwarded', async () => {
    const run = start([]);
    run.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await run.answer(1);
    run.send(call(3, 'extrakey'));
    expect(JSON.stringify(await run.answer(3))).toContain('Ignore all previous instructions');
    expect(await run.exit()).toBe(0);
  });

  it('refuses to start on a limit it cannot read, before any server is launched', async () => {
    const run = start(['--strict', '--strict-max-withheld', 'lots']);
    const code = await run.closed;
    expect(code).toBe(2);
    expect(run.stderr()).toContain('--strict-max-withheld needs a whole number');
    expect(run.stderr()).toContain('usage: stroq mcp');
  });

  it('refuses a limit given without --strict', async () => {
    const run = start(['--strict-max-withheld', '5']);
    const code = await run.closed;
    expect(code).toBe(2);
    expect(run.stderr()).toContain('--strict-max-withheld needs --strict');
  });
});
