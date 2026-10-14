import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stroqHome } from '../paths.js';
import { parseArgsProblem, usageError } from '../help.js';
import { currentTerminal } from '../ui/terminal.js';

export async function runAdd(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
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
      },
    });
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
    const mcpOnly = ['client', 'config', 'entrypoint', 'pass-env', 'name', 'cwd', 'force'] as const;
    const invalid = mcpOnly.find((name) => parsed.values[name] !== undefined);
    if (invalid !== undefined) {
      process.stderr.write(usageError('add', `unknown option --${invalid} for --kind skill`));
      return 2;
    }
  }
  if (kind === 'mcp') {
    const { addMcp } = await import('../install/mcp-install.js');
    const { hookArgv } = await import('./init.js');
    const [node, ...entryArgv] = hookArgv(process.execPath, resolve(process.argv[1] ?? ''));
    const names = parsed.values['pass-env'];
    const added = await addMcp(parsed.positionals[0]!, {
      project: process.cwd(),
      stroqHome: stroqHome(),
      terminal: currentTerminal(),
      node: node!,
      entryArgv,
      user: parsed.values.user === true,
      restore: parsed.values.restore === true,
      ...(parsed.values.client === undefined ? {} : { client: parsed.values.client }),
      ...(parsed.values.config === undefined ? {} : { config: parsed.values.config }),
      ...(parsed.values.entrypoint === undefined ? {} : { entrypoint: parsed.values.entrypoint }),
      ...(names === undefined ? {} : { passEnv: names.split(',').filter((n) => n !== '') }),
      ...(parsed.values.name === undefined ? {} : { name: parsed.values.name }),
      ...(parsed.values.cwd === undefined ? {} : { cwd: parsed.values.cwd }),
      force: parsed.values.force === true,
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
  });
  process.stdout.write(`confirmed sha256:${added.digest}\n`);
  return 0;
}
