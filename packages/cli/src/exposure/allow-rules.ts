/**
 * Whether an allow rule hands the agent the whole shell: it lets a program run without asking
 * that runs whatever it is given, or its pattern is a wildcard however it is spelled. Coarse on
 * purpose: `Bash(python3 -m pytest:*)` counts, since python runs any code the agent writes.
 *
 * Each step is an index search or a split, so the work is linear in the rule's length.
 */

/** Shells, wrappers that run the command after them, and interpreters. */
const RUNS_ANYTHING: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'fish',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'busybox',
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'nohup',
  'timeout',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'command',
  'builtin',
  'exec',
  'eval',
  'time',
  'watch',
  'script',
  'parallel',
  'unbuffer',
  'caffeinate',
  'chroot',
  'python',
  'python2',
  'python3',
  'py',
  'pypy',
  'pypy3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'ruby',
  'irb',
  'perl',
  'php',
  'lua',
  'luajit',
  'tclsh',
  'osascript',
  'awk',
  'gawk',
  'rscript',
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'pipx',
]);

/** Package managers, and their subcommands that fetch a package, or start any program, and run it. */
const RUNS_A_PACKAGE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['npm', new Set(['exec', 'x'])],
  ['pnpm', new Set(['exec', 'dlx'])],
  ['yarn', new Set(['exec', 'dlx'])],
  ['uv', new Set(['run', 'tool'])],
]);

/** `word` without the quotes around it: one pass from each end. */
function unquoted(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && (word[start] === '"' || word[start] === "'")) start += 1;
  while (end > start && (word[end - 1] === '"' || word[end - 1] === "'")) end -= 1;
  return word.slice(start, end);
}

/** The program a word names, as a shell finds it: its last part, in lower case, no extension. */
const programName = (word: string): string =>
  word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/, '');

const isWildcardOnly = (pattern: string): boolean => pattern.replace(/[*?:\s]/g, '') === '';

/**
 * Whether a command pattern (what is inside `Bash(...)`) lets any command run: a wildcard, a
 * program that runs anything, or a program name that is itself a wildcard.
 */
export function patternRunsAnything(pattern: string): boolean {
  if (isWildcardOnly(pattern)) return true;
  // `prefix:*` is the older spelling of a prefix: the program is the first word, before a blank
  // or that `:`.
  const words = pattern.trim().split(/\s+/);
  const head = words[0] ?? '';
  // Past the `:` of a Windows drive, `C:\bin\sh.exe:*`.
  const colon = head.indexOf(':', /^[A-Za-z]:[\\/]/.test(head) ? 2 : 0);
  const first = unquoted(colon === -1 ? head : head.slice(0, colon));
  if (/[*?[]/.test(first)) return true;
  const name = programName(first);
  if (RUNS_ANYTHING.has(name)) return true;
  const second = colon === -1 ? (words[1] ?? '') : '';
  return RUNS_A_PACKAGE.get(name)?.has(unquoted(second.split(':')[0] ?? '').toLowerCase()) ?? false;
}

/**
 * Whether one allow rule hands the agent the whole shell, for the shell tools named in `tools`
 * (`Bash`, or Gemini's `run_shell_command`): the tool alone, the tool with a pattern that runs
 * anything, or a tool name that is a wildcard (`*`, `mcp__*`), which takes in the shell tool too.
 */
export function ruleRunsAnything(rule: string, tools: ReadonlySet<string>): boolean {
  const text = rule.trim();
  const open = text.indexOf('(');
  const tool = (open === -1 ? text : text.slice(0, open)).trim();
  if (/[*?]/.test(tool)) return true;
  if (!tools.has(tool.toLowerCase())) return false;
  if (open === -1) return true;
  const close = text.lastIndexOf(')');
  const pattern = text.slice(open + 1, close > open ? close : undefined);
  return patternRunsAnything(pattern);
}
