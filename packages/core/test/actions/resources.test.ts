import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_URL_CHARS } from '../../src/actions/classify-bash.js';
import {
  MAX_RESOURCE_PATHS,
  resourcesOfFileTool,
  resourcesOfMcp,
  resourcesOfWebFetch,
  type ScannedPath,
} from '../../src/actions/resources.js';

const POSIX = process.platform !== 'win32';

/**
 * A scratch tree under the real temp directory (never the real home): `proj` is the working
 * directory, `outside` is a sibling a link can lead to. The temp directory is resolved first so
 * that a path with no link in it has nothing to resolve (macOS keeps /var behind /private/var).
 */
let root: string;
let cwd: string;

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stroq-resources-')));
  cwd = join(root, 'proj');
  mkdirSync(cwd);
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(cwd, 'real.txt'), 'inert');
  writeFileSync(join(root, 'outside', 'secret.txt'), 'inert');
  if (POSIX) {
    symlinkSync(join(root, 'outside', 'secret.txt'), join(cwd, 'link.txt'));
    symlinkSync(join(root, 'outside'), join(cwd, 'linkdir'));
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What a call that names no path and no address looks like once it is read in full. */
const UNKNOWN = { paths: [], pathsComplete: false, urls: [], shell: false } as const;

describe('resourcesOfFileTool: one named file', () => {
  it.each([
    ['Read', 'read'],
    ['Write', 'write'],
    ['Edit', 'write'],
    ['MultiEdit', 'write'],
  ] as const)('%s names its file_path as a %s', (tool, op) => {
    const path = join(cwd, 'src', 'a.ts');
    expect(resourcesOfFileTool(tool, { file_path: path }, cwd)).toEqual({
      paths: [{ path, op }],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });

  it('reads the notebook_path of NotebookEdit as a write', () => {
    const path = join(cwd, 'analysis.ipynb');
    expect(
      resourcesOfFileTool('NotebookEdit', { notebook_path: path, new_source: 'x' }, cwd),
    ).toEqual({
      paths: [{ path, op: 'write' }],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });

  it('resolves a relative path against the working directory', () => {
    expect(resourcesOfFileTool('Read', { file_path: 'src/a.ts' }, cwd).paths).toEqual([
      { path: join(cwd, 'src', 'a.ts'), op: 'read' },
    ]);
  });

  it('normalises dots and doubled separators, lexically', () => {
    expect(resourcesOfFileTool('Write', { file_path: 'src/../lib//./a.ts' }, cwd).paths).toEqual([
      { path: join(cwd, 'lib', 'a.ts'), op: 'write' },
    ]);
  });

  it('keeps a path that climbs out of the working directory as the place it is', () => {
    expect(resourcesOfFileTool('Read', { file_path: '../outside/x.txt' }, cwd).paths).toEqual([
      { path: join(root, 'outside', 'x.txt'), op: 'read' },
    ]);
  });

  it('is not complete for a relative path when there is no working directory to resolve it in', () => {
    // An adapter that had no cwd: the path would be read against the hook's own directory.
    expect(resourcesOfFileTool('Read', { file_path: 'a.txt' }, '').pathsComplete).toBe(false);
    expect(resourcesOfFileTool('Grep', { pattern: 'x' }, '').pathsComplete).toBe(false);
    expect(resourcesOfFileTool('Read', { file_path: join(cwd, 'a.txt') }, '').pathsComplete).toBe(
      true,
    );
  });

  it('does not fold case: a case-sensitive filesystem has two files there', () => {
    expect(resourcesOfFileTool('Read', { file_path: 'Src/Main.TS' }, cwd).paths).toEqual([
      { path: join(cwd, 'Src', 'Main.TS'), op: 'read' },
    ]);
  });

  it('does not expand ~: it is listed as written, unresolved, and the list says it is not complete', () => {
    const result = resourcesOfFileTool('Read', { file_path: '~/notes/todo.txt' }, cwd);
    // Whether the tool opens the home directory or a directory named `~` is the tool's
    // business. Joined to the working directory it would sit inside a project scope, and
    // expanded here it would be a guess about a home Stroq was never told.
    expect(result.paths).toEqual([{ path: '~/notes/todo.txt', op: 'read' }]);
    expect(result.paths[0]?.path.startsWith(homedir())).toBe(false);
    expect(result.pathsComplete).toBe(false);
  });

  it.each([
    ['no field', {}],
    ['a number', { file_path: 5 }],
    ['a list', { file_path: ['a.txt'] }],
    ['an object', { file_path: { path: 'a.txt' } }],
    ['null', { file_path: null }],
    ['an empty string', { file_path: '' }],
    ['a path with a NUL byte', { file_path: 'a\0b' }],
  ] as const)('says the paths are not complete for %s', (_name, toolInput) => {
    expect(resourcesOfFileTool('Read', toolInput, cwd)).toEqual(UNKNOWN);
  });

  it('does not list a path longer than a filesystem takes, and says so', () => {
    expect(resourcesOfFileTool('Write', { file_path: `/${'a'.repeat(100_000)}` }, cwd)).toEqual(
      UNKNOWN,
    );
  });

  it('lists every field that could name the file when they disagree', () => {
    const a = join(cwd, 'a.txt');
    const b = join(cwd, 'b.txt');
    expect(
      resourcesOfFileTool('Write', { file_path: a, path: b, content: 'x' }, cwd).paths,
    ).toEqual([
      { path: a, op: 'write' },
      { path: b, op: 'write' },
    ]);
    expect(resourcesOfFileTool('Write', { file_path: a, path: a }, cwd).paths).toHaveLength(1);
  });

  it.skipIf(!POSIX)('gives the real place a link leads to, when it leaves the project', () => {
    const result = resourcesOfFileTool('Read', { file_path: 'link.txt' }, cwd);
    expect(result.paths).toEqual([
      { path: join(cwd, 'link.txt'), real: join(root, 'outside', 'secret.txt'), op: 'read' },
    ]);
  });

  it.skipIf(!POSIX)('gives the real place for a new file made inside a linked directory', () => {
    const result = resourcesOfFileTool('Write', { file_path: 'linkdir/new.txt' }, cwd);
    expect(result.paths).toEqual([
      {
        path: join(cwd, 'linkdir', 'new.txt'),
        real: join(root, 'outside', 'new.txt'),
        op: 'write',
      },
    ]);
  });

  it('gives no real place for a file that is where it says, or does not exist', () => {
    for (const file of ['real.txt', 'nothing-here.txt']) {
      const [entry] = resourcesOfFileTool('Read', { file_path: file }, cwd).paths;
      expect(entry?.real, file).toBeUndefined();
    }
  });

  it('is not given an object as the input: it does not throw, it says it knows nothing', () => {
    for (const bad of [null, undefined, 5, 'Read', []]) {
      expect(resourcesOfFileTool('Read', bad as never, cwd)).toEqual(UNKNOWN);
    }
  });

  it('knows no other tool: it says it knows nothing', () => {
    expect(resourcesOfFileTool('TodoWrite', { file_path: 'a.txt' }, cwd)).toEqual(UNKNOWN);
  });

  it('does not change the input it is given', () => {
    const input = Object.freeze({ file_path: Object.freeze(['a']) as unknown });
    expect(() => resourcesOfFileTool('Read', input, cwd)).not.toThrow();
  });
});

describe('resourcesOfFileTool: Grep', () => {
  it('reads the path it searches', () => {
    const path = join(cwd, 'src');
    expect(resourcesOfFileTool('Grep', { pattern: 'x', path }, cwd)).toEqual({
      paths: [{ path, op: 'read' }],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });

  it('searches the working directory when no path is named', () => {
    for (const toolInput of [{ pattern: 'x' }, { pattern: 'x', path: '' }, { path: null }]) {
      expect(resourcesOfFileTool('Grep', toolInput, cwd).paths).toEqual([
        { path: cwd, op: 'read' },
      ]);
    }
  });

  it('resolves a relative path against the working directory', () => {
    expect(resourcesOfFileTool('Grep', { pattern: 'x', path: 'src' }, cwd).paths).toEqual([
      { path: join(cwd, 'src'), op: 'read' },
    ]);
  });

  it.each([5, ['src'], { a: 1 }, true])('is not complete when the path is %j', (path) => {
    expect(resourcesOfFileTool('Grep', { pattern: 'x', path }, cwd)).toEqual(UNKNOWN);
  });

  it.skipIf(!POSIX)('gives the real place of a linked directory', () => {
    expect(resourcesOfFileTool('Grep', { pattern: 'x', path: 'linkdir' }, cwd).paths).toEqual([
      { path: join(cwd, 'linkdir'), real: join(root, 'outside'), op: 'read' },
    ]);
  });
});

describe('resourcesOfFileTool: Glob', () => {
  it('reads the working directory for a pattern with no path', () => {
    expect(resourcesOfFileTool('Glob', { pattern: '**/*.ts' }, cwd)).toEqual({
      paths: [{ path: cwd, op: 'read' }],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });

  it('reads the path it is given', () => {
    expect(resourcesOfFileTool('Glob', { pattern: '*.ts', path: 'src' }, cwd).paths).toEqual([
      { path: join(cwd, 'src'), op: 'read' },
    ]);
  });

  it('adds the root of a pattern that is absolute', () => {
    const lib = join(root, 'outside', 'lib');
    const pattern = `${lib.split('\\').join('/')}/**/*.pem`;
    expect(resourcesOfFileTool('Glob', { pattern }, cwd).paths).toEqual([
      { path: lib, op: 'read' },
    ]);
    expect(resourcesOfFileTool('Glob', { pattern, path: 'src' }, cwd).paths).toEqual([
      { path: join(cwd, 'src'), op: 'read' },
      { path: lib, op: 'read' },
    ]);
  });

  it('takes the whole of an absolute pattern with no wildcard as the path it names', () => {
    const file = join(root, 'outside', 'secret.txt');
    expect(resourcesOfFileTool('Glob', { pattern: file.split('\\').join('/') }, cwd).paths).toEqual(
      [{ path: file, op: 'read' }],
    );
  });

  it('stops the root of a pattern before the first segment that holds a wildcard', () => {
    const base = join(root, 'outside').split('\\').join('/');
    for (const tail of ['a*/x', 'a?/x', '[ab]/x', '{a,b}/x', 'a/b*c', '+(a|b)/x', '*/x']) {
      const expected = tail.startsWith('a/') ? join(root, 'outside', 'a') : join(root, 'outside');
      expect(resourcesOfFileTool('Glob', { pattern: `${base}/${tail}` }, cwd).paths, tail).toEqual([
        { path: expected, op: 'read' },
      ]);
    }
  });

  it('adds where a relative pattern climbs to, because it leaves the path it was given', () => {
    const result = resourcesOfFileTool(
      'Glob',
      { pattern: '../../**/*.pem', path: join(cwd, 'src') },
      cwd,
    );
    expect(result.paths).toEqual([
      { path: join(cwd, 'src'), op: 'read' },
      { path: root, op: 'read' },
    ]);
  });

  it('adds nothing for a relative pattern that stays below the path', () => {
    expect(resourcesOfFileTool('Glob', { pattern: 'src/**/*.ts' }, cwd).paths).toEqual([
      { path: cwd, op: 'read' },
    ]);
  });

  it('lists the root of a pattern that starts with ~ as written and says it is not complete', () => {
    const result = resourcesOfFileTool('Glob', { pattern: '~/.ssh/*' }, cwd);
    expect(result.paths).toContainEqual({ path: '~/.ssh', op: 'read' });
    expect(result.pathsComplete).toBe(false);
  });

  it.skipIf(!POSIX)('takes the root of a pattern of wildcards only as the filesystem root', () => {
    expect(resourcesOfFileTool('Glob', { pattern: '/**/*.pem' }, cwd).paths).toEqual([
      { path: resolve('/'), op: 'read' },
    ]);
  });

  it('is not complete without a pattern, but still reads where it would look', () => {
    for (const toolInput of [{}, { pattern: 7 }, { pattern: null }, { pattern: ['*'] }]) {
      expect(resourcesOfFileTool('Glob', toolInput, cwd)).toEqual({
        paths: [{ path: cwd, op: 'read' }],
        pathsComplete: false,
        urls: [],
        shell: false,
      });
    }
  });

  it('is not complete when the path is not a string', () => {
    expect(resourcesOfFileTool('Glob', { pattern: '*', path: 5 }, cwd).pathsComplete).toBe(false);
  });
});

describe('resourcesOfWebFetch', () => {
  it('gives the address and its host', () => {
    expect(resourcesOfWebFetch('https://api.example/v1/items?id=1#top')).toEqual({
      paths: [],
      pathsComplete: true,
      urls: [{ url: 'https://api.example/v1/items?id=1#top', host: 'api.example' }],
      shell: false,
    });
  });

  it('reads the host the way a client does: lower case, no port, no user information', () => {
    expect(resourcesOfWebFetch('https://User:pw@Docs.Example.COM:8443/x').urls).toEqual([
      { url: 'https://User:pw@Docs.Example.COM:8443/x', host: 'docs.example.com' },
    ]);
    expect(resourcesOfWebFetch('https://trusted.example@evil.example/').urls[0]?.host).toBe(
      'evil.example',
    );
    expect(resourcesOfWebFetch('http://[::1]:8080/x').urls[0]?.host).toBe('[::1]');
  });

  it.skipIf(!POSIX)('reads a file: URL as a path that is read', () => {
    const url = pathToFileURL(join(cwd, 'real.txt')).href;
    expect(resourcesOfWebFetch(url)).toEqual({
      paths: [{ path: join(cwd, 'real.txt'), op: 'read' }],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });

  it.skipIf(!POSIX)('gives the real place of a file: URL that leads through a link', () => {
    const url = pathToFileURL(join(cwd, 'link.txt')).href;
    expect(resourcesOfWebFetch(url).paths).toEqual([
      { path: join(cwd, 'link.txt'), real: join(root, 'outside', 'secret.txt'), op: 'read' },
    ]);
  });

  it.skipIf(!POSIX)('decodes the path of a file: URL', () => {
    const url = `${pathToFileURL(cwd).href}/a%20b/c%23d.txt`;
    expect(resourcesOfWebFetch(url).paths).toEqual([
      { path: join(cwd, 'a b', 'c#d.txt'), op: 'read' },
    ]);
  });

  it.skipIf(!POSIX)(
    'is not complete for a file: URL that names a host: that is not a local path',
    () => {
      expect(resourcesOfWebFetch('file://share.example/x/y.txt')).toEqual(UNKNOWN);
    },
  );

  it.each([undefined, null, 5, ['https://a.example'], {}, ''])(
    'says it knows nothing for %j',
    (url) => {
      expect(resourcesOfWebFetch(url)).toEqual(UNKNOWN);
    },
  );

  it('lists a text that is not an address with no host, rather than dropping it', () => {
    expect(resourcesOfWebFetch('example.com/page').urls).toEqual([
      { url: 'example.com/page', host: '' },
    ]);
    expect(resourcesOfWebFetch('data:text/plain,hi').urls).toEqual([
      { url: 'data:text/plain,hi', host: '' },
    ]);
  });

  it('cuts an address at the length of one, keeps its host, and says it is not complete', () => {
    const result = resourcesOfWebFetch(`https://h.example/${'a'.repeat(100_000)}`);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]?.url).toHaveLength(MAX_URL_CHARS);
    expect(result.urls[0]?.host).toBe('h.example');
    expect(result.pathsComplete).toBe(false);
  });
});

describe('resourcesOfMcp', () => {
  const named = (path: string, dest = false): ScannedPath => ({ path, dest, weak: false });
  const weak = (path: string): ScannedPath => ({ path, dest: false, weak: true });
  const abs = (name: string): string => join(cwd, name);

  it('reads a path of a tool that does not write', () => {
    expect(resourcesOfMcp([named(abs('a.txt'))], true, false, cwd)).toEqual({
      paths: [{ path: abs('a.txt'), op: 'read' }],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });

  it('writes a path of a tool that writes', () => {
    expect(resourcesOfMcp([named(abs('a.txt'))], true, true, cwd).paths).toEqual([
      { path: abs('a.txt'), op: 'write' },
    ]);
  });

  it('writes a destination of a tool that is not named like a writer, and reads its source', () => {
    expect(
      resourcesOfMcp([named(abs('in.png')), named(abs('out.png'), true)], true, false, cwd).paths,
    ).toEqual([
      { path: abs('in.png'), op: 'read' },
      { path: abs('out.png'), op: 'write' },
    ]);
  });

  it('reads a value that only looks like a path, even for a tool that writes', () => {
    expect(resourcesOfMcp([weak(abs('attached.txt'))], true, true, cwd).paths).toEqual([
      { path: abs('attached.txt'), op: 'read' },
    ]);
  });

  it('resolves a relative path against the working directory', () => {
    expect(resourcesOfMcp([named('src/../a.txt')], true, true, cwd).paths).toEqual([
      { path: abs('a.txt'), op: 'write' },
    ]);
  });

  it.skipIf(!POSIX)('reads a file: URI as the path it names', () => {
    const uri = pathToFileURL(abs('a.txt')).href;
    expect(resourcesOfMcp([named(uri)], true, false, cwd).paths).toEqual([
      { path: abs('a.txt'), op: 'read' },
    ]);
  });

  it.skipIf(!POSIX)('is not complete for a file: URI that is not a local path', () => {
    const result = resourcesOfMcp([named('file://share.example/x')], true, false, cwd);
    expect(result.paths).toEqual([]);
    expect(result.pathsComplete).toBe(false);
  });

  it.skipIf(!POSIX)('gives the real place of a link', () => {
    expect(resourcesOfMcp([named('link.txt')], true, true, cwd).paths).toEqual([
      { path: abs('link.txt'), real: join(root, 'outside', 'secret.txt'), op: 'write' },
    ]);
  });

  it.each([
    ['a ~ path', '~/notes.txt'],
    ['a wildcard', 'src/*.ts'],
    ['a question mark', 'src/?.ts'],
    ['a variable', '$HOME/notes.txt'],
    ['a NUL byte', 'a\0b'],
    ['an empty value', ''],
  ])('is not complete for %s: it looks like a path and cannot be resolved', (_name, value) => {
    expect(resourcesOfMcp([named(value)], true, false, cwd).pathsComplete).toBe(false);
  });

  it('keeps the ~ path as written, and lists the others around it', () => {
    const result = resourcesOfMcp([named('~/notes.txt'), named('a.txt')], true, false, cwd);
    expect(result.paths).toEqual([
      { path: '~/notes.txt', op: 'read' },
      { path: abs('a.txt'), op: 'read' },
    ]);
  });

  it('keeps the brackets of a route file: they are part of its name', () => {
    expect(resourcesOfMcp([named('app/blog/[slug]/page.tsx')], true, true, cwd)).toMatchObject({
      paths: [{ path: abs(join('app', 'blog', '[slug]', 'page.tsx')), op: 'write' }],
      pathsComplete: true,
    });
  });

  it('is not complete when the scan of the arguments was not', () => {
    expect(resourcesOfMcp([named(abs('a.txt'))], false, false, cwd).pathsComplete).toBe(false);
  });

  it('lists a path once for each way it is used, and once when it is used the same way', () => {
    const result = resourcesOfMcp(
      [named(abs('a.txt')), named('a.txt'), named(abs('a.txt'), true)],
      true,
      false,
      cwd,
    );
    expect(result.paths).toEqual([
      { path: abs('a.txt'), op: 'read' },
      { path: abs('a.txt'), op: 'write' },
    ]);
  });

  it('caps the list, keeps the first, and says it is not complete', () => {
    const entries = Array.from({ length: 300 }, (_, i) => named(abs(`f${i}.txt`)));
    const result = resourcesOfMcp(entries, true, false, cwd);
    expect(result.paths).toHaveLength(MAX_RESOURCE_PATHS);
    expect(result.paths[0]?.path).toBe(abs('f0.txt'));
    expect(result.pathsComplete).toBe(false);
  });

  it('is complete at exactly the cap', () => {
    const entries = Array.from({ length: MAX_RESOURCE_PATHS }, (_, i) => named(abs(`f${i}.txt`)));
    const result = resourcesOfMcp(entries, true, false, cwd);
    expect(result.paths).toHaveLength(MAX_RESOURCE_PATHS);
    expect(result.pathsComplete).toBe(true);
  });

  it('gives nothing, complete, for a call that names no path', () => {
    expect(resourcesOfMcp([], true, false, cwd)).toEqual({
      paths: [],
      pathsComplete: true,
      urls: [],
      shell: false,
    });
  });
});
