import { lineText } from '../commands/vet-text.js';
import {
  CONCERN_PHRASES,
  hasOutsideImports,
  outsideImportsOfTree,
  type OutsideImports,
} from './inspect/imports.js';
import type { Tree } from './types.js';

/** The most package names the refusal spells out; the rest are counted. */
const NAMES_SHOWN = 5;
/** The longest name or path written out in full. */
const NAME_MAX = 80;

/** Text from the server, written out and quoted: it cannot act on a terminal. */
const quoted = (text: string): string => `"${lineText(text, NAME_MAX)}"`;

/** One line for each thing found, in words, for a person. */
function findingsOf(found: OutsideImports): string[] {
  const lines: string[] = [];
  if (found.declared.length > 0) lines.push(`package.json lists ${found.declared.join(', ')}`);
  if (found.modules.length > 0) {
    const shown = found.modules.slice(0, NAMES_SHOWN).map(quoted);
    const rest = found.modules.length - shown.length;
    lines.push(
      `the sources import ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''} by name`,
    );
  }
  for (const { concern, details } of found.concerns) {
    for (const { path, reason, line } of details) {
      const where = `${quoted(path)}${line === undefined ? '' : ` line ${line}`}`;
      lines.push(`${where}: ${reason ?? CONCERN_PHRASES[concern]}`);
    }
  }
  return lines;
}

/**
 * Refuses a server whose tree may not hold everything it loads. The pin hashes the files and runs a
 * private copy of them, but Node finds a package it is asked for by name in folders above the copy, and
 * no digest covers those. A server is pinnable when it is one file, or its dependencies are copied into
 * the tree and asked for by a relative path.
 *
 * The check is a best-effort reading of the text: what it cannot read with certainty it refuses, and what it
 * passes is not a proof that nothing escapes. The message says what was found and where, names the usual
 * causes, and says how to produce a server that passes.
 */
export function assertSelfContained(tree: Tree): void {
  const found = outsideImportsOfTree(tree);
  if (!hasOutsideImports(found)) return;
  throw new Error(
    [
      'this server may need code that is not in its tree, and the pin cannot hold it, because Node finds a package by name in folders that no digest covers:',
      ...findingsOf(found).map((line) => `  - ${line}`),
      'To add it, bundle the server into one self-contained file or vendor its dependencies inside the tree (copy them in and import them by relative path), then run add again. For example: esbuild --bundle --platform=node --format=cjs --outfile=server.js src/index.js. Remove "dependencies" from the package.json you add (a bundle needs none).',
      'The usual causes of a refusal for a bundle: minified code that the reader cannot parse with certainty, the __require shim that esbuild --format=esm adds (use --format=cjs), createRequire, eval or new Function.',
      'The check is a best-effort reading of the text, not a proof; the pin is tamper-evident, not tamper-proof.',
    ].join('\n'),
  );
}
