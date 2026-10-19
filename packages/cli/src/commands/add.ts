import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cliDirIn, stroqHome, storeDirIn, runDirIn } from '../paths.js';
import { parseArgsProblem, usageError } from '../help.js';
import { currentTerminal } from '../ui/terminal.js';

/** The options of the command, written out here where the tests of the printed command lines read them too. */
export const ADD_OPTIONS = {
  user: { type: 'boolean' },
  restore: { type: 'boolean' },
  rollback: { type: 'boolean' },
  kind: { type: 'string' },
  client: { type: 'string' },
  config: { type: 'string' },
  entrypoint: { type: 'string' },
  'pass-env': { type: 'string' },
  name: { type: 'string' },
  cwd: { type: 'string' },
  force: { type: 'boolean' },
  strict: { type: 'boolean' },
} as const;

export async function runAdd(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, options: ADD_OPTIONS });
  } catch (error) {
    const problem = parseArgsProblem(error);
    if (problem === null) throw error;
    process.stderr.write(usageError('add', problem));
    return 2;
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] === '') {
    process.stderr.write(
      usageError('add', 'give one local skill directory, archive, or installed name'),
    );
    return 2;
  }
  const kind = parsed.values.kind ?? 'skill';
  if (kind !== 'skill' && kind !== 'mcp') {
    process.stderr.write(usageError('add', '--kind is skill or mcp'));
    return 2;
  }
  if (kind === 'skill') {
    const mcpOnly = [
      'client',
      'config',
      'entrypoint',
      'pass-env',
      'name',
      'cwd',
      'force',
      'strict',
    ] as const;
    const invalid = mcpOnly.find((name) => parsed.values[name] !== undefined);
    if (invalid !== undefined) {
      process.stderr.write(usageError('add', `unknown option --${invalid} for --kind skill`));
      return 2;
    }
  }
  if (kind === 'mcp') {
    const { addMcp } = await import('../install/mcp-install.js');
    const { hookArgv, stableEntry, runsFromNpxCache } = await import('./init.js');
    const { stroqVersion } = await import('../version.js');
    const home = stroqHome();
    const { assertPlainDirectory } = await import('../install/store.js');
    for (const folder of [home, storeDirIn(home), runDirIn(home)])
      await assertPlainDirectory(folder);
    const launched = resolve(process.argv[1] ?? '');
    const version = stroqVersion();
    const unstable =
      'cannot create a stable Stroq entry outside the npx cache; install globally with npm install -g @stroq/cli and run stroq add again';
    if (runsFromNpxCache(launched)) {
      // The copy may replace a version directory; never follow a linked destination.
      try {
        for (const folder of [cliDirIn(home), join(cliDirIn(home), version)])
          await assertPlainDirectory(folder);
      } catch (error) {
        throw new Error(unstable, { cause: error });
      }
    }
    const entry = stableEntry(launched, home, version);
    if (runsFromNpxCache(entry)) throw new Error(unstable);
    const [node, ...entryArgv] = hookArgv(process.execPath, entry);
    const names = parsed.values['pass-env'];
    const added = await addMcp(parsed.positionals[0]!, {
      project: process.cwd(),
      stroqHome: home,
      terminal: currentTerminal(),
      node: node!,
      entryArgv,
      user: parsed.values.user === true,
      restore: parsed.values.restore === true,
      rollback: parsed.values.rollback === true,
      ...(parsed.values.client === undefined ? {} : { client: parsed.values.client }),
      ...(parsed.values.config === undefined ? {} : { config: parsed.values.config }),
      ...(parsed.values.entrypoint === undefined ? {} : { entrypoint: parsed.values.entrypoint }),
      ...(names === undefined ? {} : { passEnv: names.split(',').filter((n) => n !== '') }),
      ...(parsed.values.name === undefined ? {} : { name: parsed.values.name }),
      ...(parsed.values.cwd === undefined ? {} : { cwd: parsed.values.cwd }),
      force: parsed.values.force === true,
      ...(parsed.values.strict === undefined ? {} : { strict: parsed.values.strict }),
    });
    process.stdout.write(`confirmed sha256:${added.digest}\n`);
    return 0;
  }
  const { addSkill } = await import('../install/skill-install.js');
  const added = await addSkill(parsed.positionals[0]!, {
    project: process.cwd(),
    home: homedir(),
    stroqHome: stroqHome(),
    terminal: currentTerminal(),
    user: parsed.values.user === true,
    restore: parsed.values.restore === true,
    rollback: parsed.values.rollback === true,
    // Only what the person said: without --kind the files tell what the folder is.
    ...(parsed.values.kind === 'skill' ? { kind: 'skill' as const } : {}),
  });
  process.stdout.write(`confirmed sha256:${added.digest}\n`);
  return 0;
}
