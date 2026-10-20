/**
 * Whether an allow rule hands the agent the whole shell: it lets a program run without asking
 * that runs whatever it is given, or whose subcommand is not one known to run nothing, or its
 * pattern is a wildcard however it is spelled. Coarse on purpose: `Bash(python3 -m pytest:*)`
 * counts, since python runs any code the agent writes, and so does `Bash(npm run lint:*)`, since
 * the agent can write the script.
 *
 * Each step is an index search or a split, so the work is linear in the rule's length.
 */

/** Shells, wrappers that run the command after them, interpreters, and runners of any code. */
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
  'source',
  '.',
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
  'corepack',
  // Task and build runners: their recipes and build scripts are files the agent can write.
  'make',
  'gmake',
  'just',
  'task',
  'rake',
  'invoke',
  'inv',
  'nox',
  'tox',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'ant',
  'turbo',
  'nx',
  'lerna',
  'pre-commit',
  'lefthook',
  'husky',
  'docker',
  'docker-compose',
  'podman',
  // Test runners and tools whose config is code the agent can write.
  'jest',
  'vitest',
  'mocha',
  'pytest',
  'py.test',
  'ava',
  'playwright',
  'cypress',
  'nyc',
  'c8',
  'eslint',
  'prettier',
  'stylelint',
  'lint-staged',
  'vite',
  'webpack',
  'rollup',
  'babel',
]);

/**
 * Package managers and git, and their subcommands known to run no script, no package and no hook:
 * any other subcommand, none, or one that is not a plain word, can run whatever the agent writes.
 */
const SAFE_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (
    [
      [
        ['npm', 'pnpm', 'yarn', 'bun'],
        [
          'help',
          'ls',
          'list',
          'why',
          'outdated',
          'audit',
          'info',
          'view',
          'show',
          'whoami',
          'ping',
          'search',
          'docs',
          'bugs',
          'repo',
          'prefix',
          'root',
          'bin',
          'licenses',
        ],
      ],
      [['uv'], ['help', 'tree', 'version']],
      [
        ['pip', 'pip3'],
        ['help', 'list', 'show', 'freeze', 'check', 'inspect'],
      ],
      [
        ['poetry', 'pipenv', 'pdm', 'hatch', 'rye'],
        ['help', 'show', 'version'],
      ],
      [
        ['cargo'],
        ['help', 'fmt', 'tree', 'metadata', 'search', 'version', 'locate-project', 'pkgid'],
      ],
      [['go'], ['help', 'fmt', 'doc', 'version', 'list', 'vet']],
      [
        ['composer', 'bundle', 'gem'],
        ['help', 'show', 'list', 'info', 'outdated', 'licenses'],
      ],
      [
        ['git'],
        [
          'status',
          'log',
          'diff',
          'show',
          'add',
          'rm',
          'mv',
          'restore',
          'branch',
          'fetch',
          'ls-files',
          'ls-tree',
          'ls-remote',
          'blame',
          'rev-parse',
          'describe',
          'tag',
          'grep',
          'shortlog',
          'reflog',
          'stash',
          'remote',
          'cat-file',
          'check-ignore',
        ],
      ],
    ] as const
  ).flatMap(([names, safe]) => names.map((name) => [name, new Set<string>(safe)] as const)),
);

/** The program a word names, as a shell finds it: its last part, in lower case, no extension. */
const programName = (word: string): string =>
  word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/, '');

const isWildcardOnly = (pattern: string): boolean => pattern.replace(/[*?:\s]/g, '') === '';
/** What a shell expands or reads as an assignment: in a program's name, it can be any program. */
const EXPANDS = /[*?[\]{}$`()=]/;

/** The program word of a pattern and the word after it, `prefix:*` cut at its `:`. */
function headOf(pattern: string): { readonly head: string; readonly second: string } {
  const words = pattern.trim().split(/\s+/);
  const first = words[0] ?? '';
  // Past the `:` of a Windows drive, `C:\bin\sh.exe:*`.
  const colon = first.indexOf(':', /^[A-Za-z]:[\\/]/.test(first) ? 2 : 0);
  if (colon !== -1) return { head: first.slice(0, colon), second: '' };
  return { head: first, second: (words[1] ?? '').split(':')[0] ?? '' };
}

/** Whether a program, by this name and with this subcommand, runs whatever it is given. */
function nameRunsAnything(name: string, second: string): boolean {
  if (name === '' || EXPANDS.test(name) || RUNS_ANYTHING.has(name)) return true;
  const safe = SAFE_SUBCOMMANDS.get(name);
  if (safe === undefined) return false;
  const sub = second.toLowerCase();
  return !(/^[a-z][a-z0-9-]*$/.test(sub) && safe.has(sub));
}

/**
 * Whether a command pattern (what is inside `Bash(...)`) lets any command run: a wildcard, a
 * program that runs anything, a program name that expands or assigns, or a package manager or git
 * without a subcommand known to run nothing. Quotes and backslashes are taken out first, as a
 * shell takes them out of a word (`b\ash`, `"sh"`); a backslash is also read as a Windows folder
 * separator, and either reading that runs anything counts.
 */
export function patternRunsAnything(pattern: string): boolean {
  if (isWildcardOnly(pattern)) return true;
  const withSlashes = headOf(pattern.replace(/["']/g, ''));
  const plain = headOf(pattern.replace(/["'\\]/g, ''));
  return (
    nameRunsAnything(programName(withSlashes.head), withSlashes.second.replace(/\\/g, '')) ||
    nameRunsAnything(programName(plain.head), plain.second) ||
    EXPANDS.test(plain.head)
  );
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
