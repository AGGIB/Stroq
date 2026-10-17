// The registry of what runs text as code or loads code by name, for `code-loading.ts` to look for.
//
// It is data, on purpose: the reading is best-effort, so what it looks for has to be a list that a person can read,
// that a test can walk entry by entry (`code-loading-registry.test.ts` writes each entry in every spelling the
// reading handles and expects a finding), and that the guide can print. A name is matched exactly and in its case
// (`Eval` and `createrequire` are other names), however it is spelled in the text: as an identifier, with
// identifier escapes (`eval`), as a string in brackets (`x['eval']`, `x['\x65val']`, a template with no hole).
//
// What is NOT here, on purpose: `child_process.spawn('git', [...])`, `fs`, `net` and the other modules that do
// not load or run JavaScript. Starting another program is not a refusal; starting Node itself with a script
// given as text, or a package runner that loads code by name from a registry, is (see the spawning rules below).

/** What a name does, for the sentence that says why a file is not read: "uses createRequire, which ...". */
export interface Entry {
  readonly name: string;
  readonly does: string;
}

const entries = (...list: readonly (readonly [string, string])[]): readonly Entry[] =>
  list.map(([name, does]) => ({ name, does }));

/**
 * Names that load or build code, flagged wherever they stand: as a word, as the name of a property, in a
 * destructuring, as a string in brackets. They are unusual enough in server code that the name alone is the finding.
 */
export const LOADER_NAMES: readonly Entry[] = entries(
  ['createRequire', 'makes a require function'],
  ['_load', 'loads a module by name through Module'],
  ['_resolveFilename', 'resolves a module name through Module'],
  ['_findPath', 'looks a module up by name through Module'],
  ['_compile', 'compiles text as a module'],
  ['_extensions', 'changes how files are loaded'],
  ['_initPaths', 'changes where modules are looked up'],
  ['_preloadModules', 'loads modules by name'],
  ['_pathCache', 'changes where modules are looked up'],
  ['globalPaths', 'changes where modules are looked up'],
  ['registerHooks', 'registers hooks that change how modules are loaded'],
  ['runMain', 'runs a file as the main module'],
  ['dlopen', 'loads a native addon'],
  ['_linkedBinding', 'loads a linked native binding'],
  ['loadExtension', 'loads a native extension into a database'],
  ['setFlagsFromString', 'changes the flags of V8'],
);

/** Members of `process` that load code or hand over the machinery of loading. */
export const PROCESS_MEMBERS: readonly Entry[] = entries(
  ['binding', 'reaches the internal bindings of Node'],
  ['execPath', 'starts the Node that is running (with a script given as text, say)'],
  ['mainModule', 'reaches the main module, and its require'],
);

/** Members of the global object that run text. The plain names `eval` and `Function` are flagged wherever they stand. */
export const GLOBAL_MEMBERS: readonly Entry[] = entries(
  ['eval', 'runs code from text'],
  ['Function', 'makes code from text'],
);

/**
 * Members of `module` and `require.main` that change where Node looks for modules; reading them to print them is
 * not a use, but the same names are what a file writes to when it adds a folder.
 */
export const LOOKUP_MEMBERS: readonly Entry[] = entries([
  'paths',
  'changes where modules are looked up',
]);

/** Names that are flagged only in a file that imports `module`, where they are Node's: `register` is also an ordinary word. */
export const MODULE_ONLY_NAMES: readonly Entry[] = entries(['register', 'registers module hooks']);

/** The specifiers of the module itself, in the spellings Node takes. */
export const MODULE_SPECIFIERS: ReadonlySet<string> = new Set(['module', 'node:module']);

const withPrefix = (names: readonly string[]): ReadonlySet<string> =>
  new Set(names.flatMap((name) => [name, `node:${name}`]));

/** Modules whose import hands over a way to run text as code: the module is the finding. */
export const RUNS_TEXT_MODULES: ReadonlySet<string> = withPrefix([
  'vm',
  'repl',
  'inspector',
  'inspector/promises',
]);

/** Modules whose import starts other programs or threads, which is when the spawning rules below apply. */
export const SPAWNING_MODULES: ReadonlySet<string> = withPrefix([
  'child_process',
  'cluster',
  'worker_threads',
]);

/** Options of node that run text or load code, as they are one argument: `-e`, `--eval=...`. */
export const NODE_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-pe',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--input-type',
]);

/** The same with the value after an equals sign. */
export const NODE_FLAG_PREFIXES: readonly string[] = [
  '--eval=',
  '--print=',
  '--require=',
  '--import=',
  '--loader=',
  '--experimental-loader=',
  '--input-type=',
];

/**
 * Methods of `Reflect` and `Object` that pick a member of an object by a name given as a value. The global object,
 * `process` or `module` handed to one of them can give back `eval` or `require` under a name made at run time.
 */
export const REFLECTION_METHODS: ReadonlySet<string> = new Set([
  'get',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'getOwnPropertyNames',
  'ownKeys',
  'entries',
  'values',
]);

/** Programs that load code by name from a registry, or run a script by name: starting one is loading code. */
export const RUNNERS: ReadonlySet<string> = new Set([
  'npx',
  'npm',
  'pnpm',
  'pnpx',
  'yarn',
  'bunx',
  'bun',
  'deno',
  'tsx',
  'ts-node',
]);

/** Variables of the environment that make a Node process load code, set for a program that is started. */
export const ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['NODE_OPTIONS', 'NODE_PATH']);

/** Functions that write a file; a file that Node can load, written by the server, is code that no digest covers. */
export const WRITERS: ReadonlySet<string> = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'rename',
  'renameSync',
  'link',
  'linkSync',
  'symlink',
  'symlinkSync',
]);

/** Writers that are common words, and so count only as a member (`fs.cp(...)`). */
export const MEMBER_ONLY_WRITERS: ReadonlySet<string> = new Set([
  'cp',
  'rename',
  'link',
  'symlink',
]);

/** Names of files that Node loads as code, or reads to decide how it loads code. */
export const LOADED_FILE = /(?:\.(?:c|m)?js|\.node|\.wasm)$|(?:^|[\\/])package\.json$/i;

/** A path of a script that starts at the root of a disk: a file outside the tree. */
export const ABSOLUTE_SCRIPT = /^(?:\/|[A-Za-z]:[\\/]|\\\\).*\.(?:c|m)?js$/;
