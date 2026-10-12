import { describe, expect, it } from 'vitest';
import { lineOf, linesOf, passportOf, subjectsOf } from '../../helpers/inspect.js';

const js = (code: string, path = 'lib/server.js') => passportOf({ [path]: code }, { kind: 'mcp' });
const py = (code: string, path = 'server.py') => passportOf({ [path]: code }, { kind: 'mcp' });

describe('source heuristics: environment variables', () => {
  it('makes a cred.env line for each name read from process.env, with the line', () => {
    const passport = js(
      'const a = process.env.API_KEY;\nconst b = process.env["HOME"];\nconst c = process.env[`DEBUG`];\n',
    );

    expect(subjectsOf(passport, 'cred.env')).toEqual(['API_KEY', 'DEBUG', 'HOME']);
    expect(lineOf(passport, 'cred.env', 'API_KEY')).toMatchObject({
      basis: 'observed',
      where: [{ file: 'lib/server.js', line: 1 }],
    });
    expect(lineOf(passport, 'cred.env', 'HOME')?.where).toEqual([
      { file: 'lib/server.js', line: 2 },
    ]);
  });

  it('reads optional chaining and a name written in single quotes', () => {
    const passport = js("const a = process.env?.TOKEN_A; const b = process.env['TOKEN_B'];\n");

    expect(subjectsOf(passport, 'cred.env')).toEqual(['TOKEN_A', 'TOKEN_B']);
  });

  it('reads the names in a destructuring of process.env', () => {
    const passport = js("const { API_KEY, SECRET: s, REGION = 'eu' } = process.env;\n");

    expect(subjectsOf(passport, 'cred.env')).toEqual(['API_KEY', 'REGION', 'SECRET']);
  });

  it('reads Deno and Bun forms', () => {
    const passport = js("const a = Deno.env.get('DENO_TOKEN');\nconst b = Bun.env.BUN_KEY;\n");

    expect(subjectsOf(passport, 'cred.env')).toEqual(['BUN_KEY', 'DENO_TOKEN']);
  });

  it('reads the Python forms', () => {
    const passport = py(
      "import os\na = os.environ['PY_KEY']\nb = os.environ.get(\"PY_TOKEN\", '')\nc = os.getenv('PY_SECRET')\nd = os.environ[\"PY_NAME\"]\n",
    );

    expect(subjectsOf(passport, 'cred.env')).toEqual([
      'PY_KEY',
      'PY_NAME',
      'PY_SECRET',
      'PY_TOKEN',
    ]);
  });

  it('reads the forms of a Python file that imported the names', () => {
    const passport = py(
      "from os import environ, getenv\na = environ['IMPORTED_KEY']\nb = getenv('IMPORTED_TOKEN')\n",
    );

    expect(subjectsOf(passport, 'cred.env')).toEqual(['IMPORTED_KEY', 'IMPORTED_TOKEN']);
  });

  it('makes a sensitive line of the whole environment when it is used without a name', () => {
    const passport = js(
      'const env = { ...process.env, X: 1 };\nspawn("a", [], { env: process.env });\n',
    );

    expect(lineOf(passport, 'cred.env', 'process.env (the whole environment)')).toMatchObject({
      sensitive: true,
      basis: 'observed',
    });
    expect(
      subjectsOf(
        py('import os\nenv = dict(os.environ)\nfor k, v in os.environ.items():\n    pass\n'),
        'cred.env',
      ),
    ).toEqual(['os.environ (the whole environment)']);
  });

  it('does not count a named read as a read of the whole environment', () => {
    const passport = js('const a = process.env.PORT;\n');

    expect(subjectsOf(passport, 'cred.env')).toEqual(['PORT']);
  });

  it.each([
    ['API_KEY', true],
    ['MY_TOKEN', true],
    ['CLIENT_SECRET', true],
    ['DB_PASSWORD', true],
    ['DB_PASSWD', true],
    ['SERVICE_CREDENTIALS', true],
    ['AWS_REGION', true],
    ['GITHUB_ACTOR', true],
    ['OPENAI_BASE_URL', true],
    ['ANTHROPIC_MODEL', true],
    ['lowercase_token', true],
    ['PORT', false],
    ['HOME', false],
    ['NODE_ENV', false],
    ['DEBUG', false],
    ['MONKEY', true],
    ['TURKEY_COUNT', true],
  ])('judges %s sensitive: %s', (name, sensitive) => {
    expect(lineOf(js(`const v = process.env.${name};\n`), 'cred.env', name)?.sensitive).toBe(
      sensitive,
    );
  });

  it('says in the detector that it is a signal and not a verdict', () => {
    const line = lineOf(js('const v = process.env.API_KEY;\n'), 'cred.env', 'API_KEY');

    expect(line?.detector).toContain('not a verdict');
  });

  it('does not read a mention in a comment', () => {
    const passport = js(
      '// set process.env.COMMENTED_KEY first\n/* process.env.BLOCK_KEY */\n * process.env.STAR_KEY\nconst x = 1;\n',
    );

    expect(subjectsOf(passport, 'cred.env')).toEqual([]);
    expect(subjectsOf(py('# os.environ["HASHED"]\nx = 1\n'), 'cred.env')).toEqual([]);
  });

  it('does not read a name that is not a name', () => {
    const passport = js("const a = process.env[name];\nconst b = process.env['not a name'];\n");

    expect(subjectsOf(passport, 'cred.env')).toEqual([]);
  });

  it('reads TypeScript, modules and CommonJS files, and Python, and not other files', () => {
    const files = Object.fromEntries(
      ['a.ts', 'b.tsx', 'c.mjs', 'd.cjs', 'e.jsx', 'f.mts', 'g.cts', 'h.py'].map((name, i) => [
        name,
        name.endsWith('.py')
          ? `import os\nx = os.getenv('FILE_${i}')\n`
          : `const x = process.env.FILE_${i};\n`,
      ]),
    );
    const passport = passportOf({
      ...files,
      'notes.txt': 'process.env.NOT_READ',
      'README.md': 'process.env.ALSO_NOT',
    });

    expect(subjectsOf(passport, 'cred.env')).toHaveLength(8);
  });

  it('reads a script with a node shebang and no extension', () => {
    const passport = passportOf({
      'bin/tool': { text: '#!/usr/bin/env node\nconst k = process.env.SHEBANG_KEY;\n', exec: true },
    });

    expect(subjectsOf(passport, 'cred.env')).toEqual(['SHEBANG_KEY']);
  });

  it('lists a name once with every place', () => {
    const passport = passportOf({
      'a.js': 'process.env.SAME_KEY;\n',
      'b.js': '\nprocess.env.SAME_KEY;\n',
    });

    expect(linesOf(passport, 'cred.env')).toHaveLength(1);
    expect(linesOf(passport, 'cred.env')[0]?.where).toEqual([
      { file: 'a.js', line: 1 },
      { file: 'b.js', line: 2 },
    ]);
  });
});
