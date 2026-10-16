import { describe, expect, it } from 'vitest';
import { OUTSIDE_IMPORTS_SPOT } from '../../../src/install/inspect/blind-spots.js';
import { completeTree, passportOf, type Files } from '../../helpers/inspect.js';
import { outsideImportsOfTree } from '../../../src/install/inspect/imports.js';

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

    expect(found).toEqual({ declared: [], modules: [] });
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

    expect(outside(files)).toEqual({ declared: [], modules: [] });
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
