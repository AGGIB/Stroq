import { symlinkSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadDirError, readDirTree, type ReadDirErrorCode } from '../../src/install/read-dir.js';
import { removeTempRoots, tempRoot, writeFiles } from '../helpers/install-dir.js';

// The reader lists a folder, then looks at each name, then opens it. The gap between those steps is
// where a name can change under it, and the tests below make it change by wrapping the calls of
// `node:fs/promises` that sit on either side of the gap.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

afterEach(() => {
  vi.mocked(fsPromises.lstat).mockReset();
  vi.mocked(fsPromises.open).mockReset();
  removeTempRoots();
});

let real: typeof import('node:fs/promises');
beforeEach(async () => {
  real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fsPromises.lstat).mockImplementation(real.lstat as never);
  vi.mocked(fsPromises.open).mockImplementation(real.open as never);
});

const isWindows = process.platform === 'win32';

async function codeOf(run: () => Promise<unknown>): Promise<ReadDirErrorCode> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ReadDirError) return error.code;
    throw error;
  }
  throw new Error('expected a ReadDirError, and nothing was thrown');
}

/** A descriptor that answers as a test says, for the calls the reader makes on one. */
function fakeHandle(options: {
  readonly isFile?: boolean;
  readonly size: number;
  readonly reads: readonly number[];
}) {
  let call = 0;
  return {
    stat: async () => ({
      isFile: () => options.isFile ?? true,
      size: BigInt(options.size),
      mode: 0o644n,
      ino: 0n,
      dev: 0n,
    }),
    read: async (buffer: Uint8Array) => {
      const bytesRead = options.reads[call] ?? 0;
      call += 1;
      buffer.fill(97, 0, bytesRead);
      return { bytesRead, buffer };
    },
    close: async () => undefined,
  };
}

const asHandle = (fake: ReturnType<typeof fakeHandle>) =>
  fake as unknown as Awaited<ReturnType<typeof fsPromises.open>>;

describe('readDirTree: a name that changes between the listing and the open', () => {
  it('says vanished for a file removed before it is looked at', async () => {
    const root = tempRoot();
    writeFiles(root, { 'gone.txt': 'x' });
    // The root is looked at first, and without `bigint`; only the file is removed.
    vi.mocked(fsPromises.lstat).mockImplementation((async (
      path: string,
      options?: { bigint?: boolean },
    ) => {
      if (options?.bigint === true) await real.rm(path);
      return real.lstat(path, options as never);
    }) as never);

    expect(await codeOf(() => readDirTree(root))).toBe('vanished');
  });

  it('says vanished for a file removed after it was looked at and before it is opened', async () => {
    const root = tempRoot();
    writeFiles(root, { 'gone.txt': 'x' });
    vi.mocked(fsPromises.open).mockImplementationOnce(async (path, flags) => {
      await real.rm(path);
      return real.open(path, flags);
    });

    expect(await codeOf(() => readDirTree(root))).toBe('vanished');
  });

  it.skipIf(isWindows)(
    'says changed for a file replaced by a link before it is opened',
    async () => {
      const root = tempRoot();
      writeFiles(root, { 'swap.txt': 'x', 'other.txt': 'o' });
      vi.mocked(fsPromises.open).mockImplementationOnce(async (path, flags) => {
        await real.rm(path);
        symlinkSync(join(root, 'other.txt'), String(path));
        return real.open(path, flags);
      });

      expect(await codeOf(() => readDirTree(root))).toBe('changed');
    },
  );

  it('says changed for something that is not a regular file once it is open', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'abc' });
    vi.mocked(fsPromises.open).mockImplementationOnce(async () =>
      asHandle(fakeHandle({ isFile: false, size: 3, reads: [] })),
    );

    expect(await codeOf(() => readDirTree(root))).toBe('changed');
  });

  it('says changed for a file that is shorter than it said it was', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'abc' });
    vi.mocked(fsPromises.open).mockImplementationOnce(async () =>
      asHandle(fakeHandle({ size: 3, reads: [2, 0] })),
    );

    expect(await codeOf(() => readDirTree(root))).toBe('changed');
  });

  it('says changed for a file that has more in it than it said, and never reads past its size', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'abc' });
    vi.mocked(fsPromises.open).mockImplementationOnce(async () =>
      asHandle(fakeHandle({ size: 3, reads: [3, 1] })),
    );

    expect(await codeOf(() => readDirTree(root))).toBe('changed');
  });

  it('closes the descriptor of a file it refuses', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'abc' });
    const close = vi.fn(async () => undefined);
    const handle = { ...fakeHandle({ isFile: false, size: 3, reads: [] }), close };
    vi.mocked(fsPromises.open).mockImplementationOnce(async () => asHandle(handle as never));

    await codeOf(() => readDirTree(root));

    expect(close).toHaveBeenCalledTimes(1);
  });
});
