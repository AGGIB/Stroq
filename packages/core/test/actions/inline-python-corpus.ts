/**
 * Python programs as agents write them to read what a command printed, and the ones that run code,
 * for the tests of `judgePythonProgram`: the reader's own (`inline-python.test.ts`) and the
 * interpreter's (`inline-python-oracle.test.ts`), which runs each one that is read as data under an
 * audit hook.
 */

type Program = readonly [name: string, program: string];

/** Programs that only handle data. */
export const DATA_PROGRAMS: readonly Program[] = [
  [
    'raise SystemExit',
    'import json,sys\ntry:\n    d = json.load(sys.stdin)\nexcept Exception as e:\n    print("no json:", e)\n    raise SystemExit',
  ],
  ['raise SystemExit with a code', 'import sys\nif not sys.stdin.read():\n    raise SystemExit(2)'],
  ['one line', "import json,sys; d=json.load(sys.stdin); print(d['x'])"],
  [
    'json.dumps with keywords',
    'import json, sys\nprint(json.dumps(json.load(sys.stdin), indent=2, sort_keys=True))',
  ],
  [
    'a loop over lines',
    'import sys, json\nfor line in sys.stdin:\n    row = json.loads(line)\n    print(row["id"], row.get("name", ""))',
  ],
  [
    'a nested loop with a join and a lower',
    [
      'import json,sys',
      "d=json.load(sys.stdin)['nodes']",
      'for k,v in sorted(d.items()):',
      "    loc=v.get('location',[])",
      "    if loc and loc[0].lower()=='ru':",
      "        print(k, '|', ' / '.join(str(x) for x in loc))",
    ].join('\n'),
  ],
  ['a regular expression', "import re,sys; print(re.sub(r'\\s+', ' ', sys.stdin.read()).strip())"],
  [
    'a compiled regular expression',
    "import re, sys\np = re.compile(r'v(\\d+)')\nprint(p.findall(sys.stdin.read()))",
  ],
  [
    'a date',
    'from datetime import datetime; print(datetime.fromtimestamp(1700000000).isoformat())',
  ],
  ['a date and a delta', 'import datetime as dt\nprint(dt.datetime.now() - dt.timedelta(days=3))'],
  [
    'an f-string',
    "import json,sys\nd=json.load(sys.stdin)\nfor k,v in d.items(): print(f'{k}: {v}')",
  ],
  [
    'an f-string with a format and a subscript',
    'import json,sys\nd=json.load(sys.stdin)\nprint(f\'{d["n"]:>10} {len(d):04d}\')',
  ],
  ['a quote of the other kind in a field', 'import sys\nprint(f"{sys.argv[0]!r:>5}")'],
  [
    'collections',
    'import json,sys\nfrom collections import Counter\nprint(Counter(x["t"] for x in json.load(sys.stdin)).most_common(3))',
  ],
  [
    'urllib.parse',
    'from urllib.parse import urlparse, quote\nprint(urlparse(input_url := "https://a.b/c").netloc, quote("a b"))',
  ],
  ['a hash', 'import hashlib,sys; print(hashlib.sha256(sys.stdin.read().encode()).hexdigest())'],
  [
    'a try and a lambda',
    'import json,sys\ntry:\n    d=json.load(sys.stdin)\nexcept Exception as e:\n    print("no json")\n    sys.exit(1)\nprint(sorted(d, key=lambda x: x["n"]))',
  ],
  [
    'a def',
    'import json,sys\ndef total(rows):\n    return sum(r["n"] for r in rows)\nprint(total(json.load(sys.stdin)))',
  ],
  [
    'a comment and a continuation',
    'import json,sys  # read it\nd = json.load(sys.stdin)\nprint(d["a"] \\\n   + d["b"])',
  ],
  ['a docstring-like triple string', 'import sys\nprint("""one\ntwo""", len(sys.stdin.read()))'],
  [
    'a variable called match',
    "import re,sys\nmatch = re.search(r'x', sys.stdin.read())\nprint(match.group(0) if match else None)",
  ],
  ['non-ASCII in a string', "print('Готово ✓')"],
  ['numbers', 'print(0x1f, 1_000, 3.5e2, 2j, .5)'],
  ['a csv', 'import csv,sys\nfor row in csv.reader(sys.stdin): print(row[0])'],
  [
    'an import of the whole of urllib.parse',
    'import urllib.parse\nprint(urllib.parse.quote("a b"))',
  ],
];

/** Programs that run code. */
export const EXEC_PROGRAMS: readonly Program[] = [
  ['exec of stdin', 'import sys; exec(sys.stdin.read())'],
  ['exec with a space', 'import sys; exec (sys.stdin.read())'],
  ['eval', 'import sys; print(eval(sys.stdin.read()))'],
  ['compile', 'import sys; compile(sys.stdin.read(), "x", "exec")'],
  ['__import__', "__import__('os').system('id')"],
  ['os.system', "import os; os.system('id')"],
  ['subprocess', "import subprocess; subprocess.run(['id'])"],
  ['popen', "import os; os.popen('id').read()"],
  ['importlib', "import importlib; importlib.import_module('os')"],
  ['getattr on the builtins', "getattr(__builtins__, 'exec')('1')"],
  ['ctypes', 'import ctypes'],
  ['pickle', 'import pickle,sys; pickle.loads(sys.stdin.buffer.read())'],
  ['an alias of a module', "import sys as os\nos.system('id')"],
  ['exec as a keyword argument name', 'print(exec=1)'],
  ['exec after a dot', 'x.exec(1)'],
];

/** Programs that cannot be told: not read, or naming something that is not on the list. */
export const UNKNOWN_PROGRAMS: readonly Program[] = [
  ['os for the environment', "import os\nprint(os.environ['HOME'])"],
  ['open', "print(open('/etc/hosts').read())"],
  ['input', 'print(input())'],
  ['type', 'print(type(1))'],
  ['a class', 'class A: pass'],
  ['a dunder attribute', 'print((1).__class__)'],
  ['a dunder name', 'print(__name__)'],
  ['a name nobody defined', 'print(undefined_name)'],
  ['an attribute that is not listed', 'import sys; sys.path.insert(0, "/tmp/x")'],
  ['sys.modules', 'import sys; print(sys.modules)'],
  ['raise of a class that is not a builtin', 'raise Boom(1)'],
  ['yield', 'def f():\n    yield 1'],
  ['an import of something else', 'import socket'],
  ['an import star', 'from sys import *'],
  ['a global', 'global x'],
  ['help', 'help()'],
  ['breakpoint', 'breakpoint()'],
  ['globals', 'print(globals())'],
  ['vars', 'print(vars())'],
  ['an unterminated string', "print('abc"],
  ['an unbalanced bracket', 'print((1)'],
  ['a closing bracket first', 'print(1))'],
  ['a letter that is not ASCII outside a string', 'print(ｅｘｅｃ)'],
  ['a number run into a word', 'print(1or exec)'],
  ['a hex number run into a word', 'print(0x1for 2)'],
  ['a carriage return', 'print(1)\rexec(x)'],
  ['a form feed', 'print(1)\fexec(x)'],
  ['a NUL', 'print(1)\u0000'],
  ['a dollar', 'print($x)'],
  ['a backtick', 'print(`x`)'],
  ['a backslash that continues nothing', 'print(1) \\ x'],
  ['a name run into a quote', 'print(x"abc")'],
  ['an f-string with a field of the same quote', "print(f'{d['a']}')"],
  ['an f-string with an unpaired brace', "print(f'{d')"],
  ['an f-string with a single closing brace', "print(f'a}b')"],
  ['an f-string with a backslash in a field', "print(f'{d[\\'a\\']}')"],
  ['an f-string with a name in the format', "print(f'{x:{y.z}}')"],
  ['an f-string with a call in the spec', "print(f'{x:{exec(1)}}')"],
  ['an f-string with exec in a field', "print(f'{exec(1)}')"],
  ['a program that is too long', `print(1)\n`.repeat(3000)],
];
