// What to run when the stored copy of an installed skill or server is damaged.
//
// A damaged copy can be neither restored nor compared with, and removing it needs no bytes, so the way out is to remove
// it with `--force` and add it again from its source. The commands are built from the lock record, so that they put it
// back where and as it was: a server in the same client config, with the same start file, variables and directory; a
// skill in the same scope. They are text for a person to read and paste, and everything that comes from the lock goes
// through `commandLine`, since a path in a lock is not trusted text.
import { resolve } from 'node:path';
import { quoteWord, tryCommandLine, unprintableSentence } from '../shell-quote.js';

/** What of an MCP record the commands need. */
export interface McpRemedyRecord {
  readonly source: string;
  readonly config: string;
  readonly entrypoint: string;
  readonly passEnv: readonly string[];
  readonly cwd?: string;
}

/** What of a skill record the commands need, and where the person is: a project skill is added from its project. */
export interface SkillRemedyRecord {
  readonly source: string;
  readonly root: string;
}
export interface SkillRemedyPlace {
  readonly home: string;
  readonly project: string;
}

type Printed = ReturnType<typeof tryCommandLine>;

/**
 * The two commands, or one element with the sentence that says why there is none: a command that cannot be printed
 * safely is not printed with a stand-in, and the other one is not printed alone.
 */
function bothOrSentence(first: Printed, second: Printed): readonly string[] {
  for (const printed of [first, second])
    if (printed.line === null) return [unprintableSentence(printed.unprintable)];
  return [first.line!, second.line!];
}

/** `stroq remove <name> --kind mcp --force` and `stroq add <source> --kind mcp` with what the record holds. */
export function mcpRemedyCommands(name: string, record: McpRemedyRecord): readonly string[] {
  const remove = tryCommandLine([
    'stroq',
    'remove',
    { positional: name, what: 'name' },
    '--kind',
    'mcp',
    '--force',
  ]);
  const add = tryCommandLine([
    'stroq',
    'add',
    { positional: record.source, what: 'path' },
    '--kind',
    'mcp',
    { flag: '--name', value: name, what: 'name' },
    { flag: '--config', value: record.config, what: 'path' },
    { flag: '--entrypoint', value: record.entrypoint, what: 'path' },
    ...(record.passEnv.length > 0
      ? [{ flag: '--pass-env', value: record.passEnv.join(','), what: 'name' } as const]
      : []),
    ...(record.cwd === undefined
      ? []
      : [{ flag: '--cwd', value: record.cwd, what: 'path' } as const]),
  ]);
  return bothOrSentence(remove, add);
}

/** The two commands for a server, as one sentence. */
export const mcpRemedy = (name: string, record: McpRemedyRecord): string =>
  mcpRemedyCommands(name, record).join(', then ');

/** `stroq remove <name> --force` and `stroq add <source>`, in the scope the skill is in. */
export function skillRemedyCommands(
  name: string,
  record: SkillRemedyRecord,
  place: SkillRemedyPlace,
): readonly string[] {
  const user = resolve(record.root) === resolve(place.home);
  return bothOrSentence(
    tryCommandLine(['stroq', 'remove', { positional: name, what: 'name' }, '--force']),
    tryCommandLine([
      'stroq',
      'add',
      { positional: record.source, what: 'path' },
      ...(user ? ['--user'] : []),
    ]),
  );
}

/** The two commands for a skill, as one sentence; a skill of another project is added from that project's folder. */
export function skillRemedy(
  name: string,
  record: SkillRemedyRecord,
  place: SkillRemedyPlace,
): string {
  const root = resolve(record.root);
  const elsewhere = root !== resolve(place.home) && root !== resolve(place.project);
  const commands = skillRemedyCommands(name, record, place);
  if (commands.length !== 2) return commands.join(', then ');
  const folder = elsewhere ? quoteWord(root) : '';
  if (folder === null) return unprintableSentence('path');
  return `${commands[0]}, then ${elsewhere ? `from the folder ${folder} ` : ''}${commands[1]}`;
}
