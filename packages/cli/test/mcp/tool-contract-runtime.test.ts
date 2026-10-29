import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashToolContractRuntime } from '../../src/mcp/tool-contract-runtime.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-contract-runtime-')));
  dirs.push(dir);
  await writeFile(join(dir, 'index.js'), "import './chunk.js';", { mode: 0o600 });
  await writeFile(join(dir, 'chunk.js'), 'export const version=1;', { mode: 0o600 });
  return { dir, entry: join(dir, 'index.js') };
}
describe('MCP tool runtime identity', () => {
  it('changes when a split chunk changes while the loader stays unchanged', async () => {
    const f = await fixture(),
      first = await hashToolContractRuntime(f.entry);
    expect(await hashToolContractRuntime(f.entry)).toBe(first);
    await writeFile(join(f.dir, 'chunk.js'), 'export const version=2;');
    expect(await hashToolContractRuntime(f.entry)).not.toBe(first);
  });
  it('refuses symlinked chunks and writable authority', async () => {
    const f = await fixture();
    await symlink('chunk.js', join(f.dir, 'linked.js'));
    await expect(hashToolContractRuntime(f.entry)).rejects.toThrow('tool-contract-unavailable');
    await rm(join(f.dir, 'linked.js'));
    await chmod(join(f.dir, 'chunk.js'), 0o666);
    await expect(hashToolContractRuntime(f.entry)).rejects.toThrow('tool-contract-unavailable');
  });
});
