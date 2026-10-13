"""
The interpreter's side of the test of `judgePythonProgram` (inline-python-oracle.test.ts).

Reads a request on standard input and answers with JSON on standard output:

  {"mode": "run", "programs": [...], "stdins": [...]}
      Runs each program as `python3 -c` would, once for each text in `stdins` as its standard
      input, under an audit hook, and answers the events that run code, start a process, touch a
      file, or open a socket, for each program.

  {"mode": "reach", "attributes": [...], "builtins": [...], "modules": [...]}
      Follows every attribute name that a program may use, from the modules and the values it can
      make, and answers the dangerous objects that a path of such names reaches.

  {"mode": "builtins"}
      Answers the names of the interpreter's builtins, for the test that compares them with the list
      the reader keeps.

It runs the programs it is given: it is a test fixture, and it is run only by that test.
"""

import builtins
import importlib
import io
import json
import os
import signal
import sys
import types

PREFIXES = tuple(
    {
        os.path.realpath(path)
        for path in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix)
    }
)
FROZEN = ("<frozen",)

# `exec`, `eval` and `compile` raise no audit event for a string, only for a code object, so the
# builtins are put behind a guard that a program calls instead.
_REAL_EXEC = builtins.exec
_REAL_COMPILE = builtins.compile

# Events that are a danger whatever they are called with, by prefix.
DANGEROUS_PREFIXES = (
    "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty", "os.kill",
    "os.killpg", "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.chown",
    "os.truncate", "os.symlink", "os.link", "os.utime", "os.putenv", "os.unsetenv", "os.listdir",
    "os.scandir", "os.chdir", "os.chroot", "os.mkfifo", "os.mknod", "os.setxattr",
    "os.removexattr", "subprocess.", "socket.", "ctypes.", "shutil.", "pty.", "webbrowser.",
    "urllib.Request", "http.client.", "smtplib.", "ftplib.", "telnetlib.", "imaplib.", "poplib.",
    "multiprocessing.", "sqlite3.", "tempfile.", "winreg.", "msvcrt.", "sys.settrace",
    "sys.setprofile", "code.interact", "pickle.find_class", "glob.glob",
    "os.add_dll_directory", "signal.", "resource.", "fcntl.", "mmap.", "syslog.",
)
DANGEROUS_MODULES = {
    "subprocess", "_posixsubprocess", "socket", "_socket", "ctypes", "_ctypes", "pty", "runpy",
    "code", "codeop", "pickle", "_pickle", "marshal", "shelve", "shutil", "tempfile", "webbrowser",
    "http", "ftplib", "smtplib", "telnetlib", "multiprocessing", "asyncio", "ssl", "_ssl",
    "sqlite3", "glob", "pathlib", "importlib.util", "importlib.machinery", "zipimport", "imp",
    "ensurepip", "venv", "pip", "setuptools", "pydoc", "pdb", "bdb", "cmd", "trace", "profile",
    "cProfile", "timeit", "dbm", "ctypes.util", "mmap", "fcntl", "select", "selectors",
    "signal", "resource", "pwd", "grp", "termios", "tty", "curses", "readline", "rlcompleter",
    "site", "sitecustomize", "usercustomize", "this", "antigravity", "__hello__", "idlelib",
    "tkinter", "turtle", "wsgiref", "xmlrpc", "socketserver", "http.server", "urllib.request",
    "urllib.response", "urllib.robotparser", "webbrowser", "zipapp", "tarfile", "zipfile",
    "gzip", "bz2", "lzma", "zlib",
}

_events = []
_armed = False
# Depth of the calls that are the standard library's own and known: no event in them is a program's.
_trusted = 0


def _flag(event, detail):
    """Records the event and refuses it, so that a program that runs code never gets to."""
    _events.append([event, detail])
    raise RuntimeError("blocked: " + event)


def _under_prefix(path):
    try:
        text = os.fspath(path)
    except Exception:
        return False
    if isinstance(text, bytes):
        text = os.fsdecode(text)
    return os.path.realpath(text).startswith(PREFIXES)


def _hook(event, args):
    if not _armed or _trusted:
        return
    if event == "exec":
        code = args[0]
        name = getattr(code, "co_filename", "")
        if name == "<snippet>" or name.startswith(FROZEN) or _under_prefix(name):
            return
        _flag(event, name)
    elif event == "compile":
        name = args[1] if len(args) > 1 else ""
        if isinstance(name, bytes):
            name = os.fsdecode(name)
        if name == "<snippet>" or str(name).startswith(FROZEN) or _under_prefix(str(name)):
            return
        _flag(event, str(name)[:60])
    elif event == "open":
        path, mode = args[0], args[1]
        if isinstance(path, int) or str(path).startswith("<"):
            return
        writing = mode is not None and any(ch in str(mode) for ch in "wax+")
        if not writing and _under_prefix(path):
            return
        _flag(event, repr(path)[:80] + " " + str(mode))
    elif event == "import":
        module = args[0]
        if module in DANGEROUS_MODULES or module.split(".")[0] in DANGEROUS_MODULES:
            _flag(event, module)
    elif event.startswith(DANGEROUS_PREFIXES):
        # The import system lists the directories of the standard library to find a module.
        if event in ("os.listdir", "os.scandir") and args and _under_prefix(args[0] or "."):
            return
        _flag(event, repr(args)[:80])


def _stdlib_name(filename):
    return str(filename).startswith(FROZEN) or _under_prefix(filename)


def _guard(name, real):
    """
    The builtin `name` as a program sees it. The import machinery runs the code of a module with
    `exec` and compiles its source with `compile`; those pass. A string given to any of them, and a
    code object that is not the standard library's, is an event.
    """

    def checked(*args, **kwargs):
        if _armed:
            source = args[0] if args else None
            caller = sys._getframe(1).f_code
            # `collections.namedtuple` builds `__new__` from a string of its own, and `urllib.parse`
            # makes several of them when it is imported.
            if caller.co_name == "namedtuple" and _stdlib_name(caller.co_filename):
                global _trusted
                _trusted += 1
                try:
                    return real(*args, **kwargs)
                finally:
                    _trusted -= 1
            if isinstance(source, types.CodeType):
                if _stdlib_name(source.co_filename):
                    return real(*args, **kwargs)
            elif name == "compile" and len(args) > 1 and _stdlib_name(args[1]):
                return real(*args, **kwargs)
            _flag("builtins." + name, repr(args)[:60])
        return real(*args, **kwargs)

    return checked


class _Timeout(Exception):
    pass


def _alarm(_signal, _frame):
    raise _Timeout()


def run(programs, stdins):
    results = []
    global _armed
    for program in programs:
        found = []
        errors = []
        try:
            code = _REAL_COMPILE(program, "<snippet>", "exec")
        except BaseException as err:  # a program that is not Python
            results.append({"events": [], "error": "compile: " + type(err).__name__})
            continue
        for text in stdins:
            del _events[:]
            real_in, real_out, real_err = sys.stdin, sys.stdout, sys.stderr
            sys.stdin, sys.stdout, sys.stderr = io.StringIO(text), io.StringIO(), io.StringIO()
            namespace = {"__name__": "__main__", "__builtins__": builtins}
            signal.signal(signal.SIGALRM, _alarm)
            signal.alarm(2)
            try:
                _armed = True
                _REAL_EXEC(code, namespace)
            except BaseException as err:
                errors.append(type(err).__name__)
            finally:
                _armed = False
                signal.alarm(0)
                sys.stdin, sys.stdout, sys.stderr = real_in, real_out, real_err
            found.extend(list(_events))
        results.append({"events": found, "error": errors[0] if errors else None})
    return results


def reach(attributes, allowed_builtins, module_names):
    import collections
    import csv
    import datetime
    import hashlib
    import re
    import statistics
    import time
    import urllib.parse

    allowed_modules = {importlib.import_module(name) for name in module_names}
    allowed_module_names = set(module_names) | {"urllib", "urllib.parse"}
    dangerous_builtins = {
        getattr(builtins, name)
        for name in dir(builtins)
        if name not in allowed_builtins and not name.startswith("_") and name != "None"
        and not isinstance(getattr(builtins, name), (bool, type(Ellipsis), type(NotImplemented)))
    }
    dangerous_modules = {
        "os", "posix", "nt", "subprocess", "_posixsubprocess", "socket", "_socket", "ctypes",
        "_ctypes", "shutil", "pty", "importlib", "runpy", "code", "codeop", "pickle", "marshal",
        "tempfile", "glob", "signal", "threading", "_thread", "gc", "inspect", "ast", "dis",
        "types",
    }

    def dangerous(obj):
        if isinstance(obj, types.ModuleType):
            return obj.__name__ not in allowed_module_names
        try:
            if obj in dangerous_builtins:
                return True
        except TypeError:
            pass
        module = getattr(obj, "__module__", None)
        if isinstance(module, str) and module.split(".")[0] in dangerous_modules:
            return True
        return False

    primitive = (str, bytes, int, float, complex, bool, type(None))
    roots = list(allowed_modules)
    roots += ["", b"", 0, 0.0, 1j, [], {}, set(), frozenset(), (), range(1), iter([]),
              enumerate([]), zip(), map(str, []), filter(None, []), reversed([]), slice(1),
              Exception(), KeyError(), ValueError(), int, float, str, bytes, list, dict, set,
              tuple, frozenset, bool]
    roots += [datetime.datetime.now(), datetime.date.today(), datetime.timedelta(1),
              datetime.timezone.utc, datetime.datetime, datetime.date, datetime.timedelta,
              datetime.time(0), re.compile("x"), re.compile("x").match("x"), collections.Counter(),
              collections.deque(), collections.OrderedDict(), collections.defaultdict(list),
              hashlib.sha256(), hashlib.md5(), csv.reader([]), csv.writer(io.StringIO()),
              csv.DictReader([]), urllib.parse.urlparse("http://a/b"),
              json.JSONDecodeError("m", "d", 0), io.StringIO(), time.gmtime(), time.localtime(),
              time.struct_time((1, 1, 1, 1, 1, 1, 1, 1, 1)), sys.version_info, sys.argv,
              sys.stdin, sys.stdout, sys.stderr, statistics, json.JSONDecoder(), json.JSONEncoder()]
    seen = set()
    paths = []
    queue = [(root, type(root).__name__ if not isinstance(root, types.ModuleType) else root.__name__, 0)
             for root in roots]
    while queue:
        obj, path, depth = queue.pop()
        if id(obj) in seen:
            continue
        seen.add(id(obj))
        if dangerous(obj):
            paths.append(path)
            continue
        if isinstance(obj, primitive) and depth > 0 and not isinstance(obj, (str, bytes)):
            pass
        if depth >= 7:
            continue
        for name in attributes:
            try:
                value = getattr(obj, name)
            except BaseException:
                continue
            if id(value) in seen:
                continue
            queue.append((value, path + "." + name, depth + 1))
    return sorted(set(paths))


def main():
    request = json.load(sys.stdin)
    mode = request["mode"]
    if mode == "run":
        sys.addaudithook(_hook)
        for name in ("exec", "eval", "compile"):
            setattr(builtins, name, _guard(name, getattr(builtins, name)))
        answer = run(request["programs"], request["stdins"])
    elif mode == "reach":
        answer = reach(request["attributes"], set(request["builtins"]), request["modules"])
    elif mode == "builtins":
        answer = sorted(dir(builtins))
    else:
        raise SystemExit("unknown mode")
    sys.stdout.write(json.dumps(answer))


main()
