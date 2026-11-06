// What a folder holds that is worth a question: what git runs from it, and the strong signals of its code.
//
// Kept apart from `folder-check.ts`, which every hook call that triggers nothing loads: these readers
// are loaded only when a folder is really read.
import { createHash } from 'node:crypto';
import { readProjectCode } from './exposure/project-code.js';
import { repoSurface } from './exposure/repo-surface.js';
import { showable } from './install/inspect/safe-text.js';

const PATH_SAID = 120;

export interface FolderReading {
  /** The places to read first, made safe to print. */
  readonly places: readonly string[];
  /** A digest of them, which is what a marker and a trusted folder hold. */
  readonly found: string;
}

/** Reads a folder, the top of a repository, for what is worth a question. */
export function readFolder(top: string, budgetMs?: number): FolderReading {
  const surface = repoSurface(top);
  const reading = readProjectCode(top, budgetMs === undefined ? {} : { budgetMs });
  // Where a hook manager keeps its hooks is said by a key whose hooks were each judged on their own;
  // the key itself is what every project with husky has.
  const hits = surface.preTrust.filter(
    (hit) => !(hit.what.toLowerCase() === 'core.hookspath' && hit.hooksJudged === true),
  );
  const places = [
    ...hits.map((hit) => showable(hit.file, PATH_SAID)),
    ...reading.signals
      .filter((signal) => signal.strength === 'strong')
      .map((s) => `${showable(s.file, PATH_SAID)}${s.line === null ? '' : `:${s.line}`}`),
  ];
  const found = createHash('sha256')
    .update([...places].sort().join('\n'))
    .digest('hex');
  return { places, found };
}
