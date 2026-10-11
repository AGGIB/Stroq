import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { resourcesOfFileTool } from '../../src/actions/resources.js';

let root: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stroq-resources-ls-')));
  cwd = join(root, 'project');
  mkdirSync(join(cwd, 'src'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function resources(input: Readonly<Record<string, unknown>>, base = cwd) {
  const { resources: result, ...classification } = classifyTool('LS', input, base);
  expect(classification).toEqual({ classes: [], hosts: [], signals: [] });
  expect(result).toEqual(resourcesOfFileTool('LS', input, base));
  return result;
}

describe('LS directory resources', () => {
  it('reads cwd when no directory is named', () => {
    expect(resources({})).toEqual({
      paths: [{ path: cwd, op: 'read' }],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });

  it.each(['path', 'directory', 'root', 'paths', 'files'])(
    'resolves a relative directory under %s',
    (field) => {
      const value = field === 'paths' || field === 'files' ? ['src'] : 'src';
      expect(resources({ [field]: value })).toMatchObject({
        paths: [{ path: join(cwd, 'src'), op: 'read' }],
        pathsComplete: true,
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'includes the outside target of a linked directory',
    () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync('../outside', join(cwd, 'linked'));
      expect(resources({ path: 'linked' })).toMatchObject({
        paths: [{ path: join(cwd, 'linked'), real: outside, op: 'read' }],
        pathsComplete: true,
      });
    },
  );

  it.each([5, false, {}, [], ['src']].map((path) => ({ path })))(
    'does not claim a malformed path is known: $path',
    ({ path }) => {
      expect(resources({ path })).toMatchObject({ paths: [], pathsComplete: false });
    },
  );

  it('does not hide an invalid alias behind a valid directory', () => {
    expect(resources({ path: 'src', paths: [5] })).toMatchObject({
      paths: [{ path: join(cwd, 'src'), op: 'read' }],
      pathsComplete: false,
    });
  });

  it('cannot infer the default directory from an absent cwd', () => {
    expect(resources({}, '')?.pathsComplete).toBe(false);
  });

  it('keeps legacy classification empty even for a protected directory', () => {
    const path = join(cwd, '.ssh');
    mkdirSync(path);
    expect(resources({ path })?.paths).toEqual([{ path, op: 'read' }]);
  });

  it('does not throw when the argument itself is malformed', () => {
    expect(resources(null as never)).toEqual({
      paths: [],
      pathsComplete: false,
      urls: [],
      shell: false,
    });
  });
});
