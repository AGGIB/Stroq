/**
 * The word lists the coarse reading in `agent-run-files.ts` judges a command line by, and the files
 * a runner or a tool reads before it runs anything. Each list errs toward more: a word on none of
 * them is a program not known, which counts as one that could run anything.
 */

/**
 * Package managers, runners and tools that load the repository's own config or code. A command
 * line that holds one of these words anywhere fails on a change to any file `isRunnerFile` names.
 */
export const RUNNER_WORDS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'pipx',
  'corepack',
  'node',
  'nodejs',
  'deno',
  'python',
  'python2',
  'python3',
  'py',
  'pypy',
  'pypy3',
  'uv',
  'pip',
  'pip3',
  'poetry',
  'pipenv',
  'pdm',
  'hatch',
  'rye',
  'nox',
  'tox',
  'make',
  'gmake',
  'just',
  'task',
  'rake',
  'bundle',
  'composer',
  'cargo',
  'go',
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
  'podman',
  'eslint',
  'prettier',
  'stylelint',
  'lint-staged',
  'biome',
  'vite',
  'webpack',
  'rollup',
  'babel',
  'jest',
  'vitest',
  'mocha',
  'ava',
  'playwright',
  'cypress',
  'pytest',
  'ruff',
  'black',
  'isort',
  'mypy',
  'tsc',
  'tsx',
  'ts-node',
  'git',
]);

/** Test runners: they run every test file they find, and what those load. */
export const TEST_RUNNERS: ReadonlySet<string> = new Set([
  'jest',
  'vitest',
  'mocha',
  'pytest',
  'py.test',
  'ava',
  'tap',
  'jasmine',
  'karma',
  'playwright',
  'cypress',
  'rspec',
  'phpunit',
  'pest',
  'nyc',
  'c8',
]);

/**
 * Runners whose recipes, build scripts or packages run whatever they name: what such a command
 * runs is not on its command line, so it is read as one that could run anything.
 */
export const OPEN_RUNNERS: ReadonlySet<string> = new Set([
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
  'cargo',
  'go',
  'composer',
  'bundle',
  'poetry',
  'uv',
  'pip',
  'pip3',
  'pipenv',
  'hatch',
  'pdm',
  'rye',
  'turbo',
  'nx',
  'lerna',
  'pre-commit',
  'lefthook',
  'husky',
  'docker',
  'docker-compose',
  'podman',
  'corepack',
]);

/** Files by their whole name, folded: what a runner or a tool reads before it runs anything. */
const RUNNER_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  '.yarnrc',
  'bunfig.toml',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'rush.json',
  'project.json',
  'workspace.json',
  'deno.json',
  'deno.jsonc',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
  'tox.ini',
  'pytest.ini',
  'conftest.py',
  'noxfile.py',
  'tasks.py',
  'pipfile',
  'makefile',
  'gnumakefile',
  'justfile',
  '.justfile',
  'cargo.toml',
  'build.rs',
  'go.mod',
  'go.sum',
  'go.work',
  'pom.xml',
  'gradlew',
  'gradlew.bat',
  'gradle.properties',
  'mvnw',
  'mvnw.cmd',
  'composer.json',
  'gemfile',
  'rakefile',
  'rakefile.rb',
  '.pre-commit-config.yaml',
  '.pre-commit-config.yml',
  'lefthook.yml',
  'lefthook.yaml',
  '.tool-versions',
  '.python-version',
  '.node-version',
  'mise.toml',
  '.mise.toml',
  'dockerfile',
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
]);

/**
 * Files by the shape of their name, folded: lock files, Taskfiles, Gradle scripts, Makefile parts,
 * and the configs of the tools that load code, in any format and at any depth.
 */
const RUNNER_NAME =
  /^(?:\.yarnrc.*|taskfile.*|(?:build|settings)\.gradle.*|.*\.mk|\.?pnpmfile\.[cm]?js|requirements.*\.txt|.*\.lockb?|.*-lock\.(?:json|ya?ml)|(?:eslint|prettier|stylelint|lint-staged|jest|vitest|vite|webpack|rollup|babel|postcss|tailwind|svelte|astro|next|nuxt|playwright|cypress|tsup|esbuild|biome)\.(?:config|workspace)\..*|\.(?:eslint|prettier|stylelint|lintstaged|mocha|babel|swc|c8|nyc)rc.*|dockerfile.*|.*\.dockerfile)$/;

/** Folders whose files a runner, git or a package manager loads: hook folders, packages, wrappers. */
const RUNNER_FOLDER =
  /(?:^|\/)(?:\.husky|\.githooks|node_modules|\.yarn|\.mvn|gradle\/wrapper|buildsrc)\//;

/** A config by the loosest shape, at the top or next to a package.json: `*config.*`, `.*rc*`. */
const looksLikeConfig = (base: string): boolean =>
  base.includes('config.') || (base.startsWith('.') && base.includes('rc'));

export interface RunnerContext {
  /** Folders that hold a package.json, at the head or the base; `''` for the top. */
  readonly packageFolders: ReadonlySet<string>;
  /** The folders `core.hooksPath` names, or `unknown` when git could not say. */
  readonly hooksPaths: readonly string[] | 'unknown';
}

const folderOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

/**
 * Whether a runner or a tool reads this file before it runs anything: a package or build file, a
 * lock file, the config of a package manager or of a tool whose config is code, a git hook, a file
 * in `node_modules`. `path` is in lower case and folded; `folder` is the same path's folder as the
 * tree has it, to look up next to which package.json it is.
 */
export function isRunnerFile(path: string, ctx: RunnerContext, folder = folderOf(path)): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (RUNNER_NAMES.has(base) || RUNNER_NAME.test(base) || RUNNER_FOLDER.test(path)) return true;
  if (looksLikeConfig(base) && (folder === '' || ctx.packageFolders.has(folder))) return true;
  if (ctx.hooksPaths === 'unknown') return /(?:^|\/)[^/]*hooks?\//.test(path);
  return ctx.hooksPaths.some((dir) => dir === '' || path.startsWith(`${dir.toLowerCase()}/`));
}

/**
 * A file a shell, an interpreter or a toolchain runs or builds into what it runs: scripts, and
 * the sources of compiled languages, which `go test` or `cargo test` build and run.
 */
export const SCRIPT_FILE =
  /\.(?:sh|bash|zsh|fish|ksh|ps1|psm1|bat|cmd|[cm]?[jt]sx?|vue|svelte|astro|coffee|py|pyw|pyx|pth|rb|pl|pm|php|lua|r|go|rs|java|kt|kts|scala|groovy|gradle|clj|cljs|cs|fs|vb|c|h|cc|cpp|cxx|hh|hpp|m|mm|swift|ex|exs|erl|hrl|hs|ml|dart|zig|nim|jl|tcl|awk)$/i;
