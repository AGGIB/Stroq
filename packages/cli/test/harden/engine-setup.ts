import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTargetText } from '../../src/harden/atomic.js';
import { applyPlan, undoFile, type ApplyOptions } from '../../src/harden/index.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import { planTextBlock } from '../../src/harden/textblock.js';
import type {
  HardenEnv,
  JsonEdit,
  JsonPlan,
  PlanOptions,
  TextBlockPlan,
} from '../../src/harden/types.js';
import { fakeEnv, steppingClock, tempDir } from './helpers.js';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A JSON document as an editor would save it. */
export const jsonText = (value: unknown, indent: string | number = 2): string =>
  `${JSON.stringify(value, null, indent)}\n`;

export const addDeny = (value: string): JsonEdit => ({
  kind: 'json-array-add',
  path: ['permissions', 'deny'],
  value,
});

export const setSandbox = (value: boolean): JsonEdit => ({
  kind: 'json-set',
  path: ['sandbox', 'enabled'],
  value,
});

export const IGNORE_ID = 'cursor-ignore';
export const IGNORE_LINES = ['.env', '.env.*', '**/*.pem'];

/**
 * A fake home and a fake project, an env whose clock moves a second at a time (so that every
 * apply gets a copy id of its own), and planners that read the real files in that project with
 * its root named, as a command would.
 */
export function engine(overrides: Partial<HardenEnv> = {}) {
  const home = tempDir('home');
  const project = tempDir('project');
  const env = fakeEnv(home, { now: steppingClock(), ...overrides });
  const file = (name: string): string => join(project, name);
  const options = (extra: Partial<PlanOptions> = {}): PlanOptions => ({
    read: readTargetText,
    recipe: 'test-recipe',
    root: project,
    ...extra,
  });
  return {
    home,
    project,
    env,
    file,
    planJson: (
      name: string,
      edits: readonly JsonEdit[],
      extra: Partial<PlanOptions> = {},
    ): JsonPlan => planJsonEdits(file(name), edits, options(extra)),
    planBlock: (
      name: string,
      lines: readonly string[] = IGNORE_LINES,
      extra: Partial<PlanOptions> = {},
    ): TextBlockPlan => planTextBlock(file(name), { id: IGNORE_ID, lines }, options(extra)),
  };
}

export type Engine = ReturnType<typeof engine>;

/** Writes `before` (or leaves the file out), applies `edits` to it, and hands back what undo needs. */
export async function applied(
  e: Engine,
  name: string,
  before: string | null,
  edits: readonly JsonEdit[],
  options: ApplyOptions = {},
) {
  if (before !== null) writeFileSync(e.file(name), before);
  const plan = e.planJson(name, edits);
  const result = await applyPlan(plan, e.env, options);
  return { plan, result, real: plan.real, path: e.file(name) };
}

/** The owner edits a JSON file the way an editor would. */
export function owner(
  path: string,
  change: (doc: Record<string, unknown>) => Record<string, unknown>,
): void {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, jsonText(change(doc)));
}

/** Undoes what Stroq did to `real`, with the project as the root, as a command would. */
export const undo = (e: Engine, real: string) => undoFile(e.env, real, { root: e.project });
