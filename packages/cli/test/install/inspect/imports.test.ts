import { describe, expect, it } from 'vitest';
import { OUTSIDE_IMPORTS_SPOT } from '../../../src/install/inspect/blind-spots.js';
import { completeTree, passportOf, type Files } from '../../helpers/inspect.js';
import { hasOutsideImports, outsideImportsOfTree } from '../../../src/install/inspect/imports.js';

const manifest = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'srv', version: '1.0.0', bin: 'server.js', ...extra });

const outside = (files: Files) => outsideImportsOfTree(completeTree(files));
const spotOf = (files: Files, kind: 'mcp' | 'skill' = 'mcp'): boolean =>
  passportOf(files, { kind }).blindSpots.includes(OUTSIDE_IMPORTS_SPOT);

describe('what an MCP server asks for that its tree does not hold', () => {
  it('finds a package that package.json lists, in each field that is needed to run', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const found = outside({
        'package.json': manifest({ [field]: { zod: '^3.0.0' } }),
        'server.js': 'console.log(1)\n',
      });

      expect(found.declared).toEqual([field]);
      expect(found.modules).toEqual([]);
    }
  });

  it('does not count devDependencies or an empty list', () => {
    const found = outside({
      'package.json': manifest({ devDependencies: { esbuild: '1' }, dependencies: {} }),
      'server.js': 'console.log(1)\n',
    });

    expect(found).toEqual({ declared: [], modules: [], concerns: [] });
  });

  it('finds a package the sources import by name even when package.json lists none', () => {
    const found = outside({
      'package.json': JSON.stringify({ name: 'bare', version: '1.0.0', type: 'module' }),
      'server.mjs':
        "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\nimport { z } from 'zod';\n",
    });

    expect(found.declared).toEqual([]);
    expect(found.modules).toEqual(['@modelcontextprotocol/sdk', 'zod']);
  });

  it('finds require and dynamic import in any .js, .mjs or .cjs file, in any folder', () => {
    const found = outside({
      'package.json': manifest(),
      'server.js': "require('./lib/a.js')\n",
      'lib/a.js': "const x = require('left-pad')\n",
      'lib/deep/b.mjs': "const y = await import('is-odd')\n",
      'lib/deep/c.cjs': "module.exports = require('chalk')\n",
    });

    expect(found.modules).toEqual(['chalk', 'is-odd', 'left-pad']);
  });

  it('accepts a server that is one file, and one that vendors its code and asks for it by path', () => {
    const files = {
      'package.json': manifest(),
      'server.js':
        "const fs = require('fs'); const p = require('node:path'); const u = require('fs/promises');\nconst v = require('./vendor/dep/index.js'); import('./vendor/other.mjs');\n",
      'vendor/dep/index.js': "module.exports = require('./inner.js')\n",
      'vendor/dep/inner.js': 'module.exports = 1\n',
      'vendor/other.mjs': 'export default 2\n',
    };

    expect(outside(files)).toEqual({ declared: [], modules: [], concerns: [] });
    expect(spotOf(files)).toBe(false);
  });

  it('does not read what a comment, a string or a regular expression says', () => {
    const found = outside({
      'package.json': manifest(),
      'server.js':
        "// const x = require('commented')\n/* import y from 'blocked' */\nconst s = \"require('in-a-string')\";\nconst r = /require\\('in-a-regex'\\)/;\n",
    });

    expect(found.modules).toEqual([]);
  });

  it('counts a package held in a node_modules folder above the file that asks for it as held', () => {
    const files = {
      'package.json': manifest(),
      'server.js': "require('held')\nrequire('missing')\n",
      'node_modules/held/index.js': 'module.exports = 1\n',
      'sub/node_modules/below/index.js': 'module.exports = 1\n',
      'sub/file.js': "require('below'); require('held')\n",
      'other.js': "require('below')\n",
    };

    expect(outside(files).modules).toEqual(['below', 'missing']);
  });

  it('does not read the files of a node_modules folder for imports of their own', () => {
    const found = outside({
      'package.json': manifest(),
      'server.js': "require('held')\n",
      'node_modules/held/index.js': "module.exports = require('transitive')\n",
    });

    expect(found.modules).toEqual([]);
  });

  it('counts a package asking for itself by its own name as held, only when it has exports', () => {
    const files = (exports: boolean) => ({
      'package.json': manifest(exports ? { exports: './server.js' } : {}),
      'server.js': "import('srv/server.js')\n",
    });

    expect(outside(files(true)).modules).toEqual([]);
    expect(outside(files(false)).modules).toEqual(['srv']);
  });

  it('does not count a # import, which the package maps itself', () => {
    expect(
      outside({ 'package.json': manifest(), 'server.js': "import '#internal/x'\n" }).modules,
    ).toEqual([]);
  });

  it('names at most fifty packages, sorted', () => {
    const lines = Array.from(
      { length: 80 },
      (_, i) => `require('pkg-${String(i).padStart(2, '0')}')`,
    );
    const found = outside({ 'package.json': manifest(), 'server.js': lines.join('\n') });

    expect(found.modules).toHaveLength(50);
    expect(found.modules[0]).toBe('pkg-00');
  });
});

describe('the blind spot of vet', () => {
  it('is added to an MCP server whose package.json lists dependencies', () => {
    expect(
      spotOf({ 'package.json': manifest({ dependencies: { a: '1' } }), 'server.js': '1\n' }),
    ).toBe(true);
  });

  it('is added when package.json lists nothing and the sources import a bare specifier', () => {
    expect(
      spotOf({
        'package.json': JSON.stringify({ name: 'bare', version: '1.0.0', bin: 'server.mjs' }),
        'server.mjs': "import { z } from 'zod';\n",
      }),
    ).toBe(true);
  });

  it('is not added to a self-contained server, and is a different spot from the one about dependencies', () => {
    const passport = passportOf(
      { 'package.json': manifest(), 'server.js': '1\n' },
      { kind: 'mcp' },
    );

    expect(passport.blindSpots).not.toContain(OUTSIDE_IMPORTS_SPOT);
    expect(OUTSIDE_IMPORTS_SPOT).toMatch(/^imports resolve outside the pin/);
  });

  it('is not added to a skill, which has no pin', () => {
    expect(
      spotOf(
        { 'SKILL.md': '---\nname: s\n---\n# s\n', 'scripts/a.js': "require('zod')\n" },
        'skill',
      ),
    ).toBe(false);
  });

  it('keeps the older blind spot about dependencies beside it', () => {
    const passport = passportOf(
      { 'package.json': manifest({ dependencies: { a: '1' } }), 'server.js': '1\n' },
      { kind: 'mcp' },
    );

    expect(passport.blindSpots).toContain('dependencies were not followed, fetched or read');
    expect(passport.blindSpots).toContain(OUTSIDE_IMPORTS_SPOT);
  });
});

const concernsOfFiles = (files: Files) =>
  Object.fromEntries(outside(files).concerns.map((c) => [c.concern, c.files]));
const server = (code: string, more: Files = {}): Files => ({
  'package.json': manifest(),
  'server.js': code,
  ...more,
});

describe('a file whose imports cannot be read is never read as one with none', () => {
  it.each([
    ['a name built at run time', 'const n = "a"; require(n)', 'computed'],
    ['require used as a value', 'const r = require; r("a")', 'computed'],
    ['a dynamic import of a computed name', 'import(name)', 'computed'],
    ['createRequire', 'const { createRequire } = require("module")', 'dynamic-code'],
    ['process.binding', 'process.binding("fs")', 'dynamic-code'],
    ['a function made from text', 'new Function("a", "return a")', 'dynamic-code'],
    ['eval', 'eval("1")', 'dynamic-code'],
    ['a string that is not closed', 'const s = "open\nrequire("a")', 'doubt'],
    ['an HTML-like comment', 'x = 1 <!-- require("a")', 'doubt'],
    ['an escaped module name', 'require("\\x70kg")', 'escaped'],
  ])('flags %s', (_what, code, concern) => {
    const found = outside(server(code));

    expect(concernsOfFiles(server(code))).toHaveProperty(concern, ['server.js']);
    expect(hasOutsideImports(found)).toBe(true);
    expect(spotOf(server(code))).toBe(true);
  });

  it('flags a file that is not valid UTF-8 text, and one with a NUL', () => {
    const bad = {
      'package.json': manifest(),
      'server.js': { bytes: new Uint8Array([0x72, 0xff, 0xfe, 0x28]) },
      'lib/binary.js': { bytes: new Uint8Array([0x72, 0x00, 0x28]) },
    };

    expect(concernsOfFiles(bad)).toHaveProperty('unreadable', ['lib/binary.js', 'server.js']);
    expect(spotOf(bad)).toBe(true);
  });

  it('flags a file past the amount of text it reads, and says which', () => {
    const files = server("require('./a.js')\n", { 'a.js': 'module.exports = 1\n' });
    const found = outsideImportsOfTree(completeTree(files), { budgetBytes: 20 });

    expect(found.concerns).toEqual([{ concern: 'budget', files: ['server.js'] }]);
  });

  it('reads a file that is longer than the one megabyte the other readings take, to its end', () => {
    const filler = `// ${'x'.repeat(1.5 * 1024 * 1024)}\n`;
    const found = outside(server(`${filler}require('left-pad')\n`));

    expect(found.modules).toEqual(['left-pad']);
    expect(found.concerns).toEqual([]);
  });

  it('flags a file that Node runs through a loader or natively', () => {
    for (const request of [
      "require('./addon.node')",
      "import './mod.wasm'",
      "require('./helper.ts')",
      "import('./view.jsx')",
      "require('./data.txt')",
    ]) {
      const files = server(request, {
        'addon.node': 'x',
        'mod.wasm': 'x',
        'helper.ts': 'x',
        'view.jsx': 'x',
        'data.txt': 'x',
      });

      expect(concernsOfFiles(files), request).toHaveProperty('loader', ['server.js']);
    }
    // Without the extension Node still finds a native addon, and runs a file with no extension as code.
    expect(concernsOfFiles(server("require('./addon')", { 'addon.node': 'x' }))).toHaveProperty(
      'loader',
    );
    expect(concernsOfFiles(server("require('./tool')", { tool: 'x' }))).toHaveProperty('loader');
  });

  it('does not flag JSON, which loads no code, or a name that is a file with .js on it', () => {
    const files = server(
      "require('./config.json'); require('./lib'); require('./dir'); require('./a.b')",
      {
        'config.json': '{}',
        'lib.js': 'module.exports = 1',
        'dir/index.js': 'module.exports = 1',
        'a.b.js': 'module.exports = 1',
      },
    );

    expect(outside(files)).toEqual({ declared: [], modules: [], concerns: [] });
  });

  it('flags an import of a place outside the tree: an absolute path, a file: URL, a path that climbs out', () => {
    for (const request of [
      "require('/etc/x.js')",
      "import 'file:///etc/x.js'",
      "require('../shared/x.js')",
      "require('./../../x.js')",
    ])
      expect(concernsOfFiles(server(request)), request).toHaveProperty('outside', ['server.js']);
    // A Windows path has to be written with escapes, and a name written with escapes is not read.
    expect(concernsOfFiles(server("require('C:\\\\x.js')"))).toHaveProperty('escaped', [
      'server.js',
    ]);
    expect(
      concernsOfFiles(server("require('../server.js')", { 'lib/a.js': "require('../server.js')" })),
    ).toHaveProperty('outside', ['server.js']);
    expect(
      concernsOfFiles({
        'package.json': manifest(),
        'server.js': "require('./lib/a.js')",
        'lib/a.js': "require('../server.js'); require('./b.js')",
        'lib/b.js': '1',
      }),
    ).toEqual({});
  });

  it.each([
    ['main', { main: '../other/index.js' }],
    ['main', { main: '/abs/index.js' }],
    ['bin', { bin: '../other/cli.js' }],
    ['exports', { exports: '../server.js' }],
    ['exports', { exports: { '.': { import: './ok.mjs', require: '../bad.cjs' } } }],
    ['exports', { exports: { '.': 'server.js' } }],
    ['exports', { exports: { '.': './node_modules/x/index.js' } }],
    ['imports', { imports: { '#dep': 'some-package' } }],
    ['imports', { imports: { '#dep': '../x.js' } }],
    ['imports', { imports: { '#dep': { node: 'other-package', default: './ok.js' } } }],
  ])('flags a package.json whose %s points out of the tree', (_field, extra) => {
    const files = {
      'package.json': manifest(extra),
      'server.js': 'console.log(1)\n',
      'ok.mjs': '1',
      'ok.js': '1',
    };

    expect(concernsOfFiles(files)).toHaveProperty('outside', ['package.json']);
    expect(spotOf(files)).toBe(true);
  });

  it('does not flag a package.json whose entries stay inside', () => {
    const files = {
      'package.json': manifest({
        main: 'server.js',
        exports: { '.': { import: './server.js', require: './server.js' }, './x': './lib/x.js' },
        imports: { '#a': './lib/a.js', '#fs': 'node:fs' },
        bin: { srv: 'server.js' },
      }),
      'server.js': "import '#a'",
      'lib/a.js': '1',
    };

    expect(outside(files)).toEqual({ declared: [], modules: [], concerns: [] });
  });

  it('flags a package.json that is not valid JSON', () => {
    const files = { 'package.json': '{ not json', 'server.js': '1' };

    expect(concernsOfFiles(files)).toHaveProperty('unreadable', ['package.json']);
  });

  it('flags a package.json that is not text', () => {
    const files = {
      'package.json': { bytes: new Uint8Array([0x7b, 0xff, 0x7d]) },
      'server.js': '1',
    };

    expect(concernsOfFiles(files)).toHaveProperty('unreadable', ['package.json']);
  });

  it('does not look at files that are not run by Node without a loader, or at node_modules', () => {
    const files = server('1', {
      'view.jsx': 'require(name)',
      'types.ts': "import x from 'zod'",
      'node_modules/held/index.js': 'require(name)',
    });

    expect(outside(files)).toEqual({ declared: [], modules: [], concerns: [] });
  });
});

describe('the specifiers are judged as Node would look them up', () => {
  const asks = (request: string, more: Files = {}) => outside(server(request, more));

  it.each([
    ["require('NODE:fs')", 'NODE:fs'],
    ["require('Node:fs')", 'Node:fs'],
    ["require('FS')", 'FS'],
    ["require('DATA:text/javascript,1')", 'DATA:text'],
    ["import 'https://example.com/x.js'", 'https:'],
    ["import 'http://example.com/x.js'", 'http:'],
    ["require('npm:left-pad')", 'npm:left-pad'],
    ["require('..\\\\..\\\\x')", null],
  ])('%s is looked up by name, or flagged', (request, name) => {
    const found = asks(request);

    if (name !== null) expect(found.modules).toContain(name);
    expect(hasOutsideImports(found)).toBe(true);
  });

  it.each([
    "require('node:fs')",
    "require('fs')",
    "require('fs/promises')",
    "require('node:test')",
    "import 'data:text/javascript,export default 1'",
    "require('#internal')",
  ])('%s is a built-in of Node or a # import of the package', (request) => {
    expect(asks(request, { 'lib.js': '1' }).modules).toEqual([]);
  });

  it('counts a relative specifier that climbs out of the tree, by any path, as outside the pin', () => {
    for (const request of [
      "require('../x')",
      "require('./../x')",
      "require('./a/../../x')",
      "require('../../x')",
      "require('./a/b/../../../x')",
    ])
      expect(concernsOfFiles(server(request, { 'a/b/c.js': '1' })), request).toHaveProperty(
        'outside',
        ['server.js'],
      );
    expect(
      concernsOfFiles(
        server("require('./a/../lib/x.js'); require('./a/b/../c.js')", {
          'lib/x.js': '1',
          'a/c.js': '1',
        }),
      ),
    ).toEqual({});
  });

  it('counts a relative import that lands on a link as outside, and a link to a script as unread', () => {
    const files = server("require('./linked.js'); require('./dir-link')", {
      'linked.js': { symlink: '/etc/passwd' },
      'dir-link': { symlink: '/usr/lib' },
      'tool.js': { symlink: '../elsewhere.js' },
    });
    const found = concernsOfFiles(files);

    expect(found['outside']).toEqual(['linked.js', 'server.js', 'tool.js']);
  });

  it('reads the package.json of a folder of the tree, which is a package of its own to Node', () => {
    for (const nested of [
      { imports: { '#dep': 'left-pad' } },
      { imports: { '#dep': '../outside.js' } },
      { exports: '../outside.js' },
      { main: '../outside.js' },
    ])
      expect(
        concernsOfFiles(
          server("require('./lib/a.js')", {
            'lib/package.json': JSON.stringify({ name: 'lib', ...nested }),
            'lib/a.js': "require('#dep')",
          }),
        ),
        JSON.stringify(nested),
      ).toHaveProperty('outside', ['lib/package.json']);
    expect(
      concernsOfFiles(
        server("require('./lib/a.js')", {
          'lib/package.json': '{ not json',
          'lib/a.js': '1',
        }),
      ),
    ).toHaveProperty('unreadable', ['lib/package.json']);
    expect(
      concernsOfFiles(
        server("require('./lib/a.js')", {
          'lib/package.json': JSON.stringify({
            imports: { '#dep': './dep.js', '#fs': 'node:fs' },
            exports: { './*': './*.js' },
          }),
          'lib/a.js': "require('#dep')",
          'lib/dep.js': '1',
        }),
      ),
    ).toEqual({});
  });

  it('reads patterns in exports and imports, and a package that names itself', () => {
    const inside = {
      'package.json': manifest({
        name: 'srv',
        exports: { '.': './server.js', './lib/*': './lib/*.js', './x/*.js': './x/*.js' },
        imports: { '#lib/*': './lib/*.js' },
      }),
      'server.js': "require('srv/lib/a'); require('srv'); require('#lib/a')",
      'lib/a.js': '1',
    };
    const outsidePattern = {
      ...inside,
      'package.json': manifest({
        name: 'srv',
        exports: { './lib/*': '../lib/*.js' },
      }),
    };

    expect(outside(inside)).toEqual({ declared: [], modules: [], concerns: [] });
    expect(concernsOfFiles(outsidePattern)).toHaveProperty('outside', ['package.json']);
  });

  it('reports every file that has a concern, not only the first', () => {
    const files = server('require(name)', {
      'a.js': 'require(a)',
      'b.js': 'eval(b)',
      'lib/c.js': "const s = 'open",
      'lib/d.js': 'require(d)',
    });
    const found = concernsOfFiles(files);

    expect(found['computed']).toEqual(['a.js', 'lib/d.js', 'server.js']);
    expect(found['dynamic-code']).toEqual(['b.js']);
    expect(found['doubt']).toEqual(['lib/c.js']);
  });

  it('keeps going past a file it could not read', () => {
    const files = server("require('left-pad')", {
      'a.js': { bytes: new Uint8Array([0xff, 0xfe]) },
      'b.js': "require('is-odd')",
    });
    const found = outside(files);

    expect(found.modules).toEqual(['is-odd', 'left-pad']);
    expect(concernsOfFiles(files)).toHaveProperty('unreadable', ['a.js']);
  });
});
