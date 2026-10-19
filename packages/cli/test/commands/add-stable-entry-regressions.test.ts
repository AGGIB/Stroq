import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runAdd } from '../../src/commands/add.js';
import { stroqVersion } from '../../src/version.js';
import { wrappedEntryPath } from '../../src/commands/mcp-config.js';
import { mcpFixture } from '../helpers/mcp-install.js';
import * as terminal from '../../src/ui/terminal.js';

afterEach(() => vi.restoreAllMocks());

it.each(['cli parent link', 'version target link', 'version target file'] as const)(
  'refuses a %s before copying, replacing bytes or asking for confirmation',
  async (kind) => {
    const f = await mcpFixture();
    const entry = join(f.root, '_npx', 'demo-cache', 'node_modules', 'cli', 'index.js');
    await mkdir(join(entry, '..'), { recursive: true });
    await writeFile(entry, '// temporary CLI');
    const outside = join(f.root, 'outside-cli');
    const outsideVersion = join(outside, stroqVersion());
    await mkdir(outsideVersion, { recursive: true });
    const sentinel = join(outsideVersion, 'keep.txt');
    await writeFile(sentinel, 'unrelated bytes');
    const cli = join(f.options.stroqHome, 'cli');
    const version = join(cli, stroqVersion());
    await mkdir(f.options.stroqHome, { recursive: true });
    if (kind === 'cli parent link') {
      await symlink(outside, cli, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await mkdir(cli);
      if (kind === 'version target link') {
        const existingEntry = join(outsideVersion, 'node_modules', 'cli', 'index.js');
        await mkdir(join(existingEntry, '..'), { recursive: true });
        await writeFile(existingEntry, '// entry outside the Stroq home');
        await symlink(outsideVersion, version, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await writeFile(version, 'existing plain file');
      }
    }
    vi.stubEnv('STROQ_HOME', f.options.stroqHome);
    vi.spyOn(process, 'cwd').mockReturnValue(f.options.project);
    vi.spyOn(terminal, 'currentTerminal').mockReturnValue(f.terminal);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const configBefore = await readFile(f.config, 'utf8');
    const old = process.argv[1];
    process.argv[1] = entry;
    try {
      await expect(runAdd([f.dir, '--kind', 'mcp', '--config', f.config])).rejects.toThrow(
        /cannot create a stable Stroq entry.*npm install -g @stroq\/cli/,
      );
      expect(existsSync(sentinel)).toBe(true);
      expect(await readFile(sentinel, 'utf8')).toBe('unrelated bytes');
      expect(f.prompts()).toBe(0);
      expect(await readFile(f.config, 'utf8')).toBe(configBefore);
      expect(existsSync(join(f.options.stroqHome, 'passports.json'))).toBe(false);
      if (kind === 'version target file')
        expect(await readFile(version, 'utf8')).toBe('existing plain file');
    } finally {
      process.argv[1] = old!;
    }
  },
);

it('reuses a plain stable copy without replacing its bytes', async () => {
  const f = await mcpFixture();
  const entry = join(f.root, '_npx', 'demo-cache', 'node_modules', 'cli', 'index.js');
  const stable = join(
    f.options.stroqHome,
    'cli',
    stroqVersion(),
    'node_modules',
    'cli',
    'index.js',
  );
  await mkdir(join(entry, '..'), { recursive: true });
  await writeFile(entry, '// temporary CLI');
  await mkdir(join(stable, '..'), { recursive: true });
  await writeFile(stable, '// existing stable CLI');
  vi.stubEnv('STROQ_HOME', f.options.stroqHome);
  vi.spyOn(process, 'cwd').mockReturnValue(f.options.project);
  vi.spyOn(terminal, 'currentTerminal').mockReturnValue(f.terminal);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const old = process.argv[1];
  process.argv[1] = entry;
  try {
    expect(await runAdd([f.dir, '--kind', 'mcp', '--config', f.config])).toBe(0);
    const wrapper = (await f.servers())['demo'] as { args: string[] };
    expect(wrappedEntryPath(wrapper.args)).toBe(stable);
    expect(await readFile(stable, 'utf8')).toBe('// existing stable CLI');
    expect(f.prompts()).toBe(1);
  } finally {
    process.argv[1] = old!;
  }
});
