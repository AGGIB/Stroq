import { INLINE_PAYLOAD } from './inline-payload.js';
import { readPythonTokens, type PythonToken } from './inline-python.js';
import {
  CHDIRS,
  bindingsOutsideImports,
  matching,
  readImports,
  type Bindings,
  type Names,
} from './python-bindings.js';
import {
  DISTINCT_RUNS,
  ENVIRONMENTS,
  INERT,
  OPAQUE_ATTRIBUTES,
  OPAQUE_NAMES,
  OPENERS,
  OS_SHELLS,
  OS_STARTS,
  RUNS,
  RUN_OPTIONS,
  SHELL_RUNS,
  UNREAD_STARTS,
  KNOWN_MODULES,
  UNKNOWN_SUBMODULES,
  WRITES,
  ASSIGNMENT,
  isName,
  isOp,
  isOpaqueDunder,
} from './python-vocabulary.js';

/**
 * The processes a Python program given on a command line (`python3 -c '…'`) starts, read from the
 * program as the interpreter reads it, so that each is judged as the command it is.
 *
 * `python3 -c "import os; os.system('git init')"` starts `git init`, and `python3 -c "import os;
 * os.system(cmd)"` starts what only the program knows. A pattern over the command line cannot tell
 * the two apart: the words `os.system` and `subprocess` were enough to stop both, and agents write the
 * first kind all day to test their work, while a program that started its process another way was not
 * stopped at all. Here each call that starts a process is read, and a command written out in the
 * program (`'git init'`, `['python', '-m', 'pytest', 'tests']`, or a name the program gives a string
 * once, `flag = '-v'`) is handed back to be read as a command of the line it is in, as a `sh -c` body
 * is. Anything else is `unread`: a word the program makes as it runs (it may be an option, a target,
 * a whole command), a way to start a process this does not read (`os.execv`, a function passed on,
 * `from subprocess import *`), or a string that holds a word marking code (`subprocess`, `exec(`)
 * without being a command the program starts, since many functions run a string (`timeit.timeit`).
 *
 * What it does not claim is that a program starts nothing else. A program that reaches a name through
 * a string (`getattr`, `sys.modules`, `__import__`), runs or loads code it makes (`exec`, `pickle`),
 * decodes data (`base64`), or changes the environment its processes get (`os.environ`) is `opaque`,
 * for the caller to weigh. A module of the program's own project, found on `sys.path` as `import`
 * finds it, runs as a script does: unread, as it is everywhere else.
 */

export interface PythonProcess {
  /** The command as a shell would be given it: the line handed to a shell, or the words of a list, quoted. */
  readonly command: string;
  /**
   * What the process reads: what the program reads (`inherit`), nothing (`none`, `stdin=DEVNULL`), or
   * what the program writes to it (`fed`: `input=`, `stdin=PIPE`, `os.popen(…, 'w')`).
   */
  readonly stdin: 'inherit' | 'none' | 'fed';
  /**
   * The directories, written out, the process may run in besides the line's own (`cwd='/x'`,
   * `os.chdir('/x')`): a script it runs is read in each, as `cd /x && sh y.sh` is.
   */
  readonly dirs: readonly string[];
}

export interface PythonProcesses {
  readonly processes: readonly PythonProcess[];
  /** A process is started in a way whose command is not read. */
  readonly unread: boolean;
  /**
   * The program reaches names through strings, runs or loads code it makes, decodes data, or changes
   * the environment its processes get.
   */
  readonly opaque: boolean;
  /** A string that is not a command the program starts holds a word that marks code: it may be run. */
  readonly hiddenPayload: boolean;
  /** The program imports a module that is not a known standard one (`KNOWN_MODULES`): what it does is not read. */
  readonly unknownModules: boolean;
}

/** Modules that fetch from the network. */
const FETCHING_MODULES = new Set([
  'asyncio',
  'urllib',
  'urllib2',
  'http',
  'socket',
  'ssl',
  'ftplib',
  'requests',
  'httpx',
  'aiohttp',
  'urllib3',
  'pycurl',
]);

/** A text that is a mode of `open` (`'w'`, `'rb'`, `'a+'`), not a file name. */
const OPEN_MODE = /^[rwxabtU+]{1,5}$/;

/** What stands for the interpreter that runs the program (`sys.executable`). */
const PYTHON = 'python3';
/** The most processes one program is read for: past it, what it starts is not read. */
const MAX_PROCESSES = 32;

/** A word of a command that the shell reads as itself; any other is put in single quotes. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
export const quote = (word: string): string =>
  SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/** The arguments of the call whose `(` is at `open`: token ranges, by position and by keyword. */
interface Call {
  readonly positional: Array<readonly [number, number]>;
  readonly keywords: Map<string, readonly [number, number]>;
  readonly starred: boolean;
}

function argumentsOf(
  tokens: readonly PythonToken[],
  match: ReadonlyMap<number, number>,
  open: number,
): Call | null {
  const close = match.get(open);
  if (close === undefined) return null;
  const call: Call = { positional: [], keywords: new Map(), starred: false };
  let from = open + 1;
  const finish = (to: number): boolean => {
    if (to === from) return true;
    const first = tokens[from] as PythonToken;
    if (isOp(first, '*') || isOp(first, '**')) return false;
    if (first.kind === 'name' && isOp(tokens[from + 1], '=')) {
      call.keywords.set(first.text, [from + 2, to]);
    } else call.positional.push([from, to]);
    return true;
  };
  for (let i = open + 1; i < close; i += 1) {
    const tok = tokens[i] as PythonToken;
    if (tok.kind === 'op' && OPENERS[tok.text] !== undefined) {
      i = match.get(i) ?? close;
      continue;
    }
    if (isOp(tok, ',')) {
      if (!finish(i)) return { ...call, starred: true };
      from = i + 1;
    }
  }
  return finish(close) ? call : { ...call, starred: true };
}

/** A process as it is read, before the directories the program moves to are known. */
type Started = Omit<PythonProcess, 'dirs'> & { readonly cwd?: string };

class ProgramReader {
  readonly processes: Started[] = [];
  /** The directories, written out, the program moves to (`os.chdir('/x')`). */
  readonly dirs = new Set<string>();
  /** The program moves to a directory that is not read: it matters where it starts a process. */
  movesUnread = false;
  /** The strings that are commands the program starts, or words of one: what they hold is read as one. */
  readonly commandStrings = new Set<number>();
  unread = false;
  opaque = false;

  constructor(
    private readonly tokens: readonly PythonToken[],
    private readonly match: ReadonlyMap<number, number>,
    private readonly names: Names,
    private readonly bindings: Bindings,
  ) {}

  private add(process: Started): void {
    if (this.processes.length >= MAX_PROCESSES) this.unread = true;
    else this.processes.push(process);
  }

  /**
   * The string a range is, when it is one written out, or a name the program gives a string once and
   * binds no other way (`flag = '-v'`): what a word of a command is, before it runs. A name of the
   * interpreter's own (`__name__`) or one an `import *` may bind is not read.
   */
  private literal([from, to]: readonly [number, number]): string | undefined {
    if (to !== from + 1) return undefined;
    const tok = this.tokens[from] as PythonToken;
    if (tok.kind === 'str') {
      if (tok.value !== undefined) this.commandStrings.add(from);
      return tok.value;
    }
    if (tok.kind !== 'name' || tok.text.startsWith('__') || this.names.starImport) return undefined;
    if (this.names.imported.has(tok.text) || this.bindings.counts.get(tok.text) !== 1)
      return undefined;
    return this.bindings.literals.get(tok.text);
  }

  /** `sys.executable`, or a name imported for it and not bound again. */
  private isExecutable([from, to]: readonly [number, number]): boolean {
    const { tokens, names } = this;
    if ((this.bindings.counts.get('executable') ?? 0) > 0) return false;
    const first = tokens[from] as PythonToken;
    if (to === from + 1) return first.kind === 'name' && names.executables.has(first.text);
    return (
      to === from + 3 &&
      names.sys.has(first.text) &&
      isOp(tokens[from + 1], '.') &&
      isName(tokens[from + 2], 'executable')
    );
  }

  /** The words of a list or tuple written out as the command, or null when any is not known before it runs. */
  private wordsOf([from, to]: readonly [number, number]): string[] | null {
    const { tokens, match } = this;
    const open = tokens[from] as PythonToken;
    if (!(isOp(open, '[') || isOp(open, '(')) || match.get(from) !== to - 1) return null;
    const words: string[] = [];
    let start = from + 1;
    let commas = 0;
    const take = (end: number): boolean => {
      if (end === start) return true;
      const text = this.literal([start, end]);
      if (text !== undefined) words.push(quote(text));
      else if (this.isExecutable([start, end])) words.push(PYTHON);
      else return false;
      return true;
    };
    for (let i = from + 1; i < to - 1; i += 1) {
      const tok = tokens[i] as PythonToken;
      if (tok.kind === 'op' && OPENERS[tok.text] !== undefined) {
        i = match.get(i) ?? to;
        continue;
      }
      if (isOp(tok, ',')) {
        commas += 1;
        if (!take(i)) return null;
        start = i + 1;
      }
    }
    if (!take(to - 1)) return null;
    // `('ls')` is a string in parentheses, not a tuple.
    if (isOp(open, '(') && commas === 0) return null;
    return words;
  }

  /** What `stdin=` gives the process: nothing (`DEVNULL`), what the program reads (`None`), or what it writes. */
  private stdinOf([from, to]: readonly [number, number]): PythonProcess['stdin'] {
    const { tokens } = this;
    if (to === from + 1 && isName(tokens[from], 'None')) return 'inherit';
    if (to === from + 1 && isName(tokens[from], 'DEVNULL')) return 'none';
    const devnull =
      to === from + 3 &&
      this.names.subprocess.has(tokens[from]?.text ?? '') &&
      isOp(tokens[from + 1], '.') &&
      isName(tokens[from + 2], 'DEVNULL');
    return devnull ? 'none' : 'fed';
  }

  /** A call of `subprocess.run` or one of its kin (`fn`), whose name is at `at`. */
  readRun(at: number, fn: string): void {
    const { tokens } = this;
    if (!isOp(tokens[at + 1], '(')) {
      this.unread = true;
      return;
    }
    const call = argumentsOf(tokens, this.match, at + 1);
    const first = call?.positional[0];
    if (call === null || call.starred || call.positional.length !== 1 || first === undefined) {
      this.unread = true;
      return;
    }
    if (SHELL_RUNS.has(fn)) {
      const line = this.literal(first);
      const options = [...call.keywords.keys()].every(
        (key) => key === 'encoding' || key === 'errors',
      );
      if (line === undefined || !options) this.unread = true;
      else this.add({ command: line, stdin: 'inherit' });
      return;
    }
    let stdin: PythonProcess['stdin'] = 'inherit';
    let cwd: string | undefined;
    for (const [key, range] of call.keywords) {
      if (key === 'input') stdin = 'fed';
      else if (key === 'stdin') stdin = stdin === 'fed' ? 'fed' : this.stdinOf(range);
      else if (key === 'cwd') {
        // A directory written out is where its scripts are read; a new temporary one has none.
        cwd = this.literal(range);
        if (cwd === undefined && !this.isNewDirectory(range)) {
          this.unread = true;
          return;
        }
      } else if (key !== 'shell' && !RUN_OPTIONS.has(key)) {
        this.unread = true;
        return;
      }
    }
    const shell = call.keywords.get('shell');
    const shellValue =
      shell === undefined ? 'False' : shell[1] === shell[0] + 1 ? tokens[shell[0]]?.text : '';
    if (shellValue !== 'True' && shellValue !== 'False') {
      this.unread = true;
      return;
    }
    const text = this.literal(first);
    const where = cwd === undefined ? {} : { cwd };
    if (shellValue === 'True') {
      if (text === undefined) this.unread = true;
      else this.add({ command: text, stdin, ...where });
      return;
    }
    // A string without a shell is the name of the program, and nothing else.
    const words = text !== undefined ? [quote(text)] : this.wordsOf(first);
    if (words === null || words.length === 0) {
      this.unread = true;
      return;
    }
    this.add({ command: words.join(' '), stdin, ...where });
  }

  /**
   * `os.system(line)` or `os.popen(line, mode)` at `at`. Through a name that is not `os` (`strict`
   * false) it may be another function of that name (`platform.system()`): one given nothing is passed
   * over, and one given a line is read all the same.
   */
  readShell(at: number, fn: string, strict: boolean): void {
    const { tokens } = this;
    const call = isOp(tokens[at + 1], '(') ? argumentsOf(tokens, this.match, at + 1) : null;
    if (!strict && call !== null && call.positional.length === 0 && call.keywords.size === 0)
      return;
    const first = call?.positional[0];
    const line = first === undefined ? undefined : this.literal(first);
    if (call === null || call.starred || first === undefined || line === undefined) {
      this.unread = true;
      return;
    }
    const keys = [...call.keywords.keys()];
    if (
      fn === 'system'
        ? call.positional.length !== 1 || keys.length > 0
        : call.positional.length > 3 || !keys.every((key) => key === 'mode' || key === 'buffering')
    ) {
      this.unread = true;
      return;
    }
    const mode = call.keywords.get('mode') ?? call.positional[1];
    const modeText = mode === undefined ? 'r' : this.literal(mode);
    const fed = modeText === undefined || modeText.includes('w');
    this.add({ command: line, stdin: fed ? 'fed' : 'inherit' });
  }

  /**
   * `exec(open('test_x.py').read())`: the file run as `python3 test_x.py` is, where nothing makes it
   * something else. The path is written out and is a file of the project's kind (not an option, not
   * `/dev/stdin`), `open` is the builtin and is used nowhere else, and the program writes no file, so
   * that what runs is what is on disk before it starts. Any other `exec` is opaque.
   */
  readExec(at: number): void {
    const { tokens } = this;
    const path = tokens[at + 4]?.value;
    const exact =
      isOp(tokens[at + 1], '(') &&
      isName(tokens[at + 2], 'open') &&
      isOp(tokens[at + 3], '(') &&
      path !== undefined &&
      isOp(tokens[at + 5], ')') &&
      isOp(tokens[at + 6], '.') &&
      isName(tokens[at + 7], 'read') &&
      isOp(tokens[at + 8], '(') &&
      isOp(tokens[at + 9], ')') &&
      isOp(tokens[at + 10], ')');
    const file =
      path !== undefined &&
      path !== '' &&
      !path.startsWith('-') &&
      !/^\/(?:dev|proc|sys)\//.test(path) &&
      !path.includes('\n');
    const opens = tokens.filter((tok) => isName(tok, 'open')).length;
    const writes = tokens.some((tok) => tok.kind === 'name' && WRITES.has(tok.text));
    const builtin =
      !this.names.imported.has('open') && (this.bindings.counts.get('open') ?? 0) === 0;
    if (exact && file && opens === 1 && !writes && builtin && path !== undefined) {
      this.commandStrings.add(at + 4);
      this.add({ command: `${PYTHON} ${quote(path)}`, stdin: 'inherit' });
    } else this.opaque = true;
  }

  /**
   * A name the program gave a new temporary directory once (`d = tempfile.mkdtemp()`, `with
   * tempfile.TemporaryDirectory() as d`): nothing is in it but what the program and its processes put there.
   */
  private isNewDirectory([from, to]: readonly [number, number]): boolean {
    const tok = this.tokens[from] as PythonToken;
    if (to !== from + 1 || tok.kind !== 'name' || this.names.imported.has(tok.text)) return false;
    const made = this.bindings.temporaryDirectories.get(tok.text);
    if (made === undefined || made.fn === 'getcwd') return false;
    // Each time the name is bound, it is given a new temporary directory, made the same way.
    if (this.bindings.counts.get(tok.text) !== made.times) return false;
    const owner = made.owner;
    if (owner === null) return this.names.tempDirs.get(made.fn) === made.fn;
    return this.names.tempfiles.has(owner) && (this.bindings.counts.get(owner) ?? 0) === 0;
  }

  /** A name the program gave the directory it started in once (`old = os.getcwd()`): going back reads nothing new. */
  private isStartDirectory([from, to]: readonly [number, number]): boolean {
    const tok = this.tokens[from] as PythonToken;
    if (to !== from + 1 || tok.kind !== 'name' || this.names.imported.has(tok.text)) return false;
    const made = this.bindings.temporaryDirectories.get(tok.text);
    if (made?.fn !== 'getcwd' || made.owner === null) return false;
    if (this.bindings.counts.get(tok.text) !== made.times) return false;
    return this.names.os.has(made.owner) && (this.bindings.counts.get(made.owner) ?? 0) === 0;
  }

  /** `os.chdir(path)` at `at`: every process may run there, which is read where the path is written out. */
  readChdir(at: number, fn: string): void {
    const { tokens } = this;
    const call = isOp(tokens[at + 1], '(') ? argumentsOf(tokens, this.match, at + 1) : null;
    const first = call?.positional[0];
    if (
      fn !== 'chdir' ||
      call === null ||
      call.starred ||
      call.positional.length !== 1 ||
      first === undefined
    ) {
      this.movesUnread = true;
      return;
    }
    const dir = this.literal(first);
    if (dir !== undefined) this.dirs.add(dir);
    else if (!this.isNewDirectory(first) && !this.isStartDirectory(first)) this.movesUnread = true;
  }

  /** `os.environ.get('X')` and `os.environ['X']` read it; anything else may change what processes get. */
  readsEnvironment(at: number): boolean {
    const { tokens } = this;
    if (isOp(tokens[at + 1], '.') && isName(tokens[at + 2], 'get') && isOp(tokens[at + 3], '('))
      return true;
    if (!isOp(tokens[at + 1], '[')) return false;
    const after = tokens[(this.match.get(at + 1) ?? tokens.length) + 1];
    return !(after !== undefined && after.kind === 'op' && ASSIGNMENT.has(after.text));
  }

  /**
   * A module passed on (`m = subprocess`, `print(os)`): what is called through it is not read.
   * `subprocess` has no use but to start processes, and that is unread; `os` has many, and a program
   * that passes it on is opaque, as one that reaches it through `getattr` is.
   */
  private passedOn(word: string): void {
    if (this.names.subprocess.has(word)) this.unread = true;
    else this.opaque = true;
  }

  /** A name after a dot, at `at`. */
  attribute(at: number): void {
    const { tokens, names } = this;
    const word = (tokens[at] as PythonToken).text;
    const owner = tokens[at - 2];
    const ownerName = owner !== undefined && owner.kind === 'name' ? owner.text : '';
    if (names.subprocess.has(word) || names.os.has(word)) {
      // `x.subprocess` and `x.os`: the module, reached through another, and passed on (`m = x.os`).
      if (!isOp(tokens[at + 1], '.')) this.passedOn(word);
      return;
    }
    if (names.subprocess.has(ownerName)) {
      if (RUNS.has(word) || SHELL_RUNS.has(word)) this.readRun(at, word);
      else if (!INERT.has(word)) this.unread = true;
      return;
    }
    if (CHDIRS.has(word)) this.readChdir(at, word);
    else if (names.os.has(ownerName) && OS_SHELLS.has(word)) this.readShell(at, word, true);
    else if (names.os.has(ownerName) && OS_STARTS.has(word)) this.unread = true;
    else if (DISTINCT_RUNS.has(word)) this.readRun(at, word);
    else if (OS_SHELLS.has(word)) this.readShell(at, word, false);
    else if (UNREAD_STARTS.has(word)) this.unread = true;
    else if (ENVIRONMENTS.has(word)) this.opaque ||= !this.readsEnvironment(at);
    else if (OPAQUE_ATTRIBUTES.has(word) || isOpaqueDunder(word)) this.opaque = true;
  }

  /** A name not after a dot, at `at`. */
  bare(at: number): void {
    const { tokens, names } = this;
    const word = (tokens[at] as PythonToken).text;
    if (names.subprocess.has(word) || names.os.has(word)) {
      if (!isOp(tokens[at + 1], '.')) this.passedOn(word);
      return;
    }
    const run = names.runs.get(word);
    const shell = names.shells.get(word);
    const chdir = names.chdirs.get(word);
    if (chdir !== undefined) this.readChdir(at, chdir);
    else if (run !== undefined) this.readRun(at, run);
    else if (shell !== undefined) this.readShell(at, shell, true);
    else if (DISTINCT_RUNS.has(word)) this.readRun(at, word);
    else if (word === 'exec') this.readExec(at);
    else if (UNREAD_STARTS.has(word)) this.unread = true;
    else if (OPAQUE_NAMES.has(word) || isOpaqueDunder(word)) this.opaque = true;
  }
}

/** Whether a program may write a file: a writer's name (`write`, `copy`, …), or `open` in a mode that writes or is not written out. */
function writesFiles(tokens: readonly PythonToken[], match: ReadonlyMap<number, number>): boolean {
  return tokens.some((tok, i) => {
    if (tok.kind !== 'name') return false;
    if (WRITES.has(tok.text)) return true;
    if (tok.text !== 'open' || !isOp(tokens[i + 1], '(')) return false;
    const call = argumentsOf(tokens, match, i + 1);
    if (call === null || call.starred) return true;
    const literal = ([from, to]: readonly [number, number]): string | undefined =>
      to === from + 1 ? tokens[from]?.value : undefined;
    // An `open` of something (`Path(p).open('w')`, `os.open(p, flags)`, `io.open(p, m)`) takes its mode
    // in more than one place: it reads only where every argument is written out and none is a mode
    // that writes.
    if (isOp(tokens[i - 1], '.'))
      return [...call.positional, ...call.keywords.values()].some((range) => {
        const text = literal(range);
        return text === undefined || (OPEN_MODE.test(text) && /[wax+]/.test(text));
      });
    const mode = call.keywords.get('mode') ?? call.positional[1];
    if (mode === undefined) return false;
    const text = literal(mode);
    return text === undefined || /[wax+]/.test(text);
  });
}

/**
 * The processes a program given to `python -c` starts, or null when the program cannot be read (too
 * long, a character or a construct this does not read, brackets that do not pair).
 */
export function readPythonProcesses(program: string): PythonProcesses | null {
  const tokens = readPythonTokens(program);
  if (tokens === null) return null;
  const match = matching(tokens);
  if (match === null) return null;
  const names = readImports(tokens);
  const imports = new Uint8Array(tokens.length);
  for (const [from, to] of names.spans) imports.fill(1, from, to);
  const inImport = (i: number): boolean => imports[i] === 1;
  const bindings = bindingsOutsideImports(tokens, match, inImport);
  // `os` is the module only where the program does not make it a name of its own without importing it
  // (`os = platform.system()`, `for os in …`).
  for (const modules of [names.subprocess, names.os, names.sys])
    for (const name of [...modules])
      if (!names.imported.has(name) && (bindings.counts.get(name) ?? 0) > 0) modules.delete(name);
  const reader = new ProgramReader(tokens, match, names, bindings);
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as PythonToken;
    if (tok.kind !== 'name' || inImport(i)) continue;
    if (isOp(tokens[i - 1], '.')) reader.attribute(i);
    else reader.bare(i);
  }
  // A name an import bound to a module or a function that starts processes, bound again by the program,
  // is not the one it was: what is called through it is not known, which matters where it starts one.
  const tracked = [
    ...names.subprocess,
    ...names.os,
    ...names.runs.keys(),
    ...names.shells.keys(),
    ...names.executables,
    ...names.sys,
  ];
  const rebound = tracked.some(
    (name) => names.imported.has(name) && (bindings.counts.get(name) ?? 0) > 0,
  );
  // A program that may write a file and starts a process may run what it wrote (`sh x.sh` after writing
  // `x.sh`): what runs is not on disk before it starts, so it is not read.
  const writesAndRuns = reader.processes.length > 0 && writesFiles(tokens, match);
  // And one that may fetch: what it starts may be what it fetched.
  const fetchesAndRuns =
    reader.processes.length > 0 &&
    [...names.modules].some((module) => FETCHING_MODULES.has(module.split('.')[0] ?? module));
  const dirs = [...reader.dirs];
  const processes = reader.processes.map(({ cwd, ...process }) => ({
    ...process,
    dirs: cwd === undefined ? dirs : [cwd, ...dirs.filter((dir) => dir !== cwd)],
  }));
  const hiddenPayload = tokens.some(
    (tok, i) =>
      tok.kind === 'str' &&
      !reader.commandStrings.has(i) &&
      tok.body !== undefined &&
      INLINE_PAYLOAD.test(tok.body),
  );
  const unknownModules = [...names.modules].some(
    (module) =>
      !KNOWN_MODULES.has(module.split('.')[0] ?? module) ||
      [...UNKNOWN_SUBMODULES].some((sub) => module === sub || module.startsWith(`${sub}.`)),
  );
  return {
    processes,
    unknownModules,
    unread:
      names.unread ||
      reader.unread ||
      writesAndRuns ||
      fetchesAndRuns ||
      (reader.movesUnread && processes.length > 0),
    opaque: names.opaque || reader.opaque || rebound,
    hiddenPayload,
  };
}
