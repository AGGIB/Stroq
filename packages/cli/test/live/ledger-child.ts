import { openLedger } from '../../src/live/budget.js';

/**
 * Run by `budget-processes.test.ts`, never by the test runner: a process of its own that takes requests
 * from the ledger file it is given, so that the lock between PROCESSES is what is tested (inside one
 * process a take is a single synchronous step, and the lock has nothing to do).
 *
 * usage: ledger-child <ledger file> <cap> <attempts>
 *
 * It says `ready` when it is loaded, waits for a line on stdin, and only then takes, so that the parent
 * can let several of these start at the same moment. It prints one line of JSON: how many requests it
 * was given, and why it was refused the rest.
 */
const [file, cap, attempts] = process.argv.slice(2);
if (file === undefined || cap === undefined || attempts === undefined)
  throw new Error('usage: ledger-child <ledger file> <cap> <attempts>');

const ledger = openLedger({ path: file, limit: Number(cap), lockTimeoutMs: 120_000 });

process.stdout.write('ready\n');
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));

let granted = 0;
const refused: Record<string, number> = {};
for (let i = 0; i < Number(attempts); i += 1) {
  const taken = await ledger.take(1, `child ${process.pid} request ${i}`);
  if (taken.ok) granted += 1;
  else refused[taken.why] = (refused[taken.why] ?? 0) + 1;
}
process.stdout.write(`${JSON.stringify({ granted, refused })}\n`);
process.stdin.pause();
