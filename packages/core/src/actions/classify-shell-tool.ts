import { classifyCommand } from './classify-bash.js';
import type { ToolClassification } from './classify-tool.js';
import { classifyCommandWrites } from './classify-written.js';
import { READING_DEADLINE_MS, withDeadline } from './deadline.js';
import { mergeClassifications } from './merge-classifications.js';
import { monitorSocket, monitorSocketHost, type MonitorSocket } from './monitor-socket.js';
import { isTooCostly } from './reading-cost.js';
import { classifyReferencedScripts } from './script-exec.js';
import { decodePrograms, newBudget } from './shell-input.js';
import { splitCommand } from './shell-segments.js';
import { commandSegments } from './shell-top-level.js';

// A tool that runs a shell command (see `shell-tools.ts`) is judged by what the command
// does; `classifyCommand` reads PowerShell syntax as well as POSIX.
const UNREADABLE_COMMAND: ToolClassification = {
  classes: ['shell.unparsed'],
  hosts: [],
  signals: ['shell-command-unreadable'],
};

const COMMAND_TOO_LARGE: ToolClassification = {
  classes: ['shell.unparsed'],
  hosts: [],
  signals: ['command-too-large'],
};

/**
 * Monitor's WebSocket mode (see `monitor-socket.ts`) has no command to read, but it is not
 * nothing: it is an outbound connection to an address the model chose. It is network-shaped
 * so that the secret guard, which runs on those alone, looks inside it, and a tainted
 * session is denied it. It keeps the class of a command Stroq could not read, so it is still
 * asked about as it was: this only adds, and no session is allowed more than it was.
 */
function classifySocket(socket: MonitorSocket): ToolClassification {
  const host = monitorSocketHost(socket.url);
  return {
    classes: ['shell.network', ...UNREADABLE_COMMAND.classes],
    hosts: host === null ? [] : [host],
    signals: [...UNREADABLE_COMMAND.signals, 'monitor-websocket'],
  };
}

/** The reading of the command went on past the clock (see `deadline.ts`): it is asked about, not read. */
const READING_TOOK_TOO_LONG: ToolClassification = {
  classes: ['shell.unparsed'],
  hosts: [],
  signals: ['reading-took-too-long'],
};

/**
 * A tool that runs a shell command (see `shell-tools.ts`), judged by what the command does.
 */
export function classifyShellTool(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): ToolClassification {
  const command = toolInput['command'];
  // A shell tool whose command Stroq cannot read is not an empty command: a host
  // that renamed the field would otherwise have every call allowed without a word.
  if (typeof command !== 'string') {
    const socket = toolName === 'Monitor' ? monitorSocket(toolInput) : null;
    return socket === null ? UNREADABLE_COMMAND : classifySocket(socket);
  }
  if (isTooCostly(command)) return COMMAND_TOO_LARGE;
  // All of what follows is one reading, and the clock runs from its first step: the split and the decoding
  // of the programs are made here, before `classifyCommand` begins its own, and are most of the work.
  return withDeadline(
    READING_DEADLINE_MS,
    () => classifyShellCommand(command, cwd),
    () => READING_TOOK_TOO_LONG,
  );
}

function classifyShellCommand(command: string, cwd: string): ToolClassification {
  // The programs the shells in it are handed on standard input (`echo X | bash`), at every
  // level of nesting and within one budget: read once, for the classes and for the scripts.
  const split = splitCommand(command);
  const budget = newBudget(command.length);
  const decoded = decodePrograms(command, budget, split);
  const typed = classifyCommand(command, cwd, 0, { decoded, budget, split });
  // Cut where the shell cuts: a segment cut out of a quoted string runs nothing
  // (`grep "x\|PIN=" deploy.sh`), and a quoted `|` does not take a file from its command.
  // The programs decoded from it run commands too, and one of them may name a script.
  const segments = [
    ...commandSegments(command, split),
    ...decoded.texts.flatMap((text) => commandSegments(text, splitCommand(text, null))),
  ];
  // A script the command runs is read as the commands it contains: the hook sees
  // `bash cleanup.sh`, and what that deletes is in the file (see `script-exec.ts`).
  const scriptTexts: string[] = [];
  const scripts = classifyReferencedScripts(segments, cwd, scriptTexts, decoded.files);
  return mergeClassifications(
    typed,
    ...(scripts === null ? [] : [scripts]),
    classifyCommandWrites(command, segments, cwd),
    ...(scriptTexts.length === 0
      ? []
      : [{ classes: [], hosts: [], signals: [], scripts: scriptTexts }]),
  );
}
