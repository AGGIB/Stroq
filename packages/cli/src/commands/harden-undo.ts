import { existsSync } from 'node:fs';
import { resolveRealPath } from '../harden/atomic.js';
import { readBackup } from '../harden/backup.js';
import { undoFile, type UndoResult } from '../harden/index.js';
import { entriesFor, readManifest, type ManifestEntry } from '../harden/manifest.js';
import { readTargetBytes } from '../harden/read.js';
import type { HardenScope, Recipe, RecipeTarget } from '../harden/recipes/index.js';
import { sha256Text } from '../harden/types.js';
import { outside, outsideLine } from '../ui/layout.js';
import { askPerson, notAsked } from './harden-ask.js';
import type { HardenContext } from './harden-deps.js';
import type { HardenFlags } from './harden-flags.js';
import type { Outcome, Printer } from './harden-printer.js';
import { recordLines } from './harden-record.js';

/**
 * `stroq harden undo`: takes back what Stroq recorded for the file a recipe changes.
 *
 * The engine decides how. When the file is exactly as Stroq left it, the copy made before the change is
 * put back, byte for byte. When it is not (the owner has edited it since, or no copy was kept), only
 * the entries Stroq added are taken out, and the rest of the file stays as it is. The engine has no way
 * to show that before it is done, so what is shown first is the record, and which of the two ways the
 * file's present state makes likely; what was actually done is shown after, with the engine's own diff.
 *
 * It undoes everything recorded for the file, newest first, which is one change in the ordinary case.
 */

const QUESTION = 'Undo this?';

/** Which of the engine's two ways the file's present state leads to, in a sentence. */
function expectation(ctx: HardenContext, real: string, entries: readonly ManifestEntry[]): string {
  const newest = entries[entries.length - 1];
  const bytes = readTargetBytes(real);
  if (newest === undefined || bytes === null) {
    return 'The file is not there now, so undo has nothing to take out of it and only clears the record.';
  }
  if (sha256Text(bytes.toString('utf8')) !== newest.shaAfter) {
    return 'The file has changed since, so undo takes out only what Stroq added.';
  }
  if (newest.created) {
    return 'The file is exactly as Stroq left it, and Stroq made it, so undo removes it.';
  }
  const copy = newest.backup === null ? null : readBackup(ctx.env, real, newest.backup);
  return copy !== null && sha256Text(copy) === newest.shaBefore
    ? 'The file is exactly as Stroq left it, so undo puts back the copy taken before the change.'
    : 'No copy of the file is kept, so undo takes out only what Stroq added.';
}

function bullets(lines: readonly string[]): string[] {
  return lines.map((line) => `  - ${outsideLine(line)}`);
}

/** What the engine did, in plain sentences. */
function doneLines(result: UndoResult, entries: readonly ManifestEntry[]): string[] {
  const madeByStroq = entries[0]?.created === true;
  const gone = madeByStroq && !existsSync(result.real);
  const first =
    result.status === 'restored'
      ? gone
        ? 'Undone. The file Stroq made is removed.'
        : 'Undone. The file is as it was before Stroq changed it, byte for byte.'
      : result.status === 'surgical'
        ? 'Undone. Stroq took out what it added and left everything else in the file as it is.'
        : "Nothing of Stroq's was left in the file, so only its record is cleared.";
  return [
    first,
    ...(result.kept.length === 0
      ? []
      : [
          '',
          'Left as they are, because they are no longer what Stroq wrote:',
          ...bullets(result.kept),
        ]),
    ...(result.reformatted
      ? ['', 'The file had to be laid out again to take the entries out.']
      : []),
    ...(result.notices.length === 0 ? [] : ['', 'Notes:', ...bullets(result.notices)]),
    ...(result.diff === ''
      ? []
      : ['', 'The change undo made:', outside(result.diff).replace(/\n$/, '')]),
  ];
}

function outcomeOf(
  result: UndoResult,
  entries: readonly ManifestEntry[],
): { code: number; outcome: Outcome } {
  if (result.status === 'blocked') {
    const detail = outsideLine(result.blocked?.detail ?? 'the file cannot be edited safely');
    return {
      code: 1,
      outcome: {
        status: 'failed',
        message: `could not undo: ${detail}; the file was not touched, and the record is kept`,
      },
    };
  }
  const details = { undo: result.status, applications: result.applications };
  return {
    code: 0,
    outcome: { status: 'undone', message: doneLines(result, entries).join('\n'), details },
  };
}

function preface(target: RecipeTarget, entries: readonly ManifestEntry[], why: string): string {
  const lines = [
    `stroq harden: undo ${target.recipe} (${target.agent}, ${target.scope} scope)`,
    `File: ${outsideLine(target.file)}`,
    '',
    ...recordLines(entries),
    '',
    why,
  ];
  return `${lines.join('\n')}\n`;
}

/** Undoes what Stroq recorded for the file `target` names. Returns the exit code. */
export async function undoTarget(
  ctx: HardenContext,
  target: RecipeTarget,
  flags: HardenFlags,
  printer: Printer,
): Promise<number> {
  const manifest = readManifest(ctx.env);
  const real =
    entriesFor(manifest, target.file).length > 0 ? target.file : resolveRealPath(target.file);
  const entries = entriesFor(manifest, real);
  if (entries.length === 0) {
    const message = `Nothing to undo: Stroq has no record of a change to ${outsideLine(target.file)}.`;
    return printer.finish(0, { status: 'nothing-to-do', message });
  }
  printer.show(preface(target, entries, expectation(ctx, real, entries)));
  const answer = await askPerson(ctx, flags, QUESTION);
  if (answer !== 'yes') {
    const status = answer === 'no' ? 'declined' : 'refused';
    return printer.finish(1, { status, message: notAsked(answer, 'undo') });
  }
  const result = await undoFile(ctx.env, target.file, { root: target.root });
  const { code, outcome } = outcomeOf(result, entries);
  return printer.finish(code, outcome);
}

export function undoCommand(
  ctx: HardenContext,
  recipe: Recipe,
  scope: HardenScope,
  flags: HardenFlags,
  printer: Printer,
): Promise<number> {
  return undoTarget(
    ctx,
    recipe.target({
      cwd: ctx.cwd,
      home: ctx.home,
      scope,
      claudeConfigDir: ctx.claudeConfigDir,
    }),
    flags,
    printer,
  );
}
