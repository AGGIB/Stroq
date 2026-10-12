import { ReadDirError, readDirTree } from '../../src/install/read-dir.js';

/**
 * Run by `read-dir-hostile.test.ts` in a child process, never in the test runner: it points the
 * directory reader at a folder with a FIFO in it, which blocks forever for a reader that opens it
 * plainly. If the reader does, the parent's timeout kills this process and the test fails, where
 * inside the runner the same mistake would hang it.
 *
 * Prints one line of JSON: the paths and blind spots of the tree, or the code of the refusal.
 */
const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: read-dir-child <dir>');

try {
  const { tree, blindSpots } = await readDirTree(dir);
  process.stdout.write(
    JSON.stringify({ paths: tree.entries.map((entry) => entry.path), blindSpots }),
  );
} catch (error) {
  if (!(error instanceof ReadDirError)) throw error;
  process.stdout.write(JSON.stringify({ refused: error.code, message: error.message }));
}
