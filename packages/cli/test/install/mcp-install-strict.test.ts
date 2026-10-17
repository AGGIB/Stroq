import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMcp } from '../../src/install/mcp-install.js';
import { setup } from '../helpers/skill-install.js';
import { readPassports } from '../../src/install/lock.js';
import { inspectPin } from '../../src/mcp/pin.js';
import { parseMcpArgv } from '../../src/commands/mcp.js';

/**
 * Strict filtering is part of the wrapper a person confirms. Updates inherit checks only from the lock's written
 * entry; an outside edit remains drift, and --force must not silently turn it into a recorded grant.
 */

async function fixture() {
  const f = await setup();
  const dir = join(f.root, 'srv');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', bin: { demo: 'server.js' } }),
  );
  await writeFile(join(dir, 'server.js'), 'console.log("one");\n');
  const config = join(f.root, 'client.json');
  await writeFile(config, JSON.stringify({ mcpServers: {} }));
  const options = {
    project: f.options.project,
    stroqHome: f.options.stroqHome,
    terminal: f.terminal,
    node: process.execPath,
    entryArgv: ['/stroq/dist/index.js'],
    config,
  };
  const servers = async () =>
    (JSON.parse(await readFile(config, 'utf8')) as { mcpServers: Record<string, any> }).mcpServers;
  return { ...f, dir, config, options, servers };
}

/** An outside edit, which `init` now deliberately avoids for a confirmed entry. */
async function makeStrict(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const servers = await f.servers();
  const args = servers['demo'].args as string[];
  args.splice(args.indexOf('--'), 0, '--strict');
  await writeFile(f.config, JSON.stringify({ mcpServers: servers }));
}

describe('stroq add --kind mcp and --strict', () => {
  it('writes no --strict into a wrapper it adds, and says nothing about it', async () => {
    const f = await fixture();
    await addMcp(f.dir, f.options);
    expect(JSON.stringify(await f.servers())).not.toContain('--strict');
    expect(f.output()).not.toContain('--strict');
  });

  it('refuses to update over an entry that was made strict outside it, unless forced', async () => {
    const f = await fixture();
    await addMcp(f.dir, f.options);
    await makeStrict(f);
    await expect(addMcp('demo', f.options)).rejects.toThrow(/changed outside Stroq/);
  });

  it('when forced, says the entry it replaces ran with --strict and that the new one does not', async () => {
    const f = await fixture();
    await addMcp(f.dir, f.options);
    await makeStrict(f);
    await addMcp('demo', { ...f.options, force: true });
    expect(f.output()).toContain('runs with --strict');
    expect(f.output()).toContain('not confirmed in the lock');
    expect(f.output()).toContain('stroq add demo --kind mcp --strict --force');
    expect(JSON.stringify(await f.servers())).not.toContain('--strict');
  });

  it('confirms a strict wrapper and the pin accepts its exact launch', async () => {
    const f = await fixture();
    const record = await addMcp(f.dir, { ...f.options, strict: true });
    const entry = (await f.servers())['demo'];
    const args = entry.args as string[];
    const parsed = parseMcpArgv(args.slice(args.indexOf('mcp') + 1));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.invocation.strict).toBe(true);
    expect(args.indexOf('--strict')).toBeLessThan(args.indexOf('--'));
    expect(record.written).toEqual(entry);
    expect(f.output()).toContain('Strict filtering: ON');
    expect(f.questions).toHaveLength(1);
    expect(f.questions[0]).toMatch(/12/);
    const { command, args: serverArgs, passEnv } = parsed.invocation;
    const status = await inspectPin({
      home: f.options.stroqHome,
      server: 'demo',
      pin: `sha256:${record.digest}`,
      command,
      args: serverArgs,
      passEnv,
      launch: { command: entry.command, argv: args },
    });
    expect(status.ok, status.detail).toBe(true);
    const changed = [...args];
    changed.splice(changed.indexOf('--strict'), 1);
    expect(
      (
        await inspectPin({
          home: f.options.stroqHome,
          server: 'demo',
          pin: `sha256:${record.digest}`,
          command,
          args: serverArgs,
          passEnv,
          launch: { command: entry.command, argv: changed },
        })
      ).ok,
    ).toBe(false);
  });

  it('enabling strict with unchanged server bytes needs a typed digest and keeps the old entry on refusal', async () => {
    const f = await fixture();
    const first = await addMcp(f.dir, f.options);
    const before = await readFile(f.config, 'utf8');
    const questions: string[] = [];
    await expect(
      addMcp('demo', {
        ...f.options,
        strict: true,
        terminal: { ...f.terminal, readLine: async (question) => (questions.push(question), 'y') },
      }),
    ).rejects.toThrow(/not confirmed/);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.every((question) => /12/.test(question))).toBe(true);
    expect(await readFile(f.config, 'utf8')).toBe(before);
    const added = await addMcp('demo', { ...f.options, strict: true });
    expect(added.digest).toBe(first.digest);
    expect(added.history.at(-1)?.material).toBe(true);
    expect((await f.servers())['demo'].args).toContain('--strict');
  });

  it.each(['9', '0'])(
    'updates and restores keep the recorded strict limit %s, even one that must fail closed',
    async (limit) => {
      const f = await fixture();
      await addMcp(f.dir, { ...f.options, strict: true });
      const servers = await f.servers();
      const args = servers['demo'].args as string[];
      args.splice(args.indexOf('--'), 0, '--strict-max-withheld', limit);
      // A lock from an earlier/manual confirmation is the authority, not the client config.
      const lock = await readPassports(f.options.stroqHome);
      const record = lock.mcp!['demo'] as { written: unknown };
      record.written = servers['demo'];
      await writeFile(join(f.options.stroqHome, 'passports.json'), JSON.stringify(lock));
      await writeFile(f.config, JSON.stringify({ mcpServers: servers }));
      for (const restore of [false, true]) {
        const updated = await addMcp('demo', { ...f.options, restore });
        const kept = updated.written['args'] as string[];
        expect(kept).toContain('--strict');
        expect(kept[kept.indexOf('--strict-max-withheld') + 1]).toBe(limit);
      }
    },
  );

  it('a forced update restores recorded strict checks rather than adopting a drifted limit', async () => {
    const f = await fixture();
    await addMcp(f.dir, { ...f.options, strict: true });
    const servers = await f.servers();
    const args = servers['demo'].args as string[];
    args.splice(args.indexOf('--'), 0, '--strict-max-withheld', '999');
    await writeFile(f.config, JSON.stringify({ mcpServers: servers }));
    const restored = await addMcp('demo', { ...f.options, force: true });
    expect(restored.written['args']).toContain('--strict');
    expect(restored.written['args']).not.toContain('--strict-max-withheld');
  });
});
