import { join } from 'node:path';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import type { JsonEdit, JsonPlan, PlanOptions } from '../../src/harden/types.js';
import { tempDir } from './helpers.js';

/** What the tests of `planJsonEdits` share: a document as an editor saves it, and a plan of it. */

/** A JSON document as an editor would save it. */
export const text = (value: unknown, indent: string | number = 2, finalNewline = true): string =>
  `${JSON.stringify(value, null, indent)}${finalNewline ? '\n' : ''}`;

/** Plans `edits` against a file holding `contents` (`null`: there is no such file). */
export function plan(
  contents: string | null,
  edits: readonly JsonEdit[],
  extra: Partial<PlanOptions> = {},
): JsonPlan {
  const file = join(tempDir(), 'settings.json');
  return planJsonEdits(file, edits, { read: () => contents, ...extra });
}

export const addDeny = (value: string): JsonEdit => ({
  kind: 'json-array-add',
  path: ['permissions', 'deny'],
  value,
});
