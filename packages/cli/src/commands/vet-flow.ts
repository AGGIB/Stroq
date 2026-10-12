import { writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { stableStringify } from '@stroq/core';
import {
  READING_PHRASES,
  failedReadingSpot,
  type ReadingName,
} from '../install/inspect/blind-spots.js';
import {
  INSPECT_RULES_ID,
  InspectError,
  failedReadings,
  inspectTree,
  inspectWithReadings,
  passportIsIncomplete,
} from '../install/inspect/index.js';
import { showable } from '../install/inspect/safe-text.js';
import { ReadDirError, readDirTree } from '../install/read-dir.js';
import { TreeError } from '../install/tree.js';
import { SourceRefSchema, type Passport } from '../install/types.js';
import { neutralizeControls } from '../terminal-safe.js';
import { outsideLine } from '../ui/layout.js';
import { stroqVersion } from '../version.js';
import { renderCard } from './vet-card.js';
import { renderPassport } from './vet-render.js';
import { lineText } from './vet-text.js';
import type { VetDeps, VetOptions } from './vet-types.js';

/**
 * The doing of `stroq vet`: read the folder into a tree, make the passport of that tree, and show it in the
 * form that was asked for. Nothing from the folder is run, and nothing is written but the file `--out` names.
 *
 * Exit codes: 0 complete; 1 `--expect` did not match, or a reading failed; 2 the output file could not be
 * made (the command line was well formed, but it asks for a file that is there already); 3 the files cannot
 * be read as an artifact. The usage faults (also 2) are `vet.ts`'s.
 */
const EXIT_INCOMPLETE = 1;
const EXIT_OUTPUT = 2;
const EXIT_UNREADABLE = 3;
/** The longest label a passport allows of a source (`types.ts`); the folder name is cut to less, for the escape of a prefix. */
const LABEL_MAX = 79;
const FALLBACK_LABEL = 'folder';
const KIND_ADVICE = ' (--kind skill, --kind mcp or --kind plugin)';

interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const streamsOf = (deps: VetDeps): Streams => ({
  out: deps.out ?? ((text) => void process.stdout.write(text)),
  err: deps.err ?? ((text) => void process.stderr.write(text)),
});

/**
 * The name of the folder as a passport may carry it: the base name, made safe, with no separator in it, and
 * never one that starts as an absolute path does (a `~`, a drive letter), because a passport is committed
 * and read on other machines and says which folder it was, not where. A name that cannot be made fit is `folder`.
 */
export function labelOf(dir: string): string {
  const safe = showable(basename(resolve(dir)), LABEL_MAX).replace(/[\\/]/g, '_');
  const label = /^(?:[~]|[A-Za-z]:)/.test(safe) ? `_${safe}` : safe;
  return SourceRefSchema.safeParse({ type: 'dir', label }).success ? label : FALLBACK_LABEL;
}

/** Why the files could not be read as an artifact, in the fixed words of the error, or null for a fault that is not one of ours. */
function unreadableBecause(error: unknown): string | null {
  if (error instanceof InspectError) {
    return error.code === 'cannot-tell-kind' ? `${error.message}${KIND_ADVICE}` : error.message;
  }
  if (error instanceof ReadDirError || error instanceof TreeError) return error.message;
  return null;
}

type Made =
  { readonly passport: Passport; readonly failure?: undefined } | { readonly failure: string };

async function makePassport(options: VetOptions, deps: VetDeps): Promise<Made> {
  try {
    const { tree, blindSpots } = await readDirTree(
      options.from,
      deps.platform === undefined ? {} : { platform: deps.platform },
    );
    const context = {
      kind: options.kind,
      source: { type: 'dir', label: labelOf(options.from) } as const,
      extraBlindSpots: blindSpots,
      stroqVersion: deps.stroqVersion ?? stroqVersion(),
      rulesId: INSPECT_RULES_ID,
    };
    const passport =
      deps.readings === undefined
        ? inspectTree(tree, context)
        : inspectWithReadings(tree, context, deps.readings);
    return { passport };
  } catch (error) {
    const because = unreadableBecause(error);
    // A fault that is not a typed one is a fault of Stroq and is not turned into a sentence: the message of a
    // system error holds a path, and this command prints no path from inside the artifact.
    if (because === null) throw error;
    return { failure: because };
  }
}

/** What is printed for the form that was asked for. */
function textOf(passport: Passport, options: VetOptions): string {
  if (options.json) return `${stableStringify(passport)}\n`;
  if (options.card) return renderCard(passport);
  return renderPassport(passport, { matchedExpect: options.expect !== null });
}

function whyNotWritten(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EEXIST') return 'it exists';
  if (code === 'ENOENT') return 'its folder does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  // Only a code written like an errno is repeated: the rest of an error holds a path.
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,15}$/.test(code)
    ? code
    : 'it could not be created';
}

/** Whether `file` is somewhere inside `folder`, judged on the paths as they are written. */
function isInside(folder: string, file: string): boolean {
  const way = relative(resolve(folder), resolve(file));
  return way !== '' && way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way);
}

const INSIDE_NOTE =
  'stroq vet: note: the file is inside the folder that was read, so from now on it is one of that ' +
  "folder's files and the next reading of the folder has another digest. Write it outside the folder " +
  'to keep this digest.\n';

/** Writes `text` to a file that does not exist yet. `wx` refuses an existing file and a link, even a dangling one. */
function writeNew(options: VetOptions, path: string, text: string, io: Streams): number {
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    io.err(`stroq vet: not written: ${outsideLine(path)} (${whyNotWritten(error)})\n`);
    return EXIT_OUTPUT;
  }
  io.out(`wrote ${outsideLine(path)}\n`);
  // A passport kept beside the files it describes is one of them the next time: it is said once, and not refused.
  if (isInside(options.from, path)) io.err(INSIDE_NOTE);
  return 0;
}

function show(text: string, io: Streams): number {
  io.out(text);
  return 0;
}

function mismatchText(expected: string, found: string): string {
  return (
    'stroq vet: the digest of the files is not the one expected\n' +
    `  expected: sha256:${expected}\n` +
    `  found:    sha256:${found}\n`
  );
}

/** What is told of a passport that lacks what a reading finds: each reading by its fixed name. */
function incompleteText(passport: Passport): string {
  const spots = failedReadings(passport).map((name) =>
    Object.hasOwn(READING_PHRASES, name)
      ? failedReadingSpot(name as ReadingName)
      : `a reading failed (${lineText(name, 48)}), and what it finds is missing from this passport`,
  );
  return `stroq vet: the passport is incomplete:\n${spots.map((spot) => `  ${spot}\n`).join('')}`;
}

export async function vetFlow(options: VetOptions, deps: VetDeps): Promise<number> {
  const io = streamsOf(deps);
  const made = await makePassport(options, deps);
  if (made.failure !== undefined) {
    io.err(`stroq vet: ${outsideLine(made.failure)}\n`);
    return EXIT_UNREADABLE;
  }
  const { passport } = made;
  if (options.expect !== null && options.expect !== passport.artifact.digest) {
    io.err(mismatchText(options.expect, passport.artifact.digest));
    return EXIT_INCOMPLETE;
  }
  // The text is made safe once more on its way out: the screen and the card already are, and the passport
  // is JSON that has no raw control in it, so this changes nothing a reader sees and keeps a file clean.
  const text = neutralizeControls(textOf(passport, options));
  const written = options.out === null ? show(text, io) : writeNew(options, options.out, text, io);
  if (written !== 0) return written;
  if (!passportIsIncomplete(passport)) return 0;
  io.err(incompleteText(passport));
  return EXIT_INCOMPLETE;
}
