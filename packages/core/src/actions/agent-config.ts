/**
 * What an agent writes into the files its own host loads: an MCP server list, and an
 * agent definition that carries hooks.
 *
 * `INSTRUCTION_FILE` already names those files, and a write to one is asked about when
 * the session is tainted. That is not enough for the two shapes below, because the page
 * or issue that steers the agent to write them is, by the design of the attacks, one
 * the scan calls clean (Kiro, CVE-2026-10591: hidden text on a web page asks the agent
 * to register a "telemetry" server, and the write needs no approval). So the TEXT being
 * written is read as well, and a server entry that starts a shell, or an inline
 * interpreter, is a payload whatever the session has read.
 */

/** MCP client configuration files, by the name the client reads. */
const MCP_CONFIG_PATH =
  /(?:^|[/\\])(?:\.mcp\.json|mcp_config\.json|claude_desktop_config\.json|mcp\.json)$|(?:^|[/\\])\.gemini[/\\]+settings\.json$/i;

/**
 * Agent definitions a host loads and runs hooks from: Copilot, Claude Code (subagents,
 * and the skills and commands whose frontmatter takes `hooks:` as well), Kiro.
 */
const AGENT_DEFINITION_PATH =
  /(?:^|[/\\])\.(?:github|claude|kiro|agent|agents)[/\\]+(?:agents|hooks)[/\\]|(?:^|[/\\])\.claude[/\\]+(?:skills|commands)[/\\]/i;

/**
 * The most text these files are read for. A configuration this big is not one, and a text
 * that is past it is asked about rather than passed: padding ahead of the entry would
 * otherwise be a way to hide it.
 */
const MAX_CONFIG_TEXT_CHARS = 4 * 1024 * 1024;

export const isMcpConfigPath = (path: string): boolean => MCP_CONFIG_PATH.test(path);
export const isAgentDefinitionPath = (path: string): boolean => AGENT_DEFINITION_PATH.test(path);

/** What a command is called, as the shell would find it: no directory, no `.exe`, lower case. */
const programName = (command: string): string =>
  command
    .replace(/^.*[/\\]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();

const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
]);

/** The letters of a short option (`-lc` → `lc`), or undefined for anything else. */
const optionLetters = (arg: string): string | undefined => /^-([A-Za-z]{1,64})$/.exec(arg)?.[1];
const lettersInclude =
  (wanted: RegExp) =>
  (arg: string): boolean => {
    const letters = optionLetters(arg);
    return letters !== undefined && wanted.test(letters);
  };

/**
 * The flags that hand a program its code on the command line, per interpreter. A letter
 * that means something else to another one is not matched there: `bash -e` is errexit and
 * `python -E` ignores the environment. The letters are captured and then tested: a pattern
 * of the form `-[A-Za-z]*c[A-Za-z]*` splits one long word two ways, and 64 KiB of `-cccc…`
 * took 4.6 s.
 */
const INLINE_CODE_FLAG: Readonly<Record<string, (arg: string) => boolean>> = {
  shell: lettersInclude(/c/),
  cmd: (arg) => /^\/[ck]$/i.test(arg),
  powershell: (arg) => /^-(?:c|command|encodedcommand|enc|ec)$/i.test(arg),
  node: (arg) => lettersInclude(/[ep]/)(arg) || /^--(?:eval|print)(?:=|$)/.test(arg),
  python: lettersInclude(/c/),
  ruby: lettersInclude(/e/),
  perl: lettersInclude(/[eE]/),
};
/** The interpreters, and which table of flags each takes. */
const INTERPRETER_FAMILY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:node|bun)[\d.]*$/, 'node'],
  [/^python[\d.]*$/, 'python'],
  [/^ruby[\d.]*$/, 'ruby'],
  [/^perl[\d.]*$/, 'perl'],
];
/** Flags of an interpreter whose next word is a value, not the program: `node --require x.js -e …`. */
const VALUE_FLAG = /^(?:-r|--require|--import|--loader|--experimental-loader|-W|-X|-I)$/;
/** `npx -c "cmd"`, `npm exec --call "cmd"`: a package runner that hands its argument to a shell. */
const RUNNER_SHELL_FLAG = /^(?:-c|--call)(?:=.*)?$/;
/** The one thing a shell wrapper is for in a real server entry: starting a package runner. */
const PACKAGE_RUNNER =
  /^(?:npx|uvx|bunx|pnpx|npm\s+exec|pnpm\s+dlx|yarn\s+dlx|deno\s+run|docker\s+run)\b[^;&|`$()<>\r\n]*$/i;
/** What a wrapper may do before it starts the runner: load nvm, move into the project, set a variable. */
/**
 * What a wrapper may do before it starts the runner: load the user's own shell setup (nvm,
 * a profile, cargo's env), move into a directory, set a variable. Sourcing any other file is
 * running it: `source /tmp/x.sh && npx pkg` is a script with a runner after it.
 */
const SOURCED_SETUP =
  /^(?:source|\.)\s+["']?(?:~|\$HOME|\$\{HOME\}|\$NVM_DIR|\$\{NVM_DIR\})\/(?:[\w.-]{1,64}\/){0,4}(?:nvm\.sh|\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile|env|asdf\.sh)["']?$/;
const WRAPPER_SETUP = /^(?:cd\s+[\w./~$"'-]+|export\s+\w+=[\w./:@-]*)$/;

/** True for `[setup &&]* runner args`: nothing but known setup steps before a package runner. */
function isPackageRunnerPayload(payload: string): boolean {
  const steps = payload.split('&&').map((step) => step.trim());
  const runner = steps.pop() ?? '';
  return (
    PACKAGE_RUNNER.test(runner) &&
    steps.every((step) => WRAPPER_SETUP.test(step) || SOURCED_SETUP.test(step))
  );
}

const FRAGMENT_SHELL_SERVER =
  /"command"\s*:\s*"(?:[^"\n]*[/\\])?(?:(?:sh|bash|zsh|dash|ksh|fish)(?:\.exe)?|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|env)"/i;
const FRAGMENT_INLINE_SERVER =
  /"command"\s*:\s*"(?:[^"\n]*[/\\])?(?:node|python[\d.]*|ruby|perl|bun|deno)(?:\.exe)?"/i;
const FRAGMENT_INLINE_ARGS = /"args"\s*:\s*\[\s*"(-[A-Za-z]{1,64}|--eval|--print|eval)"/i;
/** Whether the first argument of a fragment hands the program its code (see `INLINE_CODE_FLAG`). */
function fragmentInlineArgs(text: string): boolean {
  const first = FRAGMENT_INLINE_ARGS.exec(text)?.[1];
  if (first === undefined) return false;
  const letters = optionLetters(first);
  return letters === undefined || /[ecEp]/.test(letters);
}

interface ServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

/** Every object with a string `command`, wherever it sits, read without recursion. */
function serverEntries(root: unknown): ServerEntry[] {
  const entries: ServerEntry[] = [];
  const stack: unknown[] = [root];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record['command'] === 'string') {
      const args = Array.isArray(record['args'])
        ? record['args'].filter((a): a is string => typeof a === 'string')
        : [];
      entries.push({ command: record['command'], args });
    }
    for (const child of Object.values(record)) stack.push(child);
  }
  return entries;
}

/**
 * `env bash -c …` is `bash -c …`: look through the wrapper to the program it starts, past
 * its own options, including the ones that take a value (`-u NAME`, `-C dir`) and `-S`,
 * which splits one string into the program and its arguments.
 */
function throughEnv(entry: ServerEntry): ServerEntry {
  if (programName(entry.command) !== 'env') return entry;
  const args = entry.args;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') {
      const program = args[i + 1];
      return program === undefined ? entry : { command: program, args: args.slice(i + 2) };
    }
    const split =
      arg === '-S' || arg === '--split-string'
        ? args[i + 1]
        : /^(?:-S|--split-string=)(.+)$/.exec(arg)?.[1];
    if (split !== undefined) {
      const words = split.trim().split(/\s+/);
      const skip = arg === '-S' || arg === '--split-string' ? 2 : 1;
      return { command: words[0] ?? '', args: [...words.slice(1), ...args.slice(i + skip)] };
    }
    if (/^-(?:u|C|P)$/.test(arg) || arg === '--unset' || arg === '--chdir') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-') || /^\w+=/.test(arg)) continue;
    return { command: arg, args: args.slice(i + 1) };
  }
  return entry;
}

/**
 * Where the program's own code is given on the command line, or -1. Only the flags BEFORE
 * the script count: in `node server.js -p 3000` and `python3 -m my_server -e prod` the
 * `-p` and `-e` are the server's options, not the interpreter's.
 */
function inlineCodeAt(
  args: readonly string[],
  flag: (arg: string) => boolean,
  slashOptions = false,
): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (flag(arg)) return i;
    if (VALUE_FLAG.test(arg)) {
      i += 1;
      continue;
    }
    // `/c` is an option only to cmd; to anything else `/Users/me/srv/index.js` is the script.
    const option = arg.startsWith('-') || (slashOptions && arg.startsWith('/'));
    if (arg === '-m' || !option) return -1;
  }
  return -1;
}

function startsCode(raw: ServerEntry): boolean {
  const entry = throughEnv(raw);
  const name = programName(entry.command);
  if (SHELLS.has(name)) {
    const family = name === 'cmd' || name === 'powershell' || name === 'pwsh' ? name : 'shell';
    const flag = INLINE_CODE_FLAG[family === 'pwsh' ? 'powershell' : family] as (
      arg: string,
    ) => boolean;
    const inlineAt = inlineCodeAt(entry.args, flag, family === 'cmd');
    if (inlineAt === -1) return true;
    return !isPackageRunnerPayload(entry.args.slice(inlineAt + 1).join(' '));
  }
  // A package runner told to run a command string is a shell in all but name.
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    return entry.args.some(
      (arg, i) =>
        RUNNER_SHELL_FLAG.test(arg) && entry.args.slice(0, i).every((a) => a.startsWith('-')),
    );
  }
  if (name === 'npm' && entry.args[0] === 'exec')
    return entry.args.some((arg) => RUNNER_SHELL_FLAG.test(arg));
  // `deno eval '…'` is a subcommand, not a flag.
  if (name === 'deno') return entry.args[0] === 'eval';
  // An interpreter given its program on the command line is a one-liner nobody reviewed.
  const family = INTERPRETER_FAMILY.find(([pattern]) => pattern.test(name));
  if (family === undefined) return false;
  return inlineCodeAt(entry.args, INLINE_CODE_FLAG[family[1]] as (arg: string) => boolean) !== -1;
}

/**
 * Whether the text registers an MCP server that starts a shell or runs code given on
 * its command line. Read as JSON when it is, and with the same question put to the
 * fragment when it is not (an `Edit` writes part of a file). A text past the size these
 * files are read for is not read: it is a payload.
 */
export function mcpConfigRunsCode(path: string, text: string): boolean {
  if (!MCP_CONFIG_PATH.test(path) || text === '') return false;
  if (text.length > MAX_CONFIG_TEXT_CHARS) return true;
  try {
    return serverEntries(JSON.parse(text)).some(startsCode);
  } catch {
    return (
      FRAGMENT_SHELL_SERVER.test(text) ||
      (FRAGMENT_INLINE_SERVER.test(text) && fragmentInlineArgs(text))
    );
  }
}

/**
 * Whether an agent definition carries a `hooks:` block: frontmatter that runs a command
 * on the agent's lifecycle, which is where a prompt-injected write to `.github/agents`
 * (Copilot, GHSA pending) or `.claude/agents` plants its payload. The indent is spaces
 * and tabs only: with `\s`, which takes a newline, a text of nothing but newlines was
 * rescanned from every line and 250,000 of them took 37 s.
 */
export function agentDefinitionHasHooks(path: string, text: string): boolean {
  if (!AGENT_DEFINITION_PATH.test(path)) return false;
  if (text.length > MAX_CONFIG_TEXT_CHARS) return true;
  // In a whole file, the frontmatter is where a host reads `hooks:` from; a body line that
  // says "hooks: are cool" is prose. A fragment an Edit writes has no frontmatter to look in.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (frontmatter) return /^["']?hooks["']?[ \t]*:/m.test(frontmatter[1] as string);
  return /^[ \t]*["']?hooks["']?[ \t]*:/m.test(text);
}
