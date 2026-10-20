/**
 * Whether an allow rule hands the agent more than it can ask for one call at a time: the whole
 * shell, files outside the repository, or the network. A rule for the shell is broad unless its
 * program is one known to run, write and send nothing, and, for git and a package manager, its
 * subcommand is one of the few known to do none of that either. Every other program counts: a
 * shell, an interpreter, a runner, an editor (`vim` runs `:!sh`), `find` (`-exec`), `sed` (its `e`
 * flag), `curl`, `cp` or `tee`, which write or send what they are given, and a program not known.
 *
 * Each step is an index search or a split, so the work is linear in the rule's length.
 */

/** Programs that, whatever they are given, only read and print: they run, write and send nothing. */
const READS_ONLY: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'grep',
  'egrep',
  'fgrep',
  'head',
  'tail',
  'wc',
  'pwd',
  'which',
  'stat',
  'du',
  'df',
]);

/** Programs that print what they are given, and so do nothing else only when the rule is exact. */
const PRINTS: ReadonlySet<string> = new Set(['echo', 'printf', 'true', 'date', 'whoami']);

/**
 * Package managers and git, and their subcommands known to run no script, package, hook or
 * program a config names, and to write no file, whatever follows them. A package manager whose
 * every command loads code from the repository (`yarn` and its `yarnPath`, `cargo` and its
 * aliases, `bundle` and its Gemfile) is not here at all.
 */
const SAFE_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (
    [
      [
        ['npm', 'pnpm'],
        [
          'ls',
          'list',
          'why',
          'outdated',
          'view',
          'info',
          'show',
          'whoami',
          'ping',
          'search',
          'prefix',
          'root',
          'bin',
        ],
      ],
      [
        ['pip', 'pip3'],
        ['list', 'show', 'freeze', 'check', 'inspect'],
      ],
      [['go'], ['version']],
      [['gem'], ['list', 'info']],
      [['git'], ['status', 'rev-parse', 'ls-files', 'ls-tree']],
    ] as const
  ).flatMap(([names, safe]) => names.map((name) => [name, new Set<string>(safe)] as const)),
);

/**
 * Git subcommands that read and print, and run nothing and write nothing with the options a rule
 * is exact about. Only an exact rule is read so: a wildcard lets the agent add `-p` (which runs
 * the diff programs a config names), `--output` (which writes a file anywhere) or `-O` (which
 * opens a pager).
 */
const GIT_READS: ReadonlySet<string> = new Set([
  'log',
  'diff',
  'show',
  'blame',
  'describe',
  'shortlog',
  'branch',
  'tag',
  'remote',
]);

/** Options of those git subcommands known to change nothing but what is printed. */
const GIT_PLAIN_OPTION =
  /^(?:--(?:oneline|stat|shortstat|numstat|name-only|name-status|graph|decorate|all|short|porcelain|cached|staged|no-ext-diff|no-textconv|abbrev-ref|show-toplevel|list|no-color|no-pager)|-[sbvarln]|-vv|-\d{1,4}|-n\d{1,4}|--max-count=\d{1,4})$/;

/** The program a word names, as a shell finds it: its last part, in lower case, no extension. */
const programName = (word: string): string =>
  word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/, '');

const isWildcardOnly = (pattern: string): boolean => pattern.replace(/[*?:\s]/g, '') === '';
/** What a shell expands or reads as an assignment: in a program's name, it can be any program. */
const EXPANDS = /[*?[\]{}$`()=]/;
/** What ends one command and starts another, or sends output to a file or input from one. */
const SHELL_OPERATOR = /[;&|<>`\n\r]|\$\(/;
/** A pattern that matches more than one command line: the agent writes the rest. */
const isWildcard = (pattern: string): boolean => /[*?]/.test(pattern);

/** The words of a pattern, `prefix:*` cut at its `:`, the program first. */
function wordsOf(pattern: string): string[] {
  const words = pattern.trim().split(/\s+/);
  const first = words[0] ?? '';
  // Past the `:` of a Windows drive, `C:\bin\sh.exe:*`.
  const colon = first.indexOf(':', /^[A-Za-z]:[\\/]/.test(first) ? 2 : 0);
  if (colon !== -1) return [first.slice(0, colon)];
  const last = words.length - 1;
  const end = (words[last] ?? '').indexOf(':');
  if (last > 0 && end !== -1) words[last] = (words[last] as string).slice(0, end);
  return words.filter((w) => w !== '');
}

/** Whether a program, given these words of a pattern, is known to run, write and send nothing. */
function runsNothing(words: readonly string[], wildcard: boolean): boolean {
  const head = words[0] ?? '';
  if (head === '' || EXPANDS.test(head)) return false;
  const name = programName(head);
  if (READS_ONLY.has(name)) return true;
  if (PRINTS.has(name)) return !wildcard;
  const sub = (words[1] ?? '').toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(sub)) return false;
  if (SAFE_SUBCOMMANDS.get(name)?.has(sub) === true) return true;
  return (
    name === 'git' &&
    !wildcard &&
    GIT_READS.has(sub) &&
    words.slice(2).every((w) => !w.startsWith('-') || GIT_PLAIN_OPTION.test(w))
  );
}

/**
 * Whether a command pattern (what is inside `Bash(...)`) lets more run than a program known to
 * run, write and send nothing: a wildcard, a shell operator, a program name that expands or
 * assigns, or any program not shown to be harmless. Quotes and backslashes are taken out first, as
 * a shell takes them out of a word (`b\ash`, `"sh"`); a backslash is also read as a Windows folder
 * separator, and either reading that is not harmless counts.
 */
export function patternRunsAnything(pattern: string): boolean {
  if (isWildcardOnly(pattern) || SHELL_OPERATOR.test(pattern)) return true;
  const wildcard = isWildcard(pattern);
  const withSlashes = wordsOf(pattern.replace(/["']/g, '')).map((w, i) =>
    i === 0 ? w : w.replace(/\\/g, ''),
  );
  const plain = wordsOf(pattern.replace(/["'\\]/g, ''));
  return !(runsNothing(withSlashes, wildcard) && runsNothing(plain, wildcard));
}

/** The tool of a rule and what is in its parentheses, `undefined` when it has none. */
function partsOf(rule: string): { readonly tool: string; readonly spec: string | undefined } {
  const text = rule.trim();
  const open = text.indexOf('(');
  if (open === -1) return { tool: text, spec: undefined };
  const close = text.lastIndexOf(')');
  return {
    tool: text.slice(0, open).trim(),
    spec: text.slice(open + 1, close > open ? close : undefined),
  };
}

/**
 * Whether one allow rule hands the agent the whole shell, for the shell tools named in `tools`
 * (`Bash`, or Gemini's `run_shell_command`): the tool alone, the tool with a pattern that lets
 * more run than a harmless program, or a tool name that is a wildcard (`*`, `mcp__*`), which
 * takes in the shell tool too.
 */
export function ruleRunsAnything(rule: string, tools: ReadonlySet<string>): boolean {
  const { tool, spec } = partsOf(rule);
  if (/[*?]/.test(tool)) return true;
  if (!tools.has(tool.toLowerCase())) return false;
  return spec === undefined || patternRunsAnything(spec);
}

/**
 * Claude Code's tools that only read files. Its permission table lists reads as needing no
 * approval, so a rule for one of them with no path grants nothing the default does not; one that
 * names a path out of the repository does.
 */
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'notebookread', 'glob', 'grep', 'ls']);
/** Claude Code's tools that change files: a rule for one with no path lets it change any. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['webfetch', 'websearch']);

/**
 * A path that may lead out of the repository: from the home folder (`~`), the root of the disk
 * (`//`, in Claude Code's own spelling, or a drive), a variable, or up a folder (`..`).
 */
export const leadsOutside = (path: string): boolean =>
  /^\s*(?:~|\/\/|\$|%|\\\\|[A-Za-z]:)/.test(path) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path);

/**
 * Whether one of Claude Code's allow rules lets the agent read or change files outside the
 * repository, or reach the network, without asking: a tool that changes files with no path (every
 * file it may reach), a file tool with a path that leads out, a web tool with no domain or with a
 * wildcard one.
 */
export function ruleReachesOutside(rule: string): boolean {
  const { tool, spec } = partsOf(rule);
  const name = tool.toLowerCase();
  const bare = spec === undefined || spec.trim() === '';
  if (WRITE_TOOLS.has(name)) return bare || leadsOutside(spec as string);
  if (READ_TOOLS.has(name)) return !bare && leadsOutside(spec as string);
  if (WEB_TOOLS.has(name)) return spec === undefined || !/^domain:[^*?\s]+$/.test(spec.trim());
  return false;
}

/** Whether a rule of Claude Code's settings or of a skill's `allowed-tools` grants too much. */
export const claudeRuleIsBroad = (rule: string, shellTools: ReadonlySet<string>): boolean =>
  ruleRunsAnything(rule, shellTools) || ruleReachesOutside(rule);
