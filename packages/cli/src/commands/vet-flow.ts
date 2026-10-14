import { writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { stableStringify } from '@stroq/core';
import { usageError } from '../help.js';
import { ArchiveError } from '../install/archive-error.js';
import { readArchiveFile } from '../install/archive-file.js';
import { FetchError, fetchSourceTree } from '../install/fetch.js';
import { compareLines } from '../install/inspect/findings.js';
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
import { McpProbeRefusalError, probeMcpTree } from '../install/mcp-probe.js';
import { ReadDirError, readDirTree } from '../install/read-dir.js';
import { sourceTypeOf, type SourceType } from '../install/read-source.js';
import { parseOnlineSource, SourceSyntaxError } from '../install/source.js';
import { TreeError } from '../install/tree.js';
import { SourceRefSchema, type Passport, type Tree } from '../install/types.js';
import { neutralizeControls } from '../terminal-safe.js';
import { outsideLine } from '../ui/layout.js';
import { stroqVersion } from '../version.js';
import { renderCard } from './vet-card.js';
import { renderPassport } from './vet-render.js';
import { lineText } from './vet-text.js';
import type { VetDeps, VetOptions } from './vet-types.js';

/**
 * The doing of `stroq vet`: read the folder or the archive into a tree, make the passport of that tree, and
 * show it in the form that was asked for. Nothing from the folder or the archive is run, and nothing is
 * written but the file `--out` names.
 *
 * Exit codes: 0 complete; 1 `--expect` did not match, or a reading failed; 2 the output file could not be
 * made (the command line was well formed, but it asks for a file that is there already), or `--expect` was
 * asked of a folder on Windows; 3 the files cannot be read as an artifact. The other usage faults (also 2)
 * are `vet.ts`'s.
 */
const EXIT_UNCONFIRMED = 1;
const EXIT_OUTPUT = 2;
const EXIT_USAGE = 2;
const EXIT_UNREADABLE = 3;
/** The longest label a passport allows of a source (`types.ts`); the name is cut to less, for the escape of a prefix. */
const LABEL_MAX = 79;
/** What a source is called when its name cannot be made to fit a label (the root of a disk has none). */
const FALLBACK_LABELS: Readonly<Record<SourceType, string>> = { dir: 'folder', tarball: 'archive' };
const EXPECT_ON_WINDOWS =
  '--expect is not available on Windows for a folder: a folder read there has no executable bit, so its ' +
  'digest can differ from the digest of the same files read on Linux or macOS, and a bare digest cannot ' +
  'say which of them it is. Give the files as an archive (.tgz), which carries its own executable bits, ' +
  'or run it on Linux or macOS.';
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
 * The name of the folder or archive as a passport may carry it: the base name, made safe, with no separator
 * in it, and never one that starts as an absolute path does (a `~`, a drive letter), because a passport is
 * committed and read on other machines and says which folder or file it was, not where. A name that cannot
 * be made fit is `folder`, or `archive`.
 */
export function labelOf(path: string, type: SourceType = 'dir'): string {
  const safe = showable(basename(resolve(path)), LABEL_MAX).replace(/[\\/]/g, '_');
  const label = /^(?:~|[A-Za-z]:)/.test(safe) ? `_${safe}` : safe;
  return SourceRefSchema.safeParse({ type, label }).success ? label : FALLBACK_LABELS[type];
}

/** Why the files could not be read as an artifact, in the fixed words of the error, or null for a fault that is not one of ours. */
function unreadableBecause(error: unknown): string | null {
  if (error instanceof InspectError) {
    return error.code === 'cannot-tell-kind' ? `${error.message}${KIND_ADVICE}` : error.message;
  }
  if (
    error instanceof ReadDirError ||
    error instanceof ArchiveError ||
    error instanceof TreeError ||
    error instanceof FetchError
  ) {
    return error.message;
  }
  return null;
}

type Made =
  | {
      readonly passport: Passport;
      readonly tree: Tree;
      readonly failure?: undefined;
      readonly usage?: undefined;
    }
  | { readonly failure: string; readonly usage?: undefined }
  | { readonly usage: string; readonly failure?: undefined };

/** The tree of what `--from` names: a folder is walked, and a file is read as an archive. */
function readSource(type: SourceType, from: string, deps: VetDeps) {
  return type === 'dir'
    ? readDirTree(from, deps.platform === undefined ? {} : { platform: deps.platform })
    : readArchiveFile(from);
}

async function makePassport(options: VetOptions, deps: VetDeps): Promise<Made> {
  try {
    if (options.online !== null) {
      const io = streamsOf(deps);
      let onlineSource;
      try {
        onlineSource = parseOnlineSource(options.online);
      } catch (err) {
        if (err instanceof SourceSyntaxError) {
          return { usage: err.message };
        }
        throw err;
      }
      const fetched = await fetchSourceTree(onlineSource, {
        ...(deps.transport ? { transport: deps.transport } : {}),
        onHost: (host) => io.err(`${host}\n`),
      });
      const context = {
        kind: options.kind,
        source: fetched.sourceRef,
        extraBlindSpots: fetched.blindSpots,
        stroqVersion: deps.stroqVersion ?? stroqVersion(),
        rulesId: INSPECT_RULES_ID,
      };
      const passport =
        deps.readings === undefined
          ? inspectTree(fetched.tree, context)
          : inspectWithReadings(fetched.tree, context, deps.readings);
      return { passport, tree: fetched.tree };
    }

    const from = options.from;
    const type = await sourceTypeOf(from);
    // A folder read on Windows has no executable bit, so its digest is not that of the same files anywhere
    // else, and a bare digest cannot say so. An archive carries its own bits and has no such trouble.
    if (
      type === 'dir' &&
      options.expect !== null &&
      (deps.platform ?? process.platform) === 'win32'
    ) {
      return { usage: EXPECT_ON_WINDOWS };
    }
    const { tree, blindSpots } = await readSource(type, from, deps);
    const context = {
      kind: options.kind,
      source: { type, label: labelOf(from, type) },
      extraBlindSpots: blindSpots,
      stroqVersion: deps.stroqVersion ?? stroqVersion(),
      rulesId: INSPECT_RULES_ID,
    };
    const passport =
      deps.readings === undefined
        ? inspectTree(tree, context)
        : inspectWithReadings(tree, context, deps.readings);
    return { passport, tree };
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
  if (options.from !== null && isInside(options.from, path)) io.err(INSIDE_NOTE);
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
  if (made.usage !== undefined) {
    io.err(usageError('vet', made.usage));
    return EXIT_USAGE;
  }
  if (made.failure !== undefined) {
    io.err(`stroq vet: ${outsideLine(made.failure)}\n`);
    return EXIT_UNREADABLE;
  }
  const { passport, tree } = made;
  let finalPassport = passport;

  if (options.expect !== null && options.expect !== passport.artifact.digest) {
    io.err(mismatchText(options.expect, passport.artifact.digest));
    return EXIT_UNCONFIRMED;
  }

  if (options.probe) {
    if (passport.artifact.kind !== 'mcp') {
      io.err(usageError('vet', '--probe is only supported for an MCP server'));
      return EXIT_USAGE;
    }
    if (passportIsIncomplete(passport)) {
      io.err(incompleteText(passport));
      return EXIT_UNCONFIRMED;
    }

    try {
      const probeResult = await probeMcpTree({
        tree,
        entrypoint: options.entrypoint,
        platform: deps.platform,
        srtBin: deps.srtBin,
        terminal: deps.terminal,
        confirm: deps.confirm,
        launcher: deps.launcher,
      });

      {
        const existingLines = new Map(
          passport.lines.map((l) => [`${l.kind}:${l.subject}:${l.basis}`, l]),
        );
        for (const line of probeResult.lines) {
          const key = `${line.kind}:${line.subject}:${line.basis}`;
          if (!existingLines.has(key)) {
            existingLines.set(key, line);
          }
        }
        const existingSignals = new Set(passport.signals.map((s) => `${s.ruleId}:${s.file}`));
        const newSignals = [...passport.signals];
        if (probeResult.status === 'declined')
          newSignals.push({ ruleId: 'reading-failed:mcp-probe', file: probeResult.entrypoint });
        for (const s of probeResult.signals) {
          const key = `${s.ruleId}:${s.file}`;
          if (!existingSignals.has(key)) {
            existingSignals.add(key);
            newSignals.push(s);
          }
        }
        const existingBlindSpots = new Set(passport.blindSpots);
        const newBlindSpots = [...passport.blindSpots];
        for (const b of probeResult.blindSpots) {
          if (!existingBlindSpots.has(b)) {
            existingBlindSpots.add(b);
            newBlindSpots.push(b);
          }
        }

        finalPassport = {
          ...passport,
          lines: [...existingLines.values()].sort(compareLines),
          signals: newSignals,
          blindSpots: newBlindSpots,
        };
      }
    } catch (err) {
      if (err instanceof McpProbeRefusalError) {
        io.err(`stroq vet: ${err.message}\n`);
        return EXIT_USAGE;
      }
      throw err;
    }
  }

  if (options.expect !== null && options.expect !== finalPassport.artifact.digest) {
    io.err(mismatchText(options.expect, finalPassport.artifact.digest));
    return EXIT_UNCONFIRMED;
  }
  // The text is made safe once more on its way out: the screen and the card already are, and the passport
  // is JSON that has no raw control in it, so this changes nothing a reader sees and keeps a file clean.
  const text = neutralizeControls(textOf(finalPassport, options));
  const written = options.out === null ? show(text, io) : writeNew(options, options.out, text, io);
  if (written !== 0) return written;
  if (!passportIsIncomplete(finalPassport)) return 0;
  io.err(incompleteText(finalPassport));
  return EXIT_UNCONFIRMED;
}
