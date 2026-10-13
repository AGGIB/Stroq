import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { stroqHome } from '../paths.js';
import { parseArgsProblem, usageError } from '../help.js';
import { currentTerminal } from '../ui/terminal.js';

export async function runRemove(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { force: { type: 'boolean' } },
    });
  } catch (error) {
    const problem = parseArgsProblem(error);
    if (problem === null) throw error;
    process.stderr.write(usageError('remove', problem));
    return 2;
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] === '') {
    process.stderr.write(usageError('remove', 'give the name of one installed skill'));
    return 2;
  }
  const { removeSkill } = await import('../install/skill-install.js');
  await removeSkill(parsed.positionals[0]!, {
    project: process.cwd(),
    home: homedir(),
    stroqHome: stroqHome(),
    terminal: currentTerminal(),
    force: parsed.values.force === true,
  });
  process.stdout.write('skill removed; receipt recorded\n');
  return 0;
}
