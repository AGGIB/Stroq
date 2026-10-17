import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from './skill-install.js';

/** A one-file MCP server in `<root>/<folder>`, with the package.json that gives it a start file. */
export async function mcpServer(
  root: string,
  files: Readonly<Record<string, string>> = {},
  manifest: Readonly<Record<string, unknown>> = {},
  folder = 'srv',
): Promise<string> {
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', bin: { demo: 'server.js' }, ...manifest }),
  );
  const all = { 'server.js': 'console.log("one");\n', ...files };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

/** A fake home, a project, a client config with one other server, and the options `addMcp` takes. */
export async function mcpFixture(
  files: Readonly<Record<string, string>> = {},
  manifest: Readonly<Record<string, unknown>> = {},
) {
  const f = await setup();
  const dir = await mcpServer(f.root, files, manifest);
  const config = join(f.root, 'client.json');
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { other: { command: 'keep', args: ['1'] } }, extra: true }),
  );
  const mcpOptions = {
    project: f.options.project,
    stroqHome: f.options.stroqHome,
    terminal: f.terminal,
    node: process.execPath,
    entryArgv: ['/stroq/dist/index.js'],
    config,
  };
  const servers = async () =>
    (JSON.parse(await readFile(config, 'utf8')) as { mcpServers: Record<string, any> }).mcpServers;
  return { ...f, dir, config, mcpOptions, servers };
}
