import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_PACKAGE, TSX_ARGS } from './child.js';

/**
 * The cap is the owner's, and more than one process can be spending it: two `stroq prove` at once, or a
 * run and a test. Inside one process a take reads and writes the file in a single synchronous step, so
 * that nothing a test does there can show whether the LOCK holds. Here two real processes take from one
 * file at the same moment, and what they were given between them must be the cap and not a request more.
 */
const CHILD = fileURLToPath(new URL('./ledger-child.ts', import.meta.url));
/**
 * Far above what the children need, and below the 120 s each test is given; it ends a hang. Each child loads
 * the source of core through `tsx` before it takes a request, which a loaded Windows runner is slow at, so
 * the time a child is given is four times as long there (and still shorter than a test).
 */
const CHILD_TIMEOUT_MS = process.platform === 'win32' ? 100_000 : 25_000;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-live-ledger-procs-'));
  file = join(dir, 'state', 'ledger.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Outcome {
  readonly granted: number;
  readonly refused: Readonly<Record<string, number>>;
}

/**
 * Starts `count` children against one ledger file, lets them all go at once when every one of them
 * has loaded, and returns what each said it was given.
 */
function takeFromProcesses(count: number, cap: number, attempts: number): Promise<Outcome[]> {
  const children = Array.from({ length: count }, () =>
    spawn(process.execPath, [...TSX_ARGS, CHILD, file, String(cap), String(attempts)], {
      cwd: CLI_PACKAGE,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }),
  );
  let ready = 0;
  const outcomes = children.map(
    (child) =>
      new Promise<Outcome>((resolve, reject) => {
        let out = '';
        let err = '';
        let started = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => (err += chunk));
        child.stdout.on('data', (chunk: string) => {
          out += chunk;
          if (!started && out.includes('ready\n')) {
            started = true;
            ready += 1;
            // Nobody goes until every child has loaded: the point is that they take together.
            if (ready === children.length) for (const each of children) each.stdin.write('go\n');
          }
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
          if (code !== 0 || signal !== null)
            reject(new Error(`a child ended with ${String(code ?? signal)}: ${err}`));
          else resolve(JSON.parse(out.split('\n').filter(Boolean).at(-1) ?? 'null') as Outcome);
        });
      }),
  );
  return Promise.all(outcomes);
}

const sum = (outcomes: readonly Outcome[], pick: (o: Outcome) => number): number =>
  outcomes.reduce((total, o) => total + pick(o), 0);

describe('a ledger shared by processes', () => {
  it('gives out the cap between two processes asking at the same moment, and not a request more', async () => {
    const outcomes = await takeFromProcesses(2, 30, 30);
    // Sixty asks for thirty requests. A lock that let two takes read the same count would lose a
    // write, and more than thirty would have been granted, or the file would count fewer.
    expect(sum(outcomes, (o) => o.granted)).toBe(30);
    expect(sum(outcomes, (o) => o.refused['limit-reached'] ?? 0)).toBe(30);
    expect(sum(outcomes, (o) => Object.values(o.refused).reduce((a, b) => a + b, 0))).toBe(30);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { used: number; entries: unknown[] };
    expect(stored.used).toBe(30);
    expect(stored.entries).toHaveLength(30);
  }, 120_000);

  it('counts every request when the processes ask for less than the cap between them', async () => {
    const outcomes = await takeFromProcesses(2, 30, 10);
    expect(sum(outcomes, (o) => o.granted)).toBe(20);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { used: number; entries: unknown[] };
    expect(stored.used).toBe(20);
    expect(stored.entries).toHaveLength(20);
  }, 120_000);

  it('holds for three processes as well', async () => {
    const outcomes = await takeFromProcesses(3, 12, 10);
    expect(sum(outcomes, (o) => o.granted)).toBe(12);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { used: number };
    expect(stored.used).toBe(12);
  }, 120_000);
});
