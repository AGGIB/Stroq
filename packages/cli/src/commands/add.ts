import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
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
