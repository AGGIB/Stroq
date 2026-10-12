// What the inspectors are handed: the tree, and its text files by path.
import type { Tree } from '../types.js';
import type { Findings } from './findings.js';
import { loadTexts, type TextFile } from './text-files.js';

export interface InspectInput {
  readonly tree: Tree;
  /** The path of every entry, whatever its kind and whether or not it could be read as text. */
  readonly paths: ReadonlySet<string>;
  /** The files that are UTF-8 text, in the order of the tree. */
  readonly texts: readonly TextFile[];
  readonly byPath: ReadonlyMap<string, TextFile>;
}

export function buildInput(tree: Tree, findings: Findings): InspectInput {
  const texts = loadTexts(tree, findings);
  return {
    tree,
    paths: new Set(tree.entries.map((entry) => entry.path)),
    texts,
    byPath: new Map(texts.map((file) => [file.path, file])),
  };
}
