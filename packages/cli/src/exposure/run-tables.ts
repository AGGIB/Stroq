/**
 * The tables the follow in `agent-run-files.ts` reads commands by: which words run what follows
 * them, which change the folder, which tools load which files of the repository as code, and
 * which files a runner or an interpreter may run.
 */

/** Words after which a pattern or a folder is what runs: a shell, an interpreter, a loop. */
export const RUNS_WHAT_FOLLOWS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'source',
  '.',
  'exec',
  'node',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'pwsh',
  'powershell',
  'run-parts',
  'in',
]);
/** Words after which the next word is the folder the rest runs in. */
export const CHANGES_FOLDER: ReadonlySet<string> = new Set([
  'cd',
  'pushd',
  '--prefix',
  '-C',
  '--dir',
  '--cwd',
  '--cd',
]);

/** Tools that load a file of the repository as code, and the names of those files. */
export const LOADS_CODE: readonly (readonly [tools: readonly string[], file: RegExp])[] = [
  [['make', 'gmake'], /^(?:gnumakefile|makefile)$|\.mk$/i],
  [['just'], /^\.?justfile$/i],
  [['task'], /^taskfile(?:\.dist)?\.ya?ml$/i],
  [['rake'], /^rakefile(?:\.rb)?$/i],
  [['gradle', 'gradlew'], /^(?:build|settings)\.gradle(?:\.kts)?$/i],
  [['cargo'], /^build\.rs$/i],
  [['nox'], /^noxfile\.py$/i],
  [['invoke', 'inv'], /^tasks\.py$/i],
  [['pre-commit'], /^\.pre-commit-config\.ya?ml$/i],
  // A config in any format: one in JSON or YAML names the plugins the tool loads as code.
  [['eslint'], /^(?:eslint\.config|\.eslintrc)(?:\.[a-z0-9]+)?$/i],
  [['prettier'], /^(?:prettier\.config|\.prettierrc)(?:\.[a-z0-9]+)?$/i],
  [['stylelint'], /^(?:stylelint\.config|\.stylelintrc)(?:\.[a-z0-9]+)?$/i],
  [['lint-staged'], /^(?:lint-staged\.config|\.lintstagedrc)(?:\.[a-z0-9]+)?$/i],
  [['jest'], /^jest\.config\.[a-z0-9]+$/i],
  [['vitest', 'vite'], /^(?:vitest|vite)\.(?:config|workspace)\.[a-z0-9]+$/i],
  [['mocha'], /^\.mocharc(?:\.[a-z0-9]+)?$/i],
  [['pytest', 'py.test'], /^(?:conftest\.py|pytest\.ini)$/i],
];

/** The extensions a tool's config may have, to find one that is there and read what it names. */
export const CONFIG_EXTENSIONS = [
  '',
  '.json',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.cts',
  '.mts',
];
/** The names of the configs each tool reads, whose plugins and commands are followed. */
export const TOOL_CONFIGS: ReadonlyMap<string, readonly string[]> = new Map(
  (
    [
      ['eslint', ['.eslintrc', 'eslint.config']],
      ['prettier', ['.prettierrc', 'prettier.config']],
      ['stylelint', ['.stylelintrc', 'stylelint.config']],
      ['lint-staged', ['.lintstagedrc', 'lint-staged.config']],
      ['vite', ['vite.config']],
    ] as const
  ).map(([tool, stems]) => [tool, stems.flatMap((s) => CONFIG_EXTENSIONS.map((e) => `${s}${e}`))]),
);

/**
 * Files that set up a package or task runner, or are its recipes: what a runner the follow cannot
 * follow to the end may run. Workspace configs, Makefiles, justfiles, Taskfiles and the like, and
 * the configs of npm, yarn, pnpm and bun, which can name the shell scripts run in.
 */
export const RUNNER_FILE =
  /(?:^|\/)(?:pnpm-workspace\.ya?ml|lerna\.json|nx\.json|turbo\.json|rush\.json|project\.json|workspace\.json|gnumakefile|makefile|[^/]*\.mk|\.?justfile|taskfile(?:\.dist)?\.ya?ml|rakefile(?:\.rb)?|tasks\.py|noxfile\.py|tox\.ini|(?:build|settings)\.gradle(?:\.kts)?|gradlew(?:\.bat)?|pom\.xml|mvnw(?:\.cmd)?|cargo\.toml|build\.rs|deno\.jsonc?|composer\.json|gemfile|pyproject\.toml|pipfile|\.pre-commit-config\.ya?ml|lefthook\.ya?ml|\.npmrc|\.yarnrc(?:\.ya?ml)?|bunfig\.toml|\.?pnpmfile\.[cm]?js|(?:docker-)?compose\.ya?ml|dockerfile)$|(?:^|\/)(?:\.yarn|\.mvn|gradle\/wrapper|\.husky|\.githooks)\//i;
/**
 * A file a shell, an interpreter or a toolchain runs or builds into what it runs: scripts, and
 * the sources of compiled languages, which `go test` or `cargo test` build and run.
 */
export const SCRIPT_FILE =
  /\.(?:sh|bash|zsh|fish|ksh|ps1|psm1|bat|cmd|[cm]?[jt]sx?|vue|svelte|astro|coffee|py|pyw|pyx|pth|rb|pl|pm|php|lua|r|go|rs|java|kt|kts|scala|groovy|gradle|clj|cljs|cs|fs|vb|c|h|cc|cpp|cxx|hh|hpp|m|mm|swift|ex|exs|erl|hrl|hs|ml|dart|zig|nim|jl|tcl|awk)$/i;
