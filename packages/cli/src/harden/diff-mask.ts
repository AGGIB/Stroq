import { neutralizeControls } from '@stroq/core';
import { findCredentialShape, hiddenLineMask } from './credential-shape.js';
import { assertDiffable, diffText } from './diff.js';

/**
 * The diff of a change, with the lines that hold credential-shaped text hidden.
 *
 * A diff is a channel that values travel in: it is printed to the terminal, and when an agent ran
 * the command, it is read by the agent's model. Shown around a change to a config file, the
 * context lines can be the line a token sits on. So when either side of the change holds
 * credential-shaped text, every line of the diff that does (changed lines and the context around
 * them alike) is shown as a fixed placeholder, and the diff says that it did so.
 */

/** What the owner is told when a diff left lines out. */
export const DIFF_HIDDEN_NOTICE = 'the diff hides lines that hold credential-shaped text';

/**
 * A line of the text as it may be printed. A repository writes these lines, and a terminal obeys
 * the control sequences in them, so each such character is written out as a visible escape. The
 * carriage return of a CRLF line break is part of the line's layout and stays.
 */
function printable(content: string): string {
  const crlf = content.endsWith('\r');
  return neutralizeControls(crlf ? content.slice(0, -1) : content) + (crlf ? '\r' : '');
}

export interface MaskedDiff {
  readonly diff: string;
  /** Some line of the diff was shown as the placeholder. */
  readonly hidden: boolean;
}

/**
 * The unified diff from `before` to `after`, where `null` is a file that is not there. Throws
 * `HardenError('diff-too-large')` for texts the preview will not compute a diff of.
 */
export function maskedDiff(before: string | null, after: string | null, path: string): MaskedDiff {
  const old = before ?? '';
  const next = after ?? '';
  // Asked first: a text too large to diff is not worth reading for credentials either.
  assertDiffable(old);
  assertDiffable(next);
  const sensitive = findCredentialShape(old) !== null || findCredentialShape(next) !== null;
  const result = diffText(old, next, {
    path,
    show: printable,
    ...(before === null ? { oldMissing: true } : {}),
    ...(after === null ? { newMissing: true } : {}),
    ...(sensitive ? { hide: { old: hiddenLineMask(old), new: hiddenLineMask(next) } } : {}),
  });
  return { diff: result.text, hidden: result.hidden > 0 };
}
