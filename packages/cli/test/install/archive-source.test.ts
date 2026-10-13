import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the archive reader may touch, held by looking at what its files import. An archive is somebody
 * else's bytes: the reader of them works in memory, so that nothing in an archive can be written to a disk
 * or run by this code, whatever a path in it says. The only file that goes to the disk is the one that
 * opens the archive file itself, and it only reads. Nothing in any of them reaches the network, starts a
 * process or loads code.
 */
const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/install/${name}`, import.meta.url)), 'utf8');

const importsOf = (name: string): string[] =>
  [...source(name).matchAll(/^(?:import|export) .*?from '(.*?)';$/gms)].map(
    (match) => match[1] ?? '',
  );

/** The files that turn bytes into a tree: none of them may use the file system. */
const IN_MEMORY = [
  'archive-error.ts',
  'archive-gzip.ts',
  'archive-tar.ts',
  'archive-tree.ts',
  'tar-header.ts',
  'tar-number.ts',
  'tar-pax.ts',
];
const FORBIDDEN =
  /^(?:node:)?(?:fs|fs\/promises|child_process|net|http|https|dgram|dns|tls|vm|worker_threads|module)$/;

describe('the files that read an archive in memory', () => {
  it.each(IN_MEMORY)('%s imports nothing that reaches a disk, a process or the network', (name) => {
    const forbidden = importsOf(name).filter((from) => FORBIDDEN.test(from));

    expect(forbidden).toEqual([]);
    expect(source(name)).not.toMatch(
      /\b(?:eval|Function)\s*\(|\bfetch\s*\(|\bprocess\.(?:binding|dlopen)\b/,
    );
  });

  it('import only zlib, other files of the reader and the tree', () => {
    const outside = IN_MEMORY.flatMap((name) => importsOf(name)).filter(
      (from) => !from.startsWith('./'),
    );

    expect([...new Set(outside)].sort()).toEqual(['node:zlib']);
  });

  it('are the whole of the reader but for the file that opens the file and the one that looks at a path', () => {
    const disk = ['archive-file.ts', 'read-source.ts'];

    for (const name of disk) {
      const outside = importsOf(name).filter((from) => !from.startsWith('./'));
      expect(
        outside.every((from) => from === 'node:fs' || from === 'node:fs/promises'),
        name,
      ).toBe(true);
    }
    // And what they do to the disk is to open for reading, and to look.
    expect(source('archive-file.ts')).not.toMatch(
      /\b(?:writeFile|appendFile|mkdir|rm|unlink|rename|chmod|symlink|createWriteStream)\b/,
    );
    expect(source('read-source.ts')).not.toMatch(
      /\b(?:open|writeFile|mkdir|rm|unlink|rename|chmod)\s*\(/,
    );
  });

  it('use no regular expression on text that comes out of an archive, so that none can run long on it', () => {
    // The names go through the path rules, which have their own gate (safe-path-redos-gate.test.ts); the
    // reader itself reads bytes by position.
    for (const name of [
      'archive-tar.ts',
      'archive-tree.ts',
      'tar-header.ts',
      'tar-number.ts',
      'tar-pax.ts',
    ]) {
      expect(source(name), name).not.toMatch(
        /\.(?:match|matchAll|exec|test|replace|replaceAll|search)\(|RegExp/,
      );
    }
  });
});
