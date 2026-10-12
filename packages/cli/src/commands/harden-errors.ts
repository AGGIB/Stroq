import { HardenError, type HardenErrorCode } from '../harden/types.js';
import { outsideLine } from '../ui/layout.js';
import type { Verdict } from './harden-plan.js';

/**
 * A failure as an answer: the exit code it earns and what to say, with no stack. The engine's errors
 * carry a message that names paths a repository chose, and the system's carry the path of the file they
 * are about, so each message is made safe to print on one line.
 *
 * An error that says an acknowledgement is missing is exit code 3, like a plan that says so before it is
 * asked to apply; every other error is exit code 1.
 */

const NEEDS_ACKNOWLEDGEMENT: ReadonlySet<HardenErrorCode> = new Set([
  'link-not-acknowledged',
  'credential-loss-not-acknowledged',
  'reformat-not-acknowledged',
]);

export function failureOf(err: unknown): Verdict {
  if (err instanceof HardenError) {
    const asked = NEEDS_ACKNOWLEDGEMENT.has(err.code);
    return {
      code: asked ? 3 : 1,
      outcome: {
        status: asked ? 'needs-acknowledgement' : 'failed',
        message: outsideLine(err.message),
        details: { code: err.code },
      },
    };
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 1,
    outcome: {
      status: 'failed',
      message: outsideLine(typeof code === 'string' ? `${code}: ${message}` : message),
    },
  };
}
