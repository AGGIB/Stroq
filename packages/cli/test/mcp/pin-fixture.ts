import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { buildTree, fileDigestOf, treeDigest } from '../../src/install/tree.js';

export const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

export async function fixture(exec = false, code = 'console.log("checked");\n', data?: string) {
  const home = await mkdtemp(join(tmpdir(), 'stroq-pin-test-'));
  roots.push(home);
  const bytes = Buffer.from(code);
  const tree = buildTree([
    {
      path: 'server.mjs',
      kind: 'file',
      exec,
      size: bytes.length,
      sha256: fileDigestOf(bytes),
      bytes,
    },
    ...(data === undefined
      ? []
      : [
          {
            path: 'config.json',
            kind: 'file' as const,
            exec: false,
            size: Buffer.byteLength(data),
            sha256: fileDigestOf(Buffer.from(data)),
            bytes: Buffer.from(data),
          },
        ]),
  ]);
  const digest = treeDigest(tree);
  const store = join(home, 'store', `sha256-${digest.slice(0, 32)}`);
  await mkdir(join(store, 'tree'), { recursive: true });
  await writeFile(join(store, 'tree', 'server.mjs'), bytes, { mode: 0o600 });
  if (data !== undefined) await writeFile(join(store, 'tree', 'config.json'), data);
  await writeFile(
    join(store, 'manifest.json'),
    JSON.stringify({ entries: tree.entries.map(({ bytes: _bytes, ...entry }) => entry) }),
  );
  const record = { kind: 'mcp', status: 'confirmed', digest, grant: { pin: `sha256:${digest}` } };
  await writeFile(
    join(home, 'passports.json'),
    JSON.stringify({ v: 1, skills: {}, mcp: { demo: record } }),
  );
  const options = {
    home,
    server: 'demo',
    pin: `sha256:${digest}`,
    command: process.execPath,
    args: [join(store, 'tree', 'server.mjs'), '--data'],
  };
  return { home, bytes, digest, store, options, record };
}
