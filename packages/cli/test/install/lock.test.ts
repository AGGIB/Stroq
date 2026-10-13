import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPassportLock,
  readPassports,
  writePassports,
  MAX_PASSPORT_LOCK_BYTES,
} from '../../src/install/lock.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'stroq-lock-'));
  roots.push(home);
  return { home, file: join(home, 'passports.json') };
}

describe('versioned passports lock', () => {
  it('shares the two kind buckets and rejects a different root format', async () => {
    const f = await fixture();
    await writeFile(f.file, '{"v":1,"mcp":{"server":{"kind":"mcp"}}}');
    expect(readPassportLock(f.file)).toEqual({
      v: 1,
      skills: {},
      mcp: { server: { kind: 'mcp' } },
    });
    await writeFile(f.file, '{"v":2,"skills":{}}');
    expect(() => readPassportLock(f.file)).toThrow();
  });

  it('refuses an oversized/nonregular confirmation lock before parsing', async () => {
    const f = await fixture();
    await writeFile(f.file, ' '.repeat(MAX_PASSPORT_LOCK_BYTES + 1));
    expect(() => readPassportLock(f.file)).toThrow(/size limit/);
    await expect(readPassports(f.home)).rejects.toThrow(/bounded regular/);
    await rm(f.file);
    await mkdir(f.file);
    expect(() => readPassportLock(f.file)).toThrow(/bounded regular/);
  });

  it.runIf(process.platform !== 'win32')('refuses a linked confirmation lock', async () => {
    const f = await fixture();
    const other = join(f.home, 'other.json');
    await writeFile(other, '{"v":1}');
    await symlink(other, f.file);
    expect(() => readPassportLock(f.file)).toThrow(/linked/);
  });

  it('writes an explicitly replaced MCP map and refuses oversized writes', async () => {
    const f = await fixture();
    await writeFile(f.file, '{"v":1,"mcp":{"old":12345678901234567890}}');
    const lock = await readPassports(f.home);
    await writePassports(f.home, { ...lock, mcp: { next: 'confirmed' } });
    expect(JSON.parse(await readFile(f.file, 'utf8')).mcp).toEqual({ next: 'confirmed' });
    await expect(
      writePassports(f.home, { ...lock, mcp: { huge: 'x'.repeat(MAX_PASSPORT_LOCK_BYTES) } }),
    ).rejects.toThrow(/read limit/);
  });
});
