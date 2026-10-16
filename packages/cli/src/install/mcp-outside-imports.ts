import { outsideLine } from '../ui/layout.js';
import {
  CONCERN_PHRASES,
  hasOutsideImports,
  outsideImportsOfTree,
  type OutsideImports,
} from './inspect/imports.js';
import type { Tree } from './types.js';

/** The most package names the refusal spells out; the rest are counted. */
const NAMES_SHOWN = 5;

const quoted = (text: string): string => outsideLine(JSON.stringify(text));

function reasonsOf(found: OutsideImports): string[] {
  const reasons: string[] = [];
  if (found.declared.length > 0) reasons.push(`package.json lists ${found.declared.join(', ')}`);
  if (found.modules.length > 0) {
    const shown = found.modules.slice(0, NAMES_SHOWN).map(quoted);
    const rest = found.modules.length - shown.length;
    reasons.push(
      `the sources import ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''} by name`,
    );
  }
  for (const { concern, files } of found.concerns)
    reasons.push(`${files.map(quoted).join(', ')}: ${CONCERN_PHRASES[concern]}`);
  return reasons;
}

/**
 * Refuses a server whose tree may not hold everything it loads. The pin hashes the files and runs a
 * private copy of them, but Node finds a package it is asked for by name in folders above the copy, and
 * no digest covers those. A server is pinnable when it is one file, or its dependencies are copied into
 * the tree and asked for by a relative path. The check is a best-effort reading of the text: what it
 * cannot read with certainty it refuses, and what it passes is not a proof that nothing escapes.
 */
export function assertSelfContained(tree: Tree): void {
  const found = outsideImportsOfTree(tree);
  if (!hasOutsideImports(found)) return;
  throw new Error(
    `this server may need code that is not in its tree (${reasonsOf(found).join('; ')}), and the pin cannot hold it: ` +
      'Node finds a package by name in folders that no digest covers. ' +
      'To add it, bundle the server into one self-contained file or vendor its dependencies inside the tree ' +
      '(copy them in and import them by relative path, with no createRequire, eval or computed module name), then run add again. ' +
      'The check is a best-effort reading of the text; the pin is tamper-evident, not tamper-proof',
  );
}
