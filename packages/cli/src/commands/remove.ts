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
      options: { force: { type: 'boolean' }, kind: { type: 'string' }, user: { type: 'boolean' } },
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
  const kind = parsed.values.kind ?? 'skill';
  if (kind !== 'skill' && kind !== 'mcp') {
    process.stderr.write(usageError('remove', '--kind is skill or mcp'));
    return 2;
  }
  if (kind === 'mcp') {
    if (parsed.values.user !== undefined) {
      process.stderr.write(usageError('remove', 'unknown option --user for --kind mcp'));
      return 2;
    }
    const { removeMcp } = await import('../install/mcp-install.js');
    await removeMcp(parsed.positionals[0]!, {
      project: process.cwd(),
      stroqHome: stroqHome(),
      terminal: currentTerminal(),
      node: process.execPath,
      entryArgv: [],
      force: parsed.values.force === true,
    });
    process.stdout.write('MCP server removed; client config restored\n');
    return 0;
  }
  const { removeSkill } = await import('../install/skill-install.js');
  await removeSkill(parsed.positionals[0]!, {
    project: process.cwd(),
    home: homedir(),
    stroqHome: stroqHome(),
    terminal: currentTerminal(),
    force: parsed.values.force === true,
    user: parsed.values.user === true,
  });
  process.stdout.write('skill removed; receipt recorded\n');
  return 0;
}
