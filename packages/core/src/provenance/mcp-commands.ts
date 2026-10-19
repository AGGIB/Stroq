/**
 * The command lines in the arguments of an MCP call. Most of what a call carries is text (a title,
 * a body, a page), in which a runner is a mention. Some of it is a command line: an argument under a
 * key that names one, at any depth, and every argument of a tool that is a shell, a terminal or an
 * executor, since what it is given it runs. An object that has a program and a list of arguments is a
 * command line whatever the tool is called.
 */

/** Keys that name a command line, compared without regard to case. */
const COMMAND_KEYS = /^(?:command|cmd|script|shell|run|exec|args|argv|commandline)$/i;
/** Tools that run what they are given, by the words in their names. */
const EXEC_TOOL = /shell|exec|run_command|terminal|bash|cmd/i;

export const isExecStyleTool = (toolName: string): boolean => EXEC_TOOL.test(toolName);

/** The key of the program of a spawned process, and the keys of the list of its arguments. */
const PROGRAM_KEYS = /^(?:command|cmd)$/i;
const ARGUMENT_KEYS = /^(?:args|argv|arguments)$/i;

/**
 * The command line of an object that names a program and its arguments (`{command: 'npx', args:
 * ['-y', 'x']}`, the form MCP servers are configured and spawned in): the program, then the
 * arguments that are strings, joined by blanks. Undefined when it does not hold both.
 */
function spawnedLine(entries: ReadonlyArray<readonly [string, unknown]>): string | undefined {
  const program = entries.find(
    ([key, value]) => PROGRAM_KEYS.test(key) && typeof value === 'string',
  );
  const list = entries.find(([key, value]) => ARGUMENT_KEYS.test(key) && Array.isArray(value));
  if (program === undefined || list === undefined) return undefined;
  const words = (list[1] as unknown[]).filter((item): item is string => typeof item === 'string');
  return [program[1] as string, ...words].join(' ');
}

interface Pending {
  readonly value: unknown;
  readonly command: boolean;
}

/**
 * The strings of `input` that are command lines: those under a key that names one, or all of them
 * for a tool that executes (`execStyle`). A list of strings under such a key is an argv, and is
 * read joined by blanks as well as one by one. Stops after `maxChars` characters.
 */
export function commandTexts(
  input: Readonly<Record<string, unknown>>,
  execStyle: boolean,
  maxChars: number,
): string[] {
  const found: string[] = [];
  let chars = 0;
  const keep = (text: string): void => {
    found.push(text);
    chars += text.length;
  };
  const pending: Pending[] = [{ value: input, command: execStyle }];
  while (pending.length > 0 && chars < maxChars) {
    const { value, command } = pending.pop() as Pending;
    if (typeof value === 'string') {
      if (command && value !== '') keep(value);
    } else if (Array.isArray(value)) {
      if (command && value.length > 1 && value.every((item) => typeof item === 'string'))
        keep(value.join(' '));
      for (let i = value.length - 1; i >= 0; i -= 1) pending.push({ value: value[i], command });
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      const spawned = spawnedLine(entries);
      if (spawned !== undefined) keep(spawned);
      for (const [key, item] of entries)
        pending.push({ value: item, command: command || COMMAND_KEYS.test(key) });
    }
  }
  return found;
}
