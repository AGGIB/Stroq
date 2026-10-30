import { describe, expect, it } from 'vitest';
import { readPythonProcesses } from '../../src/actions/python-processes.js';
import { cpuNow } from '../cpu-time.js';

/**
 * `python3 -c "import os; os.system('git init')"` starts `git init`; `os.system(cmd)` starts what only
 * the program knows. The reader hands back the first, to be read as a command of the line, and says
 * the second is not read.
 */

const commands = (program: string): string[] =>
  (readPythonProcesses(program)?.processes ?? []).map((p) => p.command);

describe('a command written out in the program is read', () => {
  it.each([
    ['os.system', "import os\nos.system('git init > /dev/null 2>&1')", 'git init > /dev/null 2>&1'],
    ['os.popen', "import os\nprint(os.popen('git status').read())", 'git status'],
    [
      'subprocess.run with a list',
      "import subprocess\nsubprocess.run(['python', '-m', 'pytest', 'tests/x.py', '-k', 'a or b'], capture_output=True, text=True, timeout=30)",
      "python -m pytest tests/x.py -k 'a or b'",
    ],
    ['a tuple', "import subprocess\nsubprocess.call(('git', 'init'))", 'git init'],
    [
      'shell=True',
      "import subprocess\nsubprocess.run('ls -la | head', shell=True)",
      'ls -la | head',
    ],
    [
      'check_output',
      "import subprocess\nsubprocess.check_output(['git', 'log', '--format=%H %s'])",
      "git log '--format=%H %s'",
    ],
    [
      'getoutput',
      "import subprocess\nprint(subprocess.getoutput('git rev-parse HEAD'))",
      'git rev-parse HEAD',
    ],
    [
      'Popen',
      "import subprocess\nsubprocess.Popen(['ls'], stdout=subprocess.PIPE).communicate()",
      'ls',
    ],
    ['an alias of the module', "import subprocess as sp\nsp.run(['git', 'init'])", 'git init'],
    ['an alias of os', "import os as o\no.system('ls')", 'ls'],
    ['posix, imported', "import posix\nposix.system('ls')", 'ls'],
    [
      'a function imported by name',
      "from subprocess import run as r\nr(['make', 'test'])",
      'make test',
    ],
    ['os.system imported by name', "from os import system\nsystem('make')", 'make'],
    ['a string without a shell is a program name', "import subprocess\nsubprocess.run('ls')", 'ls'],
    [
      'sys.executable',
      "import subprocess, sys\nsubprocess.run([sys.executable, '-m', 'pip', 'list'])",
      'python3 -m pip list',
    ],
    [
      'executable imported by name',
      "from sys import executable as py\nimport subprocess\nsubprocess.run([py, 'x.py'])",
      'python3 x.py',
    ],
    ['a raw string', "import os\nos.system(r'ls')", 'ls'],
    ['a triple-quoted line', "import os\nos.system('''ls\npwd''')", 'ls\npwd'],
    ['inside an f-string field', 'import os\nprint(f"{os.system(\'ls\')}")', 'ls'],
    [
      'a name given a string once',
      "import subprocess\nflag = '-rf'\nsubprocess.run(['rm', flag, '/'])",
      'rm -rf /',
    ],
    ['a line given to a name once', "import os\ncmd = 'git init'\nos.system(cmd)", 'git init'],
    [
      'a file run as a script',
      "import sys\nsys.path.insert(0, '.')\nexec(open('test_x.py').read())",
      'python3 test_x.py',
    ],
    [
      'an annotated name',
      "import subprocess\nsub: str = 'clean'\nsubprocess.run(['git', sub, '-fdx'])",
      'git clean -fdx',
    ],
  ])('%s', (_name, program, command) => {
    const reading = readPythonProcesses(program);
    expect(reading?.processes.map((p) => p.command)).toEqual([command]);
    expect(reading?.unread).toBe(false);
  });

  it('quotes a word with what a shell would read', () => {
    expect(commands("import subprocess\nsubprocess.run(['echo', \"it's; rm -rf ~\"])")).toEqual([
      "echo 'it'\\''s; rm -rf ~'",
    ]);
    expect(commands("import subprocess\nsubprocess.run(['rm', '-rf', '*', '~', ''])")).toEqual([
      "rm -rf '*' '~' ''",
    ]);
  });

  it.each([
    ['an attribute set', "import os, sys\nsys.argv = ['x']\nos.system('ls')"],
    ['a path put before the others', "import os, sys\nsys.path.insert(0, '.')\nos.system('ls')"],
    ['an item set', "import os\nd = {}\nd[os.sep] = 1\nos.system('ls')"],
  ])('does not take a module changed for the module bound again: %s', (_name, program) => {
    const reading = readPythonProcesses(program);
    expect(reading?.processes.map((p) => p.command)).toEqual(['ls']);
    expect(reading?.opaque).toBe(false);
  });

  it('reads every process a program starts', () => {
    const program =
      "import os, subprocess\nos.system('git init')\nsubprocess.run(['git', 'config', 'user.name', 'test'], check=True, capture_output=True)\nsubprocess.run(['git', 'config', 'user.email', 'test@test.com'], check=True, capture_output=True)";
    expect(commands(program)).toEqual([
      'git init',
      'git config user.name test',
      'git config user.email test@test.com',
    ]);
  });

  it('says what each process reads', () => {
    const stdin = (program: string): string | undefined =>
      readPythonProcesses(program)?.processes[0]?.stdin;
    expect(stdin("import subprocess\nsubprocess.run(['sh'], input=script)")).toBe('fed');
    expect(stdin("import subprocess\nsubprocess.Popen(['sh'], stdin=subprocess.PIPE)")).toBe('fed');
    expect(stdin("import os\nos.popen('sort', 'w')")).toBe('fed');
    expect(stdin("import os\nos.popen('sort', mode=m)")).toBe('fed');
    expect(stdin("import subprocess\nsubprocess.run(['cat'], stdin=subprocess.DEVNULL)")).toBe(
      'none',
    );
    expect(stdin("import subprocess\nsubprocess.run(['cat'], stdin=None)")).toBe('inherit');
    expect(stdin("import os\nos.system('sh')")).toBe('inherit');
    expect(stdin("import os\nos.popen('ls')")).toBe('inherit');
  });
});

describe('the directory a process runs in', () => {
  const dirs = (program: string): readonly string[] | undefined =>
    readPythonProcesses(program)?.processes[0]?.dirs;

  it.each([
    [
      'cwd= written out',
      "import subprocess\nsubprocess.run(['sh', 'x.sh'], cwd='/tmp/w')",
      ['/tmp/w'],
    ],
    ['os.chdir written out', "import os\nos.chdir('/tmp/w')\nos.system('sh x.sh')", ['/tmp/w']],
    [
      'os.chdir after the process',
      "import os\nos.system('sh x.sh')\nos.chdir('/tmp/w')",
      ['/tmp/w'],
    ],
    [
      'chdir by name',
      "from os import chdir\nimport os\nchdir('/tmp/w')\nos.system('make')",
      ['/tmp/w'],
    ],
    [
      'contextlib.chdir',
      "import contextlib, os\nwith contextlib.chdir('/tmp/w'):\n    os.system('make')",
      ['/tmp/w'],
    ],
    [
      'a new temporary directory',
      "import os, tempfile\nd = tempfile.mkdtemp()\nos.chdir(d)\nos.system('git init')",
      [],
    ],
    [
      'a temporary directory as a context',
      "import subprocess, tempfile\nwith tempfile.TemporaryDirectory() as d:\n    subprocess.run(['git', 'init'], cwd=d)",
      [],
    ],
    [
      'two temporary directories by one name',
      "import os, tempfile\nwith tempfile.TemporaryDirectory() as d:\n    os.chdir(d)\nwith tempfile.TemporaryDirectory() as d:\n    os.chdir(d)\n    os.system('git init')",
      [],
    ],
    [
      'back to where it started',
      "import os, tempfile\nold = os.getcwd()\nd = tempfile.mkdtemp()\nos.chdir(d)\nos.system('git init')\nos.chdir(old)",
      [],
    ],
  ])('%s', (_name, program, expected) => {
    expect(readPythonProcesses(program)?.unread).toBe(false);
    expect(dirs(program)).toEqual(expected);
  });

  it.each([
    ['cwd= the program makes', "import subprocess\nsubprocess.run(['ls'], cwd=d)"],
    ['os.chdir to what it makes', "import os\nos.chdir(d)\nos.system('sh x.sh')"],
    ['os.fchdir', "import os\nos.fchdir(fd)\nos.system('ls')"],
    [
      'a temporary directory with a place of its own',
      "import os, tempfile\nd = tempfile.mkdtemp(dir='/x')\nos.chdir(d)\nos.system('ls')",
    ],
    [
      'tempfile bound again',
      "import os, tempfile\ntempfile = fake\nd = tempfile.mkdtemp()\nos.chdir(d)\nos.system('ls')",
    ],
    [
      'a temporary directory it writes a script into',
      "import os, tempfile\nd = tempfile.mkdtemp()\nos.chdir(d)\nopen('x.sh', 'w').write(s)\nos.system('sh x.sh')",
    ],
    ['chdir passed on', "import os\nf = os.chdir\nos.system('ls')"],
    [
      'a name given a temporary directory and something else',
      "import os, tempfile\nd = tempfile.mkdtemp()\nd = x\nos.chdir(d)\nos.system('ls')",
    ],
  ])('is not read: %s', (_name, program) => {
    expect(readPythonProcesses(program)?.unread).toBe(true);
  });
});

describe('a directory that is not read', () => {
  it('matters only where the program starts a process', () => {
    const reading = readPythonProcesses("import os\nos.chdir(d)\nprint(os.listdir('.'))");
    expect(reading?.unread).toBe(false);
  });
});

describe('a way to start a process whose command is not read', () => {
  it.each([
    ['a command the program makes', 'import os\nos.system(cmd)'],
    ['a list the program makes', 'import subprocess\nsubprocess.run(cmd)'],
    ['a line the program makes, to a shell', 'import subprocess\nsubprocess.run(cmd, shell=True)'],
    ['a shell chosen as it runs', "import subprocess\nsubprocess.run(['ls'], shell=flag)"],
    ['a program name the program makes', "import subprocess\nsubprocess.run([prog, '-x'])"],
    [
      'a word the program makes',
      "import subprocess, sys\nsubprocess.run(['rm', sys.argv[1], '/'])",
    ],
    ['a word made of others', "import subprocess\nsubprocess.run(['rm', '-' + 'rf', '/'])"],
    [
      'a name bound twice',
      "import subprocess\nf = '-v'\nf = '-rf'\nsubprocess.run(['rm', f, '/'])",
    ],
    [
      'a name a with statement binds in a tuple',
      "import subprocess\nf = '-v'\nwith ctx() as (f, g):\n    subprocess.run(['rm', f, '/'])",
    ],
    [
      'a name a case pattern binds in a mapping',
      "import subprocess\nf = '-v'\nmatch x:\n    case {'k': f}:\n        subprocess.run(['rm', f, '/'])",
    ],
    [
      'a name a loop binds',
      "import subprocess\nf = '-v'\nfor f in a:\n    subprocess.run(['rm', f])",
    ],
    [
      'a name an import may bind',
      "from m import *\nimport subprocess\nf = '-v'\nsubprocess.run(['rm', f])",
    ],
    ['a name of the interpreter', "import subprocess\nsubprocess.run(['sh', '-c', __name__])"],
    [
      'a temporary file',
      "import subprocess, tempfile\nf = tempfile.mktemp()\nsubprocess.run(['mypy', f])",
    ],
    ['an f-string', "import os\nos.system(f'ls {d}')"],
    ['a format', "import os\nos.popen('git log -n %d' % n)"],
    [
      'an environment of its own',
      "import subprocess\nsubprocess.run(['ls'], env={'PATH': '/tmp'})",
    ],
    ['another executable', "import subprocess\nsubprocess.run(['ls'], executable='/bin/sh')"],
    ['an executable by position', "import subprocess\nsubprocess.Popen(['ls'], 0, '/bin/sh')"],
    ['a function run first', "import subprocess\nsubprocess.run(['ls'], preexec_fn=f)"],
    ['arguments unpacked', 'import subprocess\nsubprocess.run(*a)'],
    ['keywords unpacked', "import subprocess\nsubprocess.run(['ls'], **kw)"],
    ['words unpacked', "import subprocess\nsubprocess.run(['ls', *rest])"],
    ['a list added to', "import subprocess\nsubprocess.run(['ls'] + extra)"],
    ['a list made by a loop', 'import subprocess\nsubprocess.run([w for w in words])'],
    ['strings run together', "import os\nos.system('ls ' '-la')"],
    ['an escape', "import os\nos.system('ls\\n')"],
    ['bytes', "import os\nos.system(b'ls')"],
    ['the function passed on', 'import subprocess\nf = subprocess.run'],
    ['the function given to another', "import os\nlist(map(os.system, ['ls']))"],
    ['the module passed on', 'import subprocess\nx = subprocess\nx.run(c)'],
    ['the module reached through another', 'import asyncio\nm = asyncio.subprocess'],
    ['every name of a module', 'from subprocess import *\nrun(c)'],
    ['every name of os', 'from os import *'],
    ['an unknown subprocess name', 'import subprocess\nsubprocess._posixsubprocess'],
    ['os.execvp', "import os\nos.execvp('sh', ['sh'])"],
    ['os.spawnl', "import os\nos.spawnl(os.P_WAIT, '/bin/sh', 'sh')"],
    ['os.posix_spawn', "import os\nos.posix_spawn('/bin/sh', ['sh'], {})"],
    ['os.fork', 'import os\nos.fork()'],
    ['fork by name', 'from os import fork\nfork()'],
    ['pty', "import pty\npty.spawn('sh')"],
    ['asyncio', 'import asyncio\nasyncio.create_subprocess_shell(c)'],
    ['an event loop', "import asyncio\nasyncio.get_event_loop().subprocess_shell(P, 'ls')"],
    ['a module that runs commands', 'import sh\nsh.ls()'],
    [
      'a system of something else, given a line it makes',
      'import tempfile, sys\ntempfile._os.system(sys.argv[1])',
    ],
    ['a name imported for a function, used for another', 'from os import system as s\nt = s'],
    ['too many processes', `import os\n${"os.system('ls')\n".repeat(33)}`],
  ])('%s', (_name, program) => {
    expect(readPythonProcesses(program)?.unread).toBe(true);
  });
});

describe('the modules a program imports', () => {
  it.each([
    [
      'standard ones',
      'import os, sys, json, tempfile, subprocess\nfrom pathlib import Path',
      false,
    ],
    ['nothing', "print('x')", false],
    ['the package of the project', 'from dvc.config import Config', true],
    ['a package', 'import numpy as np', true],
    ['a relative one', 'from . import helpers', true],
    ['a part that loads what it is given', 'import logging.config', true],
    ['a module that runs commands its own way', 'import distutils.spawn', true],
  ])('%s', (_name, program, unknown) => {
    expect(readPythonProcesses(program)?.unknownModules).toBe(unknown);
  });
});

describe('a program that writes a file and starts a process', () => {
  it.each([
    ['writes a script and runs it', "import os\nopen('x.sh', 'w').write(s)\nos.system('sh x.sh')"],
    [
      'writes a file and checks it',
      "import subprocess, sys\nwith open('/tmp/t.py', 'w') as f:\n    f.write(c)\nsubprocess.run([sys.executable, '-m', 'mypy', '/tmp/t.py'])",
    ],
    [
      'copies a file and runs it',
      "import os, shutil\nshutil.copy(a, 'run.sh')\nos.system('sh run.sh')",
    ],
    [
      'opens a file in a mode it makes',
      "import os\nopen('x.sh', mode).write(s)\nos.system('sh x.sh')",
    ],
    [
      'fetches and runs',
      "import os, urllib.request\nurllib.request.urlopen(u).read()\nos.system('sh x.sh')",
    ],
    [
      'fetches with asyncio and runs',
      "import asyncio, os\nasyncio.run(asyncio.open_connection('e.invalid', 80))\nos.system('sh x.sh')",
    ],
    [
      'unpacks a zip and runs',
      "import os, zipfile\nzipfile.ZipFile('a.zip').extractall()\nos.system('sh x.sh')",
    ],
    [
      'unpacks an archive and runs',
      "import os, shutil\nshutil.unpack_archive('a.tgz')\nos.system('sh x.sh')",
    ],
    [
      'writes through the open of a path',
      "import os, pathlib\nf = pathlib.Path('x.sh').open('w')\nprint('id', file=f)\nf.close()\nos.system('sh x.sh')",
    ],
    [
      'opens a file by its descriptor flags',
      "import os\nfd = os.open('x.sh', os.O_WRONLY | os.O_CREAT)\nos.system('sh x.sh')",
    ],
    ['opens a path in a mode it makes', "import io, os\nio.open('x.sh', m)\nos.system('sh x.sh')"],
  ])('is not read: %s', (_name, program) => {
    expect(readPythonProcesses(program)?.unread).toBe(true);
  });

  it.each([
    [
      'the builtin open',
      "import os\nprint(open('a.txt').read())\nprint(open('b.txt', 'rb').read())\nos.system('ls')",
    ],
    [
      'the open of a path',
      "import os, pathlib\nprint(pathlib.Path('a.txt').open().read())\nos.system('ls')",
    ],
    [
      'io.open, with a name that has the letters of a mode',
      "import io, os\nprint(io.open('data.txt', encoding='utf-8').read())\nos.system('ls')",
    ],
  ])('is read where it only reads files: %s', (_name, program) => {
    expect(readPythonProcesses(program)?.unread).toBe(false);
  });
});

describe('a string that may be code', () => {
  it.each([
    ['given to timeit', 'import timeit\ntimeit.timeit(\'import os; os.system("x")\', number=1)'],
    ['named for a function', "import pkgutil\npkgutil.resolve_name('os.system')('x')"],
    ['given to cProfile', "import cProfile\ncProfile.run('import subprocess')"],
    ['written to a file', "open('t.py', 'w').write('import subprocess')"],
    ['printed', "print('use subprocess')"],
  ])('is not taken for data: %s', (_name, program) => {
    expect(readPythonProcesses(program)?.hiddenPayload).toBe(true);
  });

  it('is read where it is the command a program starts', () => {
    const reading = readPythonProcesses(
      'import os\nos.system(\'python3 -c "import subprocess; print(1)"\')',
    );
    expect(reading?.hiddenPayload).toBe(false);
    expect(reading?.processes.map((p) => p.command)).toEqual([
      'python3 -c "import subprocess; print(1)"',
    ]);
  });
});

describe('a program that reaches names through strings, runs code it makes, or decodes', () => {
  it.each([
    ['getattr', "import os\ngetattr(os, 'sys' + 'tem')('ls')"],
    ['__import__', "__import__('os')"],
    ['eval', 'print(eval(x))'],
    ['exec of what it makes', 'exec(code)'],
    ['exec of the standard input', "exec(open('/dev/stdin').read())"],
    ['exec of a file named like an option', "exec(open('-W').read())"],
    ['exec of a file the program writes', "open('t.py', 'w').write(s)\nexec(open('t.py').read())"],
    [
      'exec of a file the program copies',
      "import shutil\nshutil.copy(a, 't.py')\nexec(open('t.py').read())",
    ],
    ['sys.modules', "import sys\nsys.modules['os'].system('ls')"],
    ['an environment changed', "import os\nos.environ['PATH'] = '/tmp'"],
    ['an environment added to', "import os\nos.environ['PATH'] += ':/tmp'"],
    ['an environment updated', "import os\nos.environ.update(PATH='/tmp')"],
    ['the environment as bytes changed', "import os\nos.environb[b'PATH'] = b'/tmp'"],
    ['the environment as bytes by name', 'from os import environb'],
    ['putenv', "import os\nos.putenv('PATH', '/tmp')"],
    ['environ by name', 'from os import environ'],
    ['a dunder', '().__class__.__base__.__subclasses__()'],
    ['base64', "import base64\nbase64.b64decode('aGk=')"],
    ['codecs', "import codecs\ncodecs.decode('x', 'rot13')"],
    ['fromhex', "bytes.fromhex('6869')"],
    ['importlib', "import importlib\nimportlib.import_module('os')"],
    ['pickle', 'import pickle\npickle.loads(b)'],
    ['timeit', 'import timeit\ntimeit.timeit(s)'],
    ['yaml', 'import yaml\nyaml.unsafe_load(t)'],
    ['os passed on', "import os\na = os\na.remove('x')"],
    ['os reached through another', 'import shutil\nm = shutil.os'],
    ['the module bound again', "import subprocess\nsubprocess = fake\nsubprocess.run(['ls'])"],
    ['the function bound again', "from subprocess import run\nrun = fake\nrun(['ls'])"],
    [
      'a parameter named for the module',
      "import subprocess\ndef f(subprocess):\n    subprocess.run(['ls'])",
    ],
  ])('%s', (_name, program) => {
    expect(readPythonProcesses(program)?.opaque).toBe(true);
  });

  it.each([
    [
      'an environment read',
      "import os\nprint(os.environ['HOME'], os.environ.get('USER'), os.getenv('X'))",
    ],
    ['a docstring', 'from subprocess import CalledProcessError\nprint(CalledProcessError.__doc__)'],
    ['the name of the module', "if __name__ == '__main__':\n    print(1)"],
    ['re.compile', "import re\nre.compile('x')"],
    ['a local module', 'from dvc.config import Config\nConfig()'],
    [
      'os.chdir and makedirs',
      "import os, tempfile\nd = tempfile.mkdtemp()\nos.chdir(d)\nos.makedirs('.dvc', exist_ok=True)",
    ],
    ['os, a word of the program', 'import platform\nos = platform.system().lower()\nprint(os)'],
    ['os, a loop', "for os in ['linux', 'mac']:\n    print(os)"],
    ['os bound again where it starts nothing', 'import os\nos = os.name\nprint(os)'],
  ])('is not opaque or unread: %s', (_name, program) => {
    const reading = readPythonProcesses(program);
    expect(reading?.opaque, program).toBe(program.includes('os = os.name'));
    expect(reading?.unread).toBe(false);
  });
});

describe('what starts nothing', () => {
  it.each([
    ['platform.system()', 'import platform\nprint(platform.system())'],
    [
      'an exception class',
      'from subprocess import CalledProcessError\nprint(CalledProcessError.__doc__)',
    ],
    [
      'constants',
      'import subprocess\nprint(subprocess.PIPE, subprocess.DEVNULL, subprocess.STDOUT)',
    ],
    [
      'a handler',
      'import subprocess\ntry:\n    pass\nexcept subprocess.CalledProcessError as e:\n    print(e)',
    ],
    ['the words in a comment', '# subprocess.run(x)\nprint(1)'],
    ['os.path', "import os\nprint(os.path.join('a', 'b'))"],
    ['a keyword argument named like the module', 'f(shell=True)'],
    [
      'raise from',
      "try:\n    int('x')\nexcept ValueError as e:\n    raise RuntimeError('bad') from e",
    ],
    ['yield from', 'def g():\n    yield from range(3)\nprint(list(g()))'],
    ['a greenlet', 'import gevent\ngevent.spawn(f).join()'],
    ['a fork of a repository', 'repo.fork()'],
    ['a word named fork', 'fork = 1\nprint(fork)'],
    ['a format with a date', "from datetime import datetime\nprint(f'{datetime.now():%H:%M}')"],
  ])('%s', (_name, program) => {
    const reading = readPythonProcesses(program);
    expect(reading?.processes).toEqual([]);
    expect(reading?.unread).toBe(false);
    expect(reading?.hiddenPayload).toBe(false);
  });
});

describe('a program that is not read', () => {
  it.each([
    ['brackets that do not pair', 'print((1])'],
    ['a backslash outside a string', 'print(1) \\ x'],
    ['a control character', 'print(1)\u0007'],
    ['too long', `print(1)\n${'x = 1\n'.repeat(4000)}`],
  ])('%s', (_name, program) => {
    expect(readPythonProcesses(program)).toBeNull();
  });
});

describe('reading time', () => {
  it('stays linear in deeply nested calls', () => {
    const program = `import os\n${'os.system('.repeat(1200)}'ls'${')'.repeat(1200)}`;
    const started = cpuNow();
    const reading = readPythonProcesses(program);
    expect(cpuNow() - started).toBeLessThan(500);
    expect(reading?.unread).toBe(true);
  });

  it.each([
    ['imports', `${'import os\n'.repeat(1500)}os.system('ls')`],
    ['for, for, for', 'for '.repeat(3500)],
    ['del, del, del', 'del '.repeat(3500)],
    ['def, def, def', 'def a( '.repeat(1800)],
  ])('stays linear in many %s', (_name, program) => {
    const started = cpuNow();
    readPythonProcesses(program);
    expect(cpuNow() - started).toBeLessThan(500);
  });
});
