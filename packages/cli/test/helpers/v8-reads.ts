import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * V8 as the oracle for which names a piece of JavaScript reads, and whether it accepts the text at all (`v8-reads.mjs`
 * says how). A child process runs it, with the flag that gives it modules, so that a snippet can be read in both goals.
 */
const PROGRAM = join(dirname(fileURLToPath(import.meta.url)), 'v8-reads.mjs');

export interface Reads {
  /** V8 parsed the text in that goal. */
  readonly accepted: boolean;
  /** The names that running it read, on the global object or as a member of anything. */
  readonly reads: readonly string[];
}

export interface Item {
  readonly code: string;
  readonly goal: 'script' | 'module';
}

/** Explicit samples for ordinary tests, or a range for the opt-in exhaustive checks. */
export type CodePoints =
  | { readonly points: readonly number[] }
  | { readonly from: number; readonly to: number; readonly step: number };

function ask<T>(request: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['NODE_OPTIONS'];
    const child = spawn(process.execPath, ['--experimental-vm-modules', '--no-warnings', PROGRAM], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    process.once('exit', stop);
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', stop);
      done();
    };
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // An early exit or the deadline can close stdin before its buffered request is sent; close reports the cause.
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => {
        // Wait for close before rejecting: a timeout never leaves the oracle running behind the failed test.
        if (timedOut) {
          reject(new Error(`the V8 oracle timed out after ${timeoutMs} ms and was killed`));
        } else if (code !== 0) {
          reject(
            new Error(`the V8 oracle failed (${code}): ${Buffer.concat(err).toString('utf8')}`),
          );
        } else {
          try {
            resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as T);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** What V8 makes of each snippet: accepted or not, and the names read when it ran. */
export function v8Reads(items: readonly Item[], timeoutMs = 45_000): Promise<Reads[]> {
  return ask<Reads[]>({ mode: 'reads', items }, timeoutMs);
}

/**
 * The code points that, put where U+0001 stands in a shape, make V8 run it and read `name` and every name the shape needs
 * (its receiver, which a character that joins it to the dot would turn into another name). A shape is a text with U+0001
 * in it; `points`, or `from`, `to` and `step`, say which code points are tried.
 */
export async function v8Sweep(
  shapes: readonly { readonly text: string; readonly needs: readonly string[] }[],
  name: string,
  range: CodePoints,
  timeoutMs = 45_000,
): Promise<readonly { readonly shape: number; readonly cp: number }[]> {
  const answer = await ask<{ ran: { shape: number; cp: number }[] }>(
    { mode: 'sweep', shapes, name, ...range },
    timeoutMs,
  );
  return answer.ran;
}

/** The code points that V8 reads as part of an identifier when they stand right after, or right before, `name`. */
export function v8IdentifierParts(
  name: string,
  range: CodePoints,
  timeoutMs = 45_000,
): Promise<{ readonly after: readonly number[]; readonly before: readonly number[] }> {
  return ask({ mode: 'identifier', name, ...range }, timeoutMs);
}
