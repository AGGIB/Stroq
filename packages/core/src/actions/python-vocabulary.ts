import type { PythonToken } from './inline-python.js';

/**
 * The names the reader of the processes a Python program starts knows (`python-processes.ts`): what
 * starts a process, what starts nothing, and what makes a program opaque.
 */

export const set = (words: string): ReadonlySet<string> =>
  new Set(words.split(/\s+/).filter(Boolean));

/** `subprocess` functions that start the command in their first argument. */
export const RUNS = set('run call check_call check_output Popen');
/** `subprocess` functions that hand their argument to a shell. */
export const SHELL_RUNS = set('getoutput getstatusoutput');
/** `subprocess` names that start nothing. */
export const INERT = set(
  'PIPE DEVNULL STDOUT CalledProcessError TimeoutExpired CompletedProcess SubprocessError list2cmdline',
);
/** `subprocess` functions named distinctly enough to be read as one, whatever they are reached through. */
export const DISTINCT_RUNS = set('check_call check_output Popen getoutput getstatusoutput');
/** `os` functions that hand their argument to a shell. */
export const OS_SHELLS = set('system popen');
/** Names that start a process in a way that is not read here, whatever they are reached through. */
export const UNREAD_STARTS = set(
  `execl execle execlp execlpe execv execve execvp execvpe spawnl spawnle spawnlp spawnlpe spawnv
   spawnve spawnvp spawnvpe posix_spawn posix_spawnp forkpty fork_exec startfile
   create_subprocess_shell create_subprocess_exec subprocess_shell subprocess_exec popen2 popen3
   popen4 os_system`,
);
/** Names that start a process as functions of `os`, and are common words anywhere else (`repo.fork()`). */
export const OS_STARTS = set('fork');
/** Modules that are `os` by another name. */
export const OS_MODULES = set('os posix nt');
/** Modules that start processes through functions that are not read here. */
export const UNREAD_MODULES = set(
  `_posixsubprocess _winapi _subprocess pty pexpect sh plumbum sarge delegator envoy pipes
   webbrowser imaplib tkinter _tkinter mailcap`,
);
/**
 * Standard modules that start no process and run no string as code, beyond what is read here (`os`,
 * `subprocess`, `contextlib.chdir`): the only modules a program may import for the old pattern to be
 * answered by the reading. A module that is not one of them (the project's own, a package, a module
 * that runs commands in its own way) leaves the answer to the pattern, since what it does is not read.
 */
export const KNOWN_MODULES = set(
  `__future__ abc argparse array asyncio base64 binascii bisect bz2 calendar cmath codecs collections
   colorsys concurrent contextlib copy csv dataclasses datetime decimal difflib enum errno filecmp
   fnmatch fractions functools genericpath getpass glob gzip hashlib heapq hmac html io ipaddress
   itertools json keyword linecache locale logging lzma math mimetypes nt ntpath numbers operator os
   pathlib platform posix posixpath pprint queue random re secrets select selectors shlex shutil
   signal socket stat statistics string struct subprocess sys tempfile textwrap threading time
   tomllib traceback types typing unicodedata urllib uuid warnings weakref zipfile zlib zoneinfo`,
);
/** Parts of known modules that load or run what they are given by name (`logging.config`, `http.server`). */
export const UNKNOWN_SUBMODULES = set('logging.config concurrent.futures.process');
/** Modules that run code given as a string, load code, decode data, or reach the interpreter's internals. */
export const OPAQUE_MODULES = set(
  `importlib runpy code codeop pickle cPickle _pickle marshal shelve dill cloudpickle joblib ctypes
   cffi builtins base64 codecs zlib binascii bz2 lzma gzip pydoc pdb bdb timeit cProfile profile
   trace doctest pkgutil IPython yaml`,
);
/** Names through which a program reaches another name by a string, or runs code it makes. */
export const OPAQUE_NAMES = set(
  'eval exec compile __import__ getattr setattr delattr globals locals vars breakpoint',
);
/** Names of what writes a file: a program that has one may write the file it runs. */
export const WRITES = set(
  `write writelines write_text write_bytes copy copyfile copy2 copytree copyfileobj move rename
   renames replace symlink link mkfifo urlretrieve dump savez save truncate extract extractall
   unpack_archive fdopen FileIO`,
);
/** Attributes through which a program reaches the modules it has loaded, changes the environment, or decodes. */
export const OPAQUE_ATTRIBUTES = set('modules putenv unsetenv fromhex');
/** The environment the processes a program starts are given, as text and as bytes. */
export const ENVIRONMENTS = set('environ environb');
/** Dunder names that are only values. */
export const INERT_DUNDERS = set(
  '__name__ __doc__ __version__ __file__ __main__ __all__ __author__ __path__ __package__',
);
/** What `subprocess.run` and its kin may be given beside the command without changing what runs (`cwd` is read apart). */
export const RUN_OPTIONS = set(
  `stdout stderr capture_output text universal_newlines encoding errors timeout check bufsize
   close_fds start_new_session`,
);
export const ASSIGNMENT = set(`= := += -= *= /= %= &= |= ^= @= **= //= >>= <<=`);
export const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

export const isOp = (tok: PythonToken | undefined, text: string): boolean =>
  tok !== undefined && tok.kind === 'op' && tok.text === text;
export const isName = (tok: PythonToken | undefined, text?: string): boolean =>
  tok !== undefined && tok.kind === 'name' && (text === undefined || tok.text === text);
export const isOpaqueDunder = (word: string): boolean =>
  word.length > 4 && word.startsWith('__') && word.endsWith('__') && !INERT_DUNDERS.has(word);
