import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMcp } from '../../src/install/mcp-install.js';
import { setup } from '../helpers/skill-install.js';

/**
 * `stroq add --kind mcp` writes a pinned wrapper from scratch. It does not write
 * `--strict`, and it does not carry one over: this pins the limit and the sentence that
 * says so, so a user who ran `init --agent mcp --strict` over a pinned entry and then
 * updates the server is told what the update does to it, not left to find out.
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

/** What `init --agent mcp --strict` does to a pinned entry: adds the flag before the separator. */
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
    expect(f.output()).toContain('stroq add does not write --strict');
    expect(f.output()).toContain('stroq init --agent mcp');
    expect(JSON.stringify(await f.servers())).not.toContain('--strict');
  });
});
