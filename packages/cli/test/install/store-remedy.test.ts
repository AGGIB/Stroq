import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { describe, expect, it } from 'vitest';
import { unknownOption } from '../../src/help.js';
import { readPassports } from '../../src/install/lock.js';
import { addMcp, removeMcp, type McpInstallOptions } from '../../src/install/mcp-install.js';
import { mcpRemedy, skillRemedy } from '../../src/install/remedy.js';
import { addSkill } from '../../src/install/skill-install.js';
import { storePath } from '../../src/install/store.js';
import { mcpFixture, mcpServer } from '../helpers/mcp-install.js';
import { setup } from '../helpers/skill-install.js';

/**
 * When the stored copy of an installed server or skill is damaged, the error names two commands: remove it with
 * --force, add it again from its source. They are built from the lock record, so they are lines that can be run
 * and that put it back as it was (the client config, start file, variables and directory of a server; the scope of
 * a skill), and not the first words of advice.
 */

/** The words of a printed command line, read as a POSIX shell reads single quotes and a backslash. */
function words(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') {
      i += 1;
      continue;
    }
    let word = '';
    while (i < line.length && line[i] !== ' ') {
      if (line[i] === "'") {
        i += 1;
        while (line[i] !== "'") word += line[i++];
        i += 1;
      } else if (line[i] === '\\') {
        word += line[i + 1];
        i += 2;
      } else word += line[i++];
    }
    out.push(word);
  }
  return out;
}

/** The two commands in an error message: what follows "run ", split at ", then ". */
function commandsIn(error: unknown): [string[], string[]] {
  const message = (error as Error).message;
  const [, tail] = /; run (.*)$/s.exec(message)!;
  const [remove, add] = tail!.split(/, then (?:from the folder \S+ )?/);
  return [words(remove!), words(add!)];
}

const ADD_OPTIONS = {
  user: { type: 'boolean' },
  restore: { type: 'boolean' },
  kind: { type: 'string' },
  client: { type: 'string' },
  config: { type: 'string' },
  entrypoint: { type: 'string' },
  'pass-env': { type: 'string' },
  name: { type: 'string' },
  cwd: { type: 'string' },
  force: { type: 'boolean' },
} as const;

/** What `stroq add <argv>` hands to `addMcp`, the way commands/add.ts reads it. */
function mcpOptionsOf(argv: string[], base: McpInstallOptions) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: ADD_OPTIONS,
  });
  const names = values['pass-env'];
  return {
    source: positionals[0]!,
    kind: values.kind,
    options: {
      ...base,
      ...(values.config === undefined ? {} : { config: values.config }),
      ...(values.entrypoint === undefined ? {} : { entrypoint: values.entrypoint }),
      ...(names === undefined ? {} : { passEnv: names.split(',') }),
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
    } satisfies McpInstallOptions,
  };
}

async function damagedServer(over: { folder?: string; passEnv?: string[]; cwd?: string } = {}) {
  const f = await mcpFixture();
  const dir = over.folder === undefined ? f.dir : await mcpServer(f.root, {}, {}, over.folder);
  const config = join(f.root, 'my configs', "it's here.json");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify({ mcpServers: {} }));
  const options = {
    ...f.mcpOptions,
    config,
    entrypoint: 'server.js',
    passEnv: over.passEnv ?? ['API_KEY', 'TOKEN'],
    cwd: over.cwd ?? join(f.root, 'project'),
  };
  const record = await addMcp(dir, options);
  await appendFile(join(storePath(f.options.stroqHome, record.digest), 'tree', 'server.js'), '//');
  const failure = await addMcp('demo', { ...f.mcpOptions, config }).then(
    () => null,
    (error: unknown) => error,
  );
  return { f, dir, config, options, record, failure };
}

describe('an MCP server whose stored copy is damaged', () => {
  it('is told the two commands, with only flags that remove and add accept', async () => {
    const { failure } = await damagedServer();
    const [remove, add] = commandsIn(failure);

    expect(remove).toEqual(['stroq', 'remove', 'demo', '--kind', 'mcp', '--force']);
    expect(unknownOption('remove', remove.slice(2))).toBeNull();
    expect(add.slice(0, 2)).toEqual(['stroq', 'add']);
    expect(unknownOption('add', add.slice(2))).toBeNull();
    expect(add).toEqual(
      expect.arrayContaining(['--kind', 'mcp', '--name', 'demo', '--entrypoint', 'server.js']),
    );
  });

  it('is put back as it was by running them: the same config, start file, variables and directory', async () => {
    const { f, dir, config, options, record, failure } = await damagedServer();
    const [remove, add] = commandsIn(failure);
    expect(remove.at(-1)).toBe('--force');

    await removeMcp('demo', { ...f.mcpOptions, force: true });
    const { source, kind, options: again } = mcpOptionsOf(add, f.mcpOptions);
    const second = await addMcp(source, again);

    expect(kind).toBe('mcp');
    expect(source).toBe(resolve(dir));
    expect(second).toMatchObject({
      source: record.source,
      config: record.config,
      entrypoint: record.entrypoint,
      passEnv: ['API_KEY', 'TOKEN'],
      cwd: options.cwd,
    });
    expect(second.config).toBe(config);
    expect((await readPassports(f.options.stroqHome)).mcp?.['demo']).toMatchObject({
      status: 'confirmed',
    });
  });

  it('keeps the cause: the error the store reported', async () => {
    const { failure } = await damagedServer();

    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).not.toBe('');
  });

  it('prints a path with a control character in the lock as a placeholder, never as itself', async () => {
    const { failure } = await damagedServer({ folder: 'srv\u001b[2J\u202e' });
    const message = (failure as Error).message;

    expect(message).not.toMatch(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/,
    );
    expect(message).toContain('stroq add <unprintable-path> --kind mcp');
    expect(message).not.toContain('[2J');
  });
});

describe('the commands for an MCP record', () => {
  const record = {
    source: '/src/a server',
    config: '/etc/client.json',
    entrypoint: 'dist/main.js',
    passEnv: [],
  };

  it('leave out --pass-env when the server may see none, and --cwd when the record has none', () => {
    const line = mcpRemedy('demo', record);

    expect(line).not.toContain('--pass-env');
    expect(line).not.toContain('--cwd');
    expect(line).toBe(
      "stroq remove demo --kind mcp --force, then stroq add '/src/a server' --kind mcp --name demo --config /etc/client.json --entrypoint dist/main.js",
    );
  });

  it('quote a variable list, a directory and a source for a shell', () => {
    const line = mcpRemedy('demo', {
      ...record,
      passEnv: ['A', 'B'],
      cwd: "/my dir/it's",
    });

    expect(line).toContain('--pass-env A,B');
    expect(line).toContain(`--cwd '/my dir/it'\\''s'`);
  });
});

describe('a skill whose stored copy is damaged', () => {
  async function damagedSkill(user: boolean) {
    const f = await setup();
    const record = await addSkill(f.source, { ...f.options, user });
    await appendFile(join(storePath(f.options.stroqHome, record.digest), 'tree', 'SKILL.md'), 'x');
    await writeFile(join(f.source, 'README.md'), 'more\n');
    const failure = await addSkill('demo', { ...f.options, user }).then(
      () => null,
      (error: unknown) => error,
    );
    return { f, record, failure };
  }

  it('in the project is told to remove it with --force and add it from its source, with no --user', async () => {
    const { f, failure } = await damagedSkill(false);
    const [remove, add] = commandsIn(failure);

    expect(remove).toEqual(['stroq', 'remove', 'demo', '--force']);
    expect(add).toEqual(['stroq', 'add', f.source]);
    expect(unknownOption('remove', remove.slice(2))).toBeNull();
    expect(unknownOption('add', add.slice(2))).toBeNull();
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it('in the home is told to add it with --user', async () => {
    const { f, failure } = await damagedSkill(true);
    const [, add] = commandsIn(failure);

    expect(add).toEqual(['stroq', 'add', f.source, '--user']);
    expect(unknownOption('add', add.slice(2))).toBeNull();
  });

  it('in another project is told to add it from that folder', () => {
    const line = skillRemedy(
      'demo',
      { source: '/src/demo', root: '/work/app' },
      { home: '/home/u', project: '/work/other' },
    );

    expect(line).toBe(
      'stroq remove demo --force, then from the folder /work/app stroq add /src/demo',
    );
  });

  it('is told the same when the whole copy is gone and it is restored', async () => {
    const { f, record } = await damagedSkill(false);
    await rm(storePath(f.options.stroqHome, record.digest), { recursive: true, force: true });

    await expect(addSkill('demo', { ...f.options, restore: true })).rejects.toThrow(
      /stroq remove demo --force, then stroq add /,
    );
  });
});
