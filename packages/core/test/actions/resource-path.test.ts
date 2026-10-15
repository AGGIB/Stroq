import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResourcePathResolver,
  resolveResourcePath,
} from '../../src/actions/resource-path.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync), readlinkSync: vi.fn(fs.readlinkSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resource path cache for one list of targets', () => {
  it('does no further filesystem work for siblings below an absent parent', () => {
    const root = fixture();
    const resolve = createResourcePathResolver();
    const native = vi.spyOn(realpathSync, 'native');
    vi.mocked(lstatSync).mockClear();
    expect(resolve(join(root, 'missing', 'nested', 'first.txt'))).toBe(
      join(root, 'missing', 'nested', 'first.txt'),
    );
    const firstCalls = vi.mocked(lstatSync).mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);
    for (let i = 0; i < 100; i += 1) {
      expect(resolve(join(root, 'missing', 'nested', `${i}.txt`))).toBe(
        join(root, 'missing', 'nested', `${i}.txt`),
      );
    }
    expect(lstatSync).toHaveBeenCalledTimes(firstCalls);
    expect(native).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'reuses a linked prefix for distinct missing files',
    () => {
      const root = fixture();
      mkdirSync(join(root, 'outside'));
      const link = join(root, 'link');
      symlinkSync('outside', link);
      const resolve = createResourcePathResolver();
      vi.mocked(lstatSync).mockClear();
      vi.mocked(readlinkSync).mockClear();
      for (let i = 0; i < 10; i += 1) {
        expect(resolve(join(link, `${i}.txt`))).toBe(join(root, 'outside', `${i}.txt`));
      }
      expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === link)).toHaveLength(1);
      expect(readlinkSync).toHaveBeenCalledTimes(1);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'leaves a cached missing subtree after parent steps',
    () => {
      const root = fixture();
      mkdirSync(join(root, 'outside'));
      symlinkSync('outside', join(root, 'link'));
      const resolve = createResourcePathResolver();
      resolve(join(root, 'missing', 'nested', 'first.txt'));
      expect(resolve(`${root}/missing/nested/../../link/new.txt`)).toBe(
        join(root, 'outside', 'new.txt'),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a fresh resolver sees a previously missing symlink',
    () => {
      const root = fixture();
      mkdirSync(join(root, 'outside'));
      const path = join(root, 'missing', 'file.txt');
      expect(createResourcePathResolver()(path)).toBe(path);
      symlinkSync('outside', join(root, 'missing'));
      expect(createResourcePathResolver()(path)).toBe(join(root, 'outside', 'file.txt'));
      expect(resolveResourcePath(path)).toBe(join(root, 'outside', 'file.txt'));
    },
  );

  it.skipIf(process.platform === 'win32')('a fresh resolver observes a retargeted symlink', () => {
    const root = fixture();
    mkdirSync(join(root, 'first'));
    mkdirSync(join(root, 'second'));
    const link = join(root, 'link');
    symlinkSync('first', link);
    const path = join(link, 'new.txt');
    expect(resolveResourcePath(path)).toBe(join(root, 'first', 'new.txt'));
    unlinkSync(link);
    symlinkSync('second', link);
    expect(resolveResourcePath(path)).toBe(join(root, 'second', 'new.txt'));
  });
});

function fixture(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stroq-resource-path-')));
  roots.push(root);
  return root;
}

describe('resource path resolution', () => {
  it('distinguishes a known plain path from a failed resolution', () => {
    const root = fixture();
    const file = join(root, 'present.txt');
    writeFileSync(file, 'inert');
    expect(resolveResourcePath(file)).toBe(file);
    expect(resolveResourcePath(join(file, 'child.txt'))).toBeNull();
  });

  it('resolves missing parents to the same target that creating them later produces', () => {
    const root = fixture();
    const path = join(root, 'missing', 'nested', 'file.txt');
    const resolved = resolveResourcePath(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'inert');
    expect(resolved).toBe(realpathSync.native(path));
  });

  it('does not claim a destination when the component budget is exhausted', () => {
    const root = fixture();
    expect(resolveResourcePath(`${root}/${'missing/'.repeat(300)}file.txt`)).toBeNull();
  });

  it('rejects relative names and invalid filesystem paths', () => {
    const root = fixture();
    expect(resolveResourcePath('relative/file.txt')).toBeNull();
    expect(resolveResourcePath(`${root}/invalid\0name`)).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('resource paths through relative symlinks', () => {
  it('follows a relative target before applying the caller parent step', () => {
    const root = fixture();
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(project);
    mkdirSync(join(outside, 'child'), { recursive: true });
    symlinkSync('../outside/child', join(project, 'link'));
    const raw = `${project}/link/../missing/file.txt`;
    const resolved = resolveResourcePath(raw);
    mkdirSync(join(outside, 'missing'));
    writeFileSync(join(outside, 'missing', 'file.txt'), 'inert');
    expect(resolved).toBe(join(outside, 'missing', 'file.txt'));
    expect(resolved).toBe(realpathSync.native(raw));
  });

  it('does not collapse a parent step inside a relative target before another link', () => {
    const root = fixture();
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(project);
    mkdirSync(join(outside, 'child'), { recursive: true });
    symlinkSync('../outside/child', join(project, 'pivot'));
    symlinkSync('pivot/../new', join(project, 'link'));
    const raw = `${project}/link/file.txt`;
    const resolved = resolveResourcePath(raw);
    mkdirSync(join(outside, 'new'));
    writeFileSync(join(outside, 'new', 'file.txt'), 'inert');
    expect(resolved).toBe(join(outside, 'new', 'file.txt'));
    expect(resolved).toBe(realpathSync.native(raw));
  });

  it('continues inspecting existing ancestors after missing parents and parent steps', () => {
    const root = fixture();
    mkdirSync(join(root, 'outside'));
    symlinkSync('outside', join(root, 'link'));
    const raw = `${root}/missing/../link/file.txt`;
    expect(resolveResourcePath(raw)).toBe(join(root, 'outside', 'file.txt'));
  });

  it('refuses a chain exceeding the link budget, including a missing destination', () => {
    const root = fixture();
    for (let i = 0; i < 45; i += 1) {
      symlinkSync(i === 44 ? 'missing' : `link-${i + 1}`, join(root, `link-${i}`));
    }
    expect(resolveResourcePath(join(root, 'link-0', 'file.txt'))).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'resource path filesystem errors',
  () => {
    it('does not mistake an inaccessible parent for one that may be created', () => {
      const root = fixture();
      const privateDir = join(root, 'private');
      mkdirSync(privateDir);
      chmodSync(privateDir, 0o000);
      try {
        expect(resolveResourcePath(join(privateDir, 'missing.txt'))).toBeNull();
      } finally {
        chmodSync(privateDir, 0o700);
      }
    });
  },
);
