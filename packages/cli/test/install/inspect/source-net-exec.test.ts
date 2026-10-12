import { describe, expect, it } from 'vitest';
import { lineOf, linesOf, passportOf, subjectsOf } from '../../helpers/inspect.js';

const js = (code: string, path = 'lib/server.js') => passportOf({ [path]: code }, { kind: 'mcp' });
const py = (code: string, path = 'server.py') => passportOf({ [path]: code }, { kind: 'mcp' });

describe('source heuristics: addresses', () => {
  it('makes a sensitive net line of the host of a URL literal, with its line', () => {
    const passport = js("const a = 1;\nfetch('https://api.service.example/v1/items?x=1');\n");

    expect(lineOf(passport, 'net', 'api.service.example')).toMatchObject({
      basis: 'observed',
      sensitive: true,
      where: [{ file: 'lib/server.js', line: 2 }],
    });
  });

  it('takes the host a client would connect to', () => {
    const passport = js("fetch('https://user:pw@Host.Example:8443/path');\n");

    expect(subjectsOf(passport, 'net')).toEqual(['host.example']);
    expect(JSON.stringify(passport)).not.toContain('pw@');
  });

  it('reads URLs in Python and in several quotes', () => {
    const passport = py(
      "a = 'http://one.example/x'\nb = \"https://two.example\"\nc = f'https://three.example/{x}'\n",
    );

    expect(subjectsOf(passport, 'net')).toEqual(['one.example', 'three.example', 'two.example']);
  });

  it.each([
    'localhost',
    '127.0.0.1',
    '127.1.2.3',
    '[::1]',
    'example.com',
    'example.org',
    'www.example.net',
    'www.w3.org',
    'json-schema.org',
  ])('lists %s without making it sensitive', (host) => {
    const line = js(`const u = 'http://${host}/x';\n`).lines.find(
      (candidate) => candidate.kind === 'net',
    );

    expect(line?.sensitive).toBe(false);
  });

  it('does not list a URL on a line that is a comment, and does list one in a block comment', () => {
    const passport = js(
      '// see https://docs.example.org/guide\n/* https://block.example/x */\nconst x = 1;\n',
    );

    expect(subjectsOf(passport, 'net')).toEqual(['block.example']);
  });

  it('makes a net line of unknown host for an address built from a variable', () => {
    const passport = js(
      'const url = base + "/x";\nfetch(url);\nconst r = await axios.get(target);\n',
    );

    expect(lineOf(passport, 'net', 'unknown')).toMatchObject({
      basis: 'unknown',
      sensitive: true,
      where: [
        { file: 'lib/server.js', line: 2 },
        { file: 'lib/server.js', line: 3 },
      ],
    });
  });

  it.each([
    'fetch(`https://${host}/x`)',
    'const u = "https://" + host + "/x"',
    "const u = 'http://' + h",
    'const u = `http://${process.env.HOST}`',
  ])('makes a net line of unknown host for %s', (code) => {
    const passport = js(`${code};\n`);

    expect(subjectsOf(passport, 'net')).toContain('unknown');
  });

  it('makes a net line of unknown host for Python calls with an address that is a variable', () => {
    const passport = py(
      'import requests\nr = requests.get(url)\nu = urlopen(addr)\nh = f"https://{host}/x"\n',
    );

    expect(lineOf(passport, 'net', 'unknown')?.where).toHaveLength(3);
  });

  it('does not take a call with a literal address for one with an unknown address', () => {
    const passport = js("fetch('/relative/path');\nfetch('https://known.example/x');\n");

    expect(subjectsOf(passport, 'net')).toEqual(['known.example']);
  });

  it('says in the detector that it is a signal and not a verdict', () => {
    const line = lineOf(js("fetch('https://api.example.io/x');\n"), 'net', 'api.example.io');

    expect(line?.detector).toContain('not a verdict');
  });

  it('cuts the number of addresses it lists from one file, and says so', () => {
    const code = Array.from({ length: 400 }, (_, i) => `u${i} = 'https://h${i}.example.io/x'`).join(
      '\n',
    );
    const passport = py(`${code}\n`);

    expect(linesOf(passport, 'net')).toHaveLength(200);
    expect(passport.blindSpots.some((spot) => spot.includes('was cut at the number'))).toBe(true);
  });
});

describe('source heuristics: running programs and code', () => {
  it.each([
    ["const { exec } = require('child_process');\nexec('ls');\n", 'child_process'],
    ["import { spawn } from 'node:child_process';\nspawn('ls');\n", 'child_process'],
    ["import cp from 'child_process';\n", 'child_process'],
    ["const execa = require('execa');\n", 'child_process'],
    ["import { $ } from 'execa';\n", 'child_process'],
    ["const x = require('cross-spawn');\n", 'child_process'],
    ["const sh = require('shelljs');\n", 'child_process'],
  ])('makes an exec line and a signal for a JS file that uses %#', (code, api) => {
    const passport = js(code);

    expect(lineOf(passport, 'exec', api)).toMatchObject({ sensitive: true, basis: 'observed' });
    expect(passport.signals.map((signal) => signal.ruleId)).toContain('process-spawn');
  });

  it.each([
    ['import subprocess\nsubprocess.run(["ls"])\n', 'subprocess'],
    ['import os\nos.system("ls")\n', 'os.system'],
    ['import os\nos.popen("ls")\n', 'os.popen'],
    ['import pty\npty.spawn("sh")\n', 'pty.spawn'],
    ['import asyncio\nawait asyncio.create_subprocess_shell("ls")\n', 'asyncio.create_subprocess'],
  ])('makes an exec line and a signal for Python: %#', (code, api) => {
    const passport = py(code);

    expect(lineOf(passport, 'exec', api)?.sensitive).toBe(true);
    expect(passport.signals.map((signal) => signal.ruleId)).toContain('process-spawn');
  });

  it.each([
    ['eval(code);\n', 'eval()'],
    ['const f = new Function("return 1");\n', 'Function()'],
    ['const g = Function("a", "return a");\n', 'Function()'],
    ['exec(command);\n', 'exec()'],
    ['const vm = require("vm"); vm.runInNewContext(src);\n', 'vm'],
  ])('makes an exec line and a dynamic-code signal for JS: %#', (code, api) => {
    const passport = js(code);

    expect(lineOf(passport, 'exec', api)).toMatchObject({ sensitive: true });
    expect(passport.signals.map((signal) => signal.ruleId)).toContain('dynamic-code');
  });

  it('makes them for Python eval and exec too', () => {
    const passport = py('eval(expr)\nexec(source)\n');

    expect(subjectsOf(passport, 'exec')).toEqual(['eval()', 'exec()']);
  });

  it('does not take a method called exec, or a function with the name inside another word, for code', () => {
    const passport = js(
      'const m = /a/.exec(text);\nconst n = re.exec(x);\nfunction myeval(a) {}\nconst o = obj.eval(y);\nconst p = Function.prototype;\nfunction Functional(x) {}\n',
    );

    expect(linesOf(passport, 'exec')).toEqual([]);
    expect(passport.signals).toEqual([]);
  });

  it('does not read a mention on a line that is a comment, and reads one that follows a block comment', () => {
    const passport = js('// uses child_process and eval(x)\n/* note */ exec(y);\n');

    expect(subjectsOf(passport, 'exec')).toEqual(['exec()']);
  });

  it('points at the line of the use', () => {
    const passport = js('const a = 1;\nconst b = 2;\neval(c);\n');

    expect(lineOf(passport, 'exec', 'eval()')?.where).toEqual([{ file: 'lib/server.js', line: 3 }]);
  });
});
