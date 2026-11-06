// What a folder holds that is worth a question: what git runs from it, and the strong signals of its code.
//
// Kept apart from `folder-check.ts`, which every hook call that triggers nothing loads: these readers
// are loaded only when a folder is really read.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { readProjectCode } from './exposure/project-code.js';
import { folderSurface, repoSurface } from './exposure/repo-surface.js';
import { READ_CAP_BYTES } from './install/inspect/blind-spots.js';
import { showable } from './install/inspect/safe-text.js';

const PATH_SHOWN = 120;
/** The most places remembered of one folder: past this, what is new is judged against these. */
const MAX_IDS = 500;
const ID_LENGTH = 16;

export interface FolderReading {
  /** The places to read first, made safe to print. They are for a person's terminal and never for a model. */
  readonly labels: readonly string[];
  /** One id for each place, from what it is and what its file holds: a change to the file is a new place. */
  readonly ids: readonly string[];
  /** What the reading of the code did not reach. */
  readonly notRead: readonly string[];
}

const idOf = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, ID_LENGTH);

/** What a file holds, or nothing for one that is not a file or cannot be read. */
function contentOf(path: string): string {
  try {
    const read = readRegularFile(path, READ_CAP_BYTES, { noFollow: true });
    return read.kind === 'text' ? read.text : '';
  } catch {
    return '';
  }
}

/** Reads a folder, the top of a repository or a folder in none, for what is worth a question. */
export function readFolder(top: string, budgetMs?: number): FolderReading {
  const inRepo = repoSurface(top);
  // A folder that came out of an archive has no `.git`, and is the case this is for.
  const surface = inRepo.isRepo ? inRepo : folderSurface(top);
  const reading = readProjectCode(top, budgetMs === undefined ? {} : { budgetMs });
  // Where a hook manager keeps its hooks is said by a key whose hooks were each judged on their own;
  // the key itself is what every project with husky has.
  const hits = surface.preTrust.filter(
    (hit) => !(hit.what.toLowerCase() === 'core.hookspath' && hit.hooksJudged === true),
  );
  const strong = reading.signals.filter((signal) => signal.strength === 'strong');
  const labels = [
    ...hits.map((hit) => showable(hit.file, PATH_SHOWN)),
    ...strong.map((s) => `${showable(s.file, PATH_SHOWN)}${s.line === null ? '' : `:${s.line}`}`),
  ];
  const ids = new Set([
    ...hits.map((hit) => idOf(hit.kind, hit.file, hit.what, contentOf(resolve(top, hit.file)))),
    ...strong.map((s) => idOf(s.kind, s.file, s.pin)),
  ]);
  return { labels, ids: [...ids].sort().slice(0, MAX_IDS), notRead: reading.notRead };
}
