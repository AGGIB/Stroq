import vm from 'node:vm';
import {
  extractAtomsDeep,
  loadBundledRules,
  normalizeText,
  scanContent,
  scanFieldsForTool,
  scanTargetForTool,
} from '@stroq/core';
import { STRICT_SCAN_DEADLINE_MS } from './strict-limits.js';

/**
 * Running a scan under a clock the runtime enforces.
 *
 * The scanner checks its wall-clock budget BETWEEN rules, so one slow rule on one
 * result is not interrupted: a single ~100 KB result was measured holding the whole
 * proxy for 12 to 18 seconds, with the pump (and so every other message) waiting behind
 * it. The structural fix in the scanner is a worker thread, which the single-file
 * bundle this ships as cannot spawn without a second entry file. `vm`'s `timeout`
 * option gives the same guarantee in-process: V8 terminates the script when the
 * deadline passes, including in the middle of a regular-expression match. The scan is
 * pure (it reads the rules and the text and writes nothing), so being stopped half-way
 * leaves nothing behind.
 *
 * What this bounds is a DRY RUN of the scans the engine is about to do. A result has
 * several texts to scan (the views of `strict-views.ts`) and the dry run does all of them
 * under ONE deadline: the clock is the message's, not each text's, so a result cannot buy
 * three deadlines by having three views. The engine's own `post` then runs the real scans,
 * on the same texts, in the same process, with the cost the dry run just showed to be
 * bounded; strict mode withholds a message whose dry run did not finish. That doubles the
 * scan cost of a strict result, which is a price paid for the bound, not an accident. It is a bound on a measured cost, not a proof: a
 * machine that became much slower between the two runs could still make the second one
 * long, and the engine's own (soft) budget then marks the message suspect and strict
 * mode withholds it as a timeout.
 */

/** `ok`: finished inside the deadline. `timeout`: ran out of time. `failed`: threw. */
export type BoundedScanVerdict = 'ok' | 'timeout' | 'failed';

/**
 * One scan. Returns true when the scanner stopped itself on its own (soft) budget
 * rather than finishing, which strict mode treats exactly like the hard deadline.
 */
export type ScanJob = (text: string, toolName: string, budgetMs: number) => boolean;

/** The scan and the atom extraction `engine.post` does, on the same text and surface. */
export const engineScanJob: ScanJob = (text, toolName, budgetMs) => {
  const scan = scanContent(
    loadBundledRules(),
    text,
    { budgetMs },
    { target: scanTargetForTool(toolName), ...scanFieldsForTool(toolName, text) },
  );
  extractAtomsDeep(normalizeText(text));
  return scan.timedOut === true;
};

const TIMEOUT_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
const isTimeout = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === TIMEOUT_CODE;

/**
 * Runs `job` on every text, one after the other, each with what is left of `deadlineMs`
 * as its own soft budget. True as soon as one of them stopped on its budget, and the rest
 * are not run.
 */
function scanEach(
  texts: readonly string[],
  toolName: string,
  deadlineMs: number,
  job: ScanJob,
): boolean {
  const started = performance.now();
  for (const [index, text] of texts.entries()) {
    const left = Math.max(1, Math.floor(deadlineMs - (performance.now() - started)));
    if (job(text, toolName, index === 0 ? deadlineMs : left)) return true;
  }
  return false;
}

/**
 * A function that runs `job` on every text of a message under ONE `deadlineMs`. One
 * context is reused for every call; each call only swaps in the closure it runs.
 */
export function createBoundedScan(
  deadlineMs: number = STRICT_SCAN_DEADLINE_MS,
  job: ScanJob = engineScanJob,
): (texts: readonly string[], toolName: string) => BoundedScanVerdict {
  const context = vm.createContext({ run: (): boolean => false });
  return (texts, toolName) => {
    context.run = (): boolean => scanEach(texts, toolName, deadlineMs, job);
    try {
      const timedOut = vm.runInContext('run()', context, { timeout: deadlineMs });
      return timedOut === true ? 'timeout' : 'ok';
    } catch (error) {
      return isTimeout(error) ? 'timeout' : 'failed';
    }
  };
}
