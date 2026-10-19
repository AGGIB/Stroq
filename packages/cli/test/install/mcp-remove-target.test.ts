import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as transaction from '../../src/install/mcp-config-transaction.js';
import { addMcp, removeMcp } from '../../src/install/mcp-install.js';
import { readPassports, writePassports } from '../../src/install/lock.js';
import { storeDirIn } from '../../src/paths.js';
import { mcpFixture } from '../helpers/mcp-install.js';

async function recorded(state: 'confirmed' | 'pending') {
  const f = await mcpFixture();
  if (state === 'confirmed') await addMcp(f.dir, f.mcpOptions);
  else {
    let pending: Awaited<ReturnType<typeof readPassports>> | undefined;
    vi.spyOn(transaction, 'commitMcpConfig').mockImplementationOnce(async (file, config) => {
      await writeFile(file, JSON.stringify(config));
      pending = await readPassports(f.options.stroqHome);
      throw new Error('simulated interruption');
    });
    await expect(addMcp(f.dir, f.mcpOptions)).rejects.toThrow('simulated interruption');
    // A hard kill cannot restore the old lock in addMcp's catch.
    await writePassports(f.options.stroqHome, pending!);
  }
  return f;
}

for (const state of ['confirmed', 'pending'] as const) {
  describe(`explicit removal target for a ${state} MCP install`, () => {
    it.each(['another config', 'another client', 'both flags', 'unknown client'] as const)(
      'refuses %s before changing config, confirmation or stored revisions',
      async (kind) => {
        const f = await recorded(state);
        const other = join(f.root, 'other-client.json');
        const lockFile = join(f.options.stroqHome, 'passports.json');
        await writeFile(other, await readFile(f.config));
        const beforeA = await readFile(f.config, 'utf8');
        const beforeB = await readFile(other, 'utf8');
        const beforeLock = await readFile(lockFile, 'utf8');
        const beforeStore = await readdir(storeDirIn(f.options.stroqHome));
        const { config: _config, ...options } = f.mcpOptions;
        const explicit =
          kind === 'another config'
            ? { config: other }
            : kind === 'another client'
              ? { client: 'claude-code' }
              : kind === 'both flags'
                ? { config: f.config, client: 'claude-code' }
                : { client: 'unknown' };
        const error =
          kind === 'both flags'
            ? /exactly one/
            : kind === 'unknown client'
              ? /unknown MCP client/
              : /another client config/;
        await expect(removeMcp('demo', { ...options, ...explicit, force: true })).rejects.toThrow(
          error,
        );
        expect(await readFile(f.config, 'utf8')).toBe(beforeA);
        expect(await readFile(other, 'utf8')).toBe(beforeB);
        expect(await readFile(lockFile, 'utf8')).toBe(beforeLock);
        expect(await readdir(storeDirIn(f.options.stroqHome))).toEqual(beforeStore);
      },
    );

    it('accepts an explicit config that matches the recorded target', async () => {
      const f = await recorded(state);
      await removeMcp('demo', { ...f.mcpOptions, config: f.config, force: true });
      expect((await f.servers())['demo']).toBeUndefined();
      expect((await f.servers())['other']).toEqual({ command: 'keep', args: ['1'] });
    });
  });
}

it('still removes a no-record orphan from the explicitly selected config', async () => {
  const f = await recorded('confirmed');
  await writePassports(f.options.stroqHome, { v: 1, skills: {}, mcp: {} });
  await removeMcp('demo', { ...f.mcpOptions, force: true });
  expect((await f.servers())['demo']).toBeUndefined();
  expect((await f.servers())['other']).toEqual({ command: 'keep', args: ['1'] });
});

it('keeps the recorded project boundary when an explicit config matches its path', async () => {
  const f = await mcpFixture();
  const { config: _config, ...options } = f.mcpOptions;
  const record = await addMcp(f.dir, { ...options, client: 'cursor' });
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  const copy = join(outside, 'mcp.json');
  const before = await readFile(record.config, 'utf8');
  const lockFile = join(f.options.stroqHome, 'passports.json');
  const lock = await readFile(lockFile, 'utf8');
  await writeFile(copy, before);
  await rm(join(f.options.project, '.cursor'), { recursive: true });
  await symlink(outside, join(f.options.project, '.cursor'));
  await expect(
    removeMcp('demo', { ...options, config: record.config, force: true }),
  ).rejects.toThrow(/outside/);
  expect(await readFile(copy, 'utf8')).toBe(before);
  expect(await readFile(lockFile, 'utf8')).toBe(lock);
});
