import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { buildTree, fileDigestOf, treeDigest } from '../../src/install/tree.js';
import { preparePin, type PinnedLaunch } from '../../src/mcp/pin.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const homes: string[] = [];
const copies: PinnedLaunch[] = [];
afterEach(async () => {
  for (const copy of copies.splice(0)) await copy.cleanup();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'stroq-pin-mode-'));
  homes.push(home);
  const files = [
    {
      path: 'server.mjs',
      exec: false,
      bytes: Buffer.from(
        'import {execFileSync} from "node:child_process"; import {fileURLToPath} from "node:url"; process.stdout.write(execFileSync(fileURLToPath(new URL("./helper.sh", import.meta.url))));',
      ),
    },
    { path: 'helper.sh', exec: true, bytes: Buffer.from('#!/bin/sh\nprintf pin-helper-ok') },
  ];
  const tree = buildTree(
    files.map((file) => ({
      ...file,
      kind: 'file',
      size: file.bytes.length,
      sha256: fileDigestOf(file.bytes),
    })),
  );
  const digest = treeDigest(tree);
  const root = join(home, 'store', `sha256-${digest.slice(0, 32)}`);
  await mkdir(join(root, 'tree'), { recursive: true });
  for (const file of files)
    await writeFile(join(root, 'tree', file.path), file.bytes, { mode: 0o600 });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ entries: tree.entries.map(({ bytes: _bytes, ...entry }) => entry) }),
  );
  await writeFile(
    join(home, 'passports.json'),
    JSON.stringify({
      v: 1,
      mcp: {
        demo: { kind: 'mcp', status: 'confirmed', digest, grant: { pin: `sha256:${digest}` } },
      },
    }),
  );
  const copy = await preparePin({
    home,
    server: 'demo',
    pin: `sha256:${digest}`,
    command: process.execPath,
    args: [join(root, 'tree', 'server.mjs')],
  });
  copies.push(copy);
  return { copy, root };
}

it('restores the inspected executable flag only in the private runtime copy', async () => {
  const { copy } = await fixture();
  const helperWrite = vi
    .mocked(writeFile)
    .mock.calls.find(([path]) => path === join(copy.cwd, 'helper.sh'));
  const scriptWrite = vi
    .mocked(writeFile)
    .mock.calls.find(([path]) => path === join(copy.cwd, 'server.mjs'));
  expect(helperWrite?.[2]).toMatchObject({ mode: 0o700 });
  expect(scriptWrite?.[2]).toMatchObject({ mode: 0o600 });
});

it.skipIf(process.platform === 'win32')(
  'runs a shipped executable helper from the private copy on POSIX',
  async () => {
    const { copy, root } = await fixture();
    expect((await stat(join(root, 'tree', 'helper.sh'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(copy.cwd, 'helper.sh'))).mode & 0o777).toBe(0o700);
    const result = await promisify(execFile)(copy.command, [...copy.args], { cwd: copy.cwd });
    expect(result.stdout).toBe('pin-helper-ok');
  },
);
