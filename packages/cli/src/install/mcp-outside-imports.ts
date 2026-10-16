import { outsideLine } from '../ui/layout.js';
import { hasOutsideImports, outsideImportsOfTree } from './inspect/imports.js';
import type { Tree } from './types.js';

/** The most package names the refusal spells out; the rest are counted. */
const NAMES_SHOWN = 5;

/**
 * Refuses a server whose tree does not hold everything it loads. The pin hashes the files and runs a
 * private copy of them, but Node finds a package it is asked for by name in folders above the copy, and
 * no digest covers those. A server is pinnable when it is one file, or its dependencies are copied into
 * the tree and asked for by a relative path.
 */
export function assertSelfContained(tree: Tree): void {
  const found = outsideImportsOfTree(tree);
  if (!hasOutsideImports(found)) return;
  const reasons: string[] = [];
  if (found.declared.length > 0) reasons.push(`package.json lists ${found.declared.join(', ')}`);
  if (found.modules.length > 0) {
    const shown = found.modules
      .slice(0, NAMES_SHOWN)
      .map((name) => outsideLine(JSON.stringify(name)));
    const rest = found.modules.length - shown.length;
    reasons.push(
      `the sources import ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''} by name`,
    );
  }
  throw new Error(
    `this server needs packages that are not in its tree (${reasons.join('; ')}), and the pin cannot hold them: ` +
      'Node finds a package by name in folders that no digest covers. ' +
      'To add it, bundle the server into one self-contained file or vendor its dependencies inside the tree ' +
      '(copy them in and import them by relative path), then run add again',
  );
}
