import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMcp } from '../../src/install/mcp-install.js';
import { readPassports } from '../../src/install/lock.js';
import { mcpFixture } from '../helpers/mcp-install.js';

const REMEDY =
  /bundle the server into one self-contained file or vendor its dependencies inside the tree/;
const BEST_EFFORT = /best-effort reading of the text/;

async function untouched(f: Awaited<ReturnType<typeof mcpFixture>>, before: string) {
  expect(await readFile(f.config, 'utf8')).toBe(before);
  await expect(readFile(join(f.options.stroqHome, 'passports.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(f.prompts()).toBe(0);
}

describe('add --kind mcp holds a server to what its tree contains', () => {
  it('refuses a server whose package.json lists dependencies, with the remedy, before a prompt or a write', async () => {
    const f = await mcpFixture({}, { dependencies: { zod: '^3.0.0' } });
    const before = await readFile(f.config, 'utf8');

    await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow(REMEDY);
    await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow(/dependencies/);

    await untouched(f, before);
  });

  it.each(['optionalDependencies', 'peerDependencies'])(
    'refuses a server that lists %s',
    async (field) => {
      const f = await mcpFixture({}, { [field]: { zod: '^3.0.0' } });

      await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow(new RegExp(field));
    },
  );

  it('refuses a server whose sources import a package by name although package.json lists none', async () => {
    const f = await mcpFixture({
      'server.js': "const { z } = require('zod');\nrequire('@scope/pkg/sub');\n",
    });
    const before = await readFile(f.config, 'utf8');

    const error = await addMcp(f.dir, f.mcpOptions).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(REMEDY);
    expect((error as Error).message).toContain('"zod"');
    expect((error as Error).message).toContain('"@scope/pkg"');
    await untouched(f, before);
  });

  it('writes a name from the server out as text, never raw', async () => {
    const f = await mcpFixture({ 'server.js': "require('evil\\u001b[31m‮name')\n" });

    const error = await addMcp(f.dir, f.mcpOptions).catch((e: Error) => e);

    expect((error as Error).message).not.toMatch(/[\u001b‮]/u);
  });

  it('accepts one bundled file', async () => {
    const f = await mcpFixture({
      'server.js':
        "const fs = require('node:fs'); const p = require('path'); console.log(fs, p);\n",
    });

    const record = await addMcp(f.dir, f.mcpOptions);

    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(f.prompts()).toBe(1);
  });

  it('accepts a server that vendors its code inside the tree and asks for it by relative path', async () => {
    const f = await mcpFixture({
      'server.js': "const dep = require('./vendor/dep/index.js'); console.log(dep);\n",
      'vendor/dep/index.js': 'module.exports = 1;\n',
    });

    const record = await addMcp(f.dir, f.mcpOptions);

    expect(Object.keys(await f.servers())).toContain('demo');
    expect(record.passport.blindSpots.some((spot) => spot.startsWith('imports resolve'))).toBe(
      false,
    );
  });

  it('refuses an update that brings in an import by name, and keeps the install it had', async () => {
    const f = await mcpFixture();
    await addMcp(f.dir, f.mcpOptions);
    const before = await readFile(f.config, 'utf8');
    const lockBefore = JSON.stringify((await readPassports(f.options.stroqHome)).mcp);
    await writeFile(join(f.dir, 'server.js'), "require('left-pad')\n");

    await expect(addMcp('demo', f.mcpOptions)).rejects.toThrow(REMEDY);

    expect(await readFile(f.config, 'utf8')).toBe(before);
    expect(JSON.stringify((await readPassports(f.options.stroqHome)).mcp)).toBe(lockBefore);
  });

  it('says the reading is best-effort in the refusal and on the screen it asks against', async () => {
    const refused = await mcpFixture({ 'server.js': "require('zod')\n" });
    await expect(addMcp(refused.dir, refused.mcpOptions)).rejects.toThrow(BEST_EFFORT);

    const accepted = await mcpFixture();
    await addMcp(accepted.dir, accepted.mcpOptions);
    expect(accepted.output()).toMatch(BEST_EFFORT);
    expect(accepted.output()).toContain('tamper-evident, not tamper-proof');
  });

  it.each([
    ['a module requested by a name built at run time', 'const n = "a"; require(n)\n', /run time/],
    ['createRequire', 'import { createRequire } from "node:module"\n', /createRequire/],
    ['text that cannot be read with certainty', "const s = 'open\nrequire('a')\n", /certainty/],
    ['an escaped module name', "require('\\x70kg')\n", /escapes/],
    ['an import of a path outside the tree', "require('../other.js')\n", /climbs out of the tree/],
    ['a file Node runs through a loader', "require('./tool.ts')\n", /does not read as a script/],
  ])('refuses a server with %s, naming the file', async (_what, code, why) => {
    const f = await mcpFixture({ 'server.js': code, 'tool.ts': 'x' });
    const before = await readFile(f.config, 'utf8');

    const error = await addMcp(f.dir, f.mcpOptions).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(why);
    expect((error as Error).message).toContain('"server.js"');
    expect((error as Error).message).toMatch(REMEDY);
    await untouched(f, before);
  });

  it('refuses a package.json whose entries point out of the tree', async () => {
    const f = await mcpFixture({}, { exports: { '.': '../elsewhere.js' } });

    await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow(
      /"package.json": package.json points out of the tree/,
    );
  });

  it('says what was found, on which line, and why, for a person to act on', async () => {
    const f = await mcpFixture({
      'server.js':
        "const a = 1;\nconst { createRequire } = require('module');\nconst z = require('zod');\n",
    });

    const message = ((await addMcp(f.dir, f.mcpOptions).catch((e: Error) => e)) as Error).message;

    expect(message).toMatch(/"server.js" line 2: uses createRequire/);
    expect(message).toContain('the sources import "zod" by name');
    expect(message).toContain('esbuild --bundle --platform=node --format=cjs');
    expect(message).toMatch(/Remove "dependencies" from the package.json/);
    expect(message).toMatch(/__require shim that esbuild --format=esm adds/);
    expect(message).toMatch(/minified code that the reader cannot parse/);
    expect(message).toMatch(/eval or new Function/);
  });

  it('names a package, not a scheme, when a URL is imported', async () => {
    const f = await mcpFixture({ 'server.js': "import 'https://example.com/a.js'\n" });

    const message = ((await addMcp(f.dir, f.mcpOptions).catch((e: Error) => e)) as Error).message;

    expect(message).toContain('"https://example.com/a.js"');
    expect(message).not.toContain('"https:"');
  });

  it('writes a very long or hostile module name out cut and neutralised', async () => {
    const long = 'a'.repeat(5000);
    const f = await mcpFixture({
      'server.js': `require('${long}\u202e')\n`.replace('\\u202e', '\u202e'),
    });

    const message = ((await addMcp(f.dir, f.mcpOptions).catch((e: Error) => e)) as Error).message;

    expect(message).not.toContain(long);
    expect(message).not.toMatch(/[\u202e\u001b]/u);
    expect(message.length).toBeLessThan(3000);
  });
});
