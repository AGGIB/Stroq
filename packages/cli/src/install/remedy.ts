// What to run when the stored copy of an installed skill or server is damaged.
//
// A damaged copy can be neither restored nor compared with, and removing it needs no bytes, so the way out is to remove
// it with `--force` and add it again from its source. The commands are built from the lock record, so that they put it
// back where and as it was: a server in the same client config, with the same start file, variables and directory; a
// skill in the same scope. They are text for a person to read and paste, and everything that comes from the lock goes
// through `commandWord`, since a path in a lock is not trusted text.
import { resolve } from 'node:path';
import { commandWord } from '../shell-word.js';

/** The most of a path or a name that is quoted into a command. */
const PATH_UNITS = 1024;
const word = (text: string): string => commandWord(text, PATH_UNITS);

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

/** `stroq remove <name> --kind mcp --force`, then `stroq add <source> --kind mcp` with what the record holds. */
export function mcpRemedy(name: string, record: McpRemedyRecord): string {
  const flags = [
    `--kind mcp`,
    `--name ${word(name)}`,
    `--config ${word(record.config)}`,
    `--entrypoint ${word(record.entrypoint)}`,
    ...(record.passEnv.length > 0 ? [`--pass-env ${word(record.passEnv.join(','))}`] : []),
    ...(record.cwd === undefined ? [] : [`--cwd ${word(record.cwd)}`]),
  ];
  return `stroq remove ${word(name)} --kind mcp --force, then stroq add ${word(record.source)} ${flags.join(' ')}`;
}

/** `stroq remove <name> --force`, then `stroq add <source>`, in the scope the skill is in. */
export function skillRemedy(
  name: string,
  record: SkillRemedyRecord,
  place: SkillRemedyPlace,
): string {
  const root = resolve(record.root);
  const user = root === resolve(place.home);
  const elsewhere = !user && root !== resolve(place.project);
  const add = `stroq add ${word(record.source)}${user ? ' --user' : ''}`;
  return `stroq remove ${word(name)} --force, then ${elsewhere ? `from the folder ${word(root)} ` : ''}${add}`;
}
