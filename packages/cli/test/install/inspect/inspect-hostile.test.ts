import { describe, expect, it } from 'vitest';
import { MAX_LINES, SOURCE_MATCHES_MAX } from '../../../src/install/inspect/blind-spots.js';
import { cpuNow } from '../../helpers/cpu-time.js';
import { linesOf, passportOf, skillWith, type Files } from '../../helpers/inspect.js';

/**
 * A tree is somebody else's, and the reading of it is done before anything is decided about it, so
 * the work must follow the size of the tree and not what was put in it. Every case here builds the
 * input that costs most per byte for one of the readers, in processor time (never the wall clock), and
 * parses the passport through its schema, as every test of the inspectors does.
 */
const MIB = 1024 * 1024;
/** Many times what the reading of any of these needs on the machine the bounds were written on. */
const BOUND_MS = 6000;

const fill = (unit: string, bytes: number): string =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

function took(
  files: Files,
  overrides: Parameters<typeof passportOf>[1] = {},
): { ms: number; passport: ReturnType<typeof passportOf> } {
  const started = cpuNow();
  const passport = passportOf(files, overrides);
  return { ms: cpuNow() - started, passport };
}

describe('a megabyte on one line, in each kind of file', () => {
  const line = (unit: string) => fill(unit, MIB);

  it.each([
    ['a.js', 'process.env.A;'],
    ['a.py', "os.environ['A'];"],
    ['a.ts', 'fetch(url);'],
    ['notes.md', '!`ls` '],
    ['notes.md', '```sh '],
    ['SKILL.md', '---'],
    ['SKILL.md', 'a: '],
    ['package.json', '{"a":'],
    ['requirements.txt', 'a @ https://x.example/y '],
    ['pyproject.toml', '"a @ git+https://x.example/y", '],
    ['.mcp.json', '{"command":"a","args":["b"]},'],
    ['.gitmodules', '[submodule "a"] url = https://x.example/y '],
    ['.gitattributes', '*.a filter=x '],
    ['scripts/run.sh', 'echo a;'],
  ])('reads %s made of %j in a bounded time', (name, unit) => {
    const { ms, passport } = took({ [name]: line(unit) });

    expect(passport.artifact.files).toBe(1);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe('many files', () => {
  it('reads five thousand tiny files of every kind in a bounded time', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5000; i += 1) {
      const n = String(i).padStart(4, '0');
      switch (i % 5) {
        case 0:
          files[`a/${n}.js`] =
            `const k = process.env.KEY_${i}; fetch('https://h${i}.example.io/x');\n`;
          break;
        case 1:
          files[`b/${n}.md`] = `\`\`\`sh\ncurl https://h${i}.example.io\n\`\`\`\n`;
          break;
        case 2:
          files[`c/${n}/SKILL.md`] = skillWith(`name: s${i}\nallowed-tools: Bash, Read`);
          break;
        case 3:
          files[`d/${n}/package.json`] = JSON.stringify({
            name: `p${i}`,
            scripts: { postinstall: `node ${i}.js` },
          });
          break;
        default:
          files[`e/${n}.py`] = `import os\nx = os.environ['K${i}']\n`;
      }
    }

    const { ms, passport } = took(files);

    expect(passport.artifact.files).toBe(5000);
    expect(passport.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('reads two thousand hostile front matters under a budget, and says it left the rest', () => {
    const block = `---\n${Array.from({ length: 2000 }, (_, i) => `k${i}: ${i}`)
      .join('\n')
      .slice(0, 16_000)}\n---\n`;
    const files = Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`s${i}/SKILL.md`, block]),
    );

    const { ms, passport } = took(files);

    expect(ms).toBeLessThan(BOUND_MS);
    expect(
      passport.blindSpots.some((spot) =>
        spot.includes(
          'front matter blocks were not read, because the reading of front matter has a limit',
        ),
      ),
    ).toBe(true);
  });
});

describe('text built to be slow for a pattern', () => {
  it('reads a file that is every shape that a pattern of the source readers starts to match', () => {
    const shapes = [
      'process.env.',
      'process.env[',
      "process.env['",
      'process.env?.',
      'const {',
      'const { A, B',
      'os.environ[',
      'os.environ.get(',
      'os.getenv(',
      'fetch(',
      'fetch(url',
      'axios.get(',
      'requests.get(',
      'urlopen(',
      'https://',
      "'https://'",
      '"https://" +',
      'https://${',
      'http://[',
      'exec ',
      'eval ',
      'Function ',
      'child_process',
      "require('",
      "from '",
      'subprocess',
      'os.system',
      'vm.',
      '\\x41',
      '\\u00',
      '_0x1a2b',
      '$(',
      '${',
    ];
    const text = fill(shapes.join(' '), MIB);

    const js = took({ 'a.js': text });
    const py = took({ 'a.py': text });

    expect(js.ms).toBeLessThan(BOUND_MS);
    expect(py.ms).toBeLessThan(BOUND_MS);
  });

  it('reads eight mebibytes of lines that each give a finding in a bounded time', () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `f${i}.js`,
        fill(`eval(x); exec(y); process.env.K${i}; fetch("https://h${i}.example.io/");\n`, MIB),
      ]),
    );

    const { ms, passport } = took(files);

    expect(ms).toBeLessThan(BOUND_MS);
    expect(passport.blindSpots.some((spot) => spot.includes('was cut at the number'))).toBe(true);
  });
});

describe('budgets that the readers hold to', () => {
  it('follows no more matches of the source patterns than the budget, and says so', () => {
    const files = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `f${String(i).padStart(2, '0')}.js`,
        Array.from({ length: SOURCE_MATCHES_MAX / 10 }, (_, j) => `process.env.V${i}_${j};`).join(
          '\n',
        ),
      ]),
    );

    const { passport } = took(files);

    expect(linesOf(passport, 'cred.env').length).toBeLessThanOrEqual(MAX_LINES);
    expect(passport.blindSpots.some((spot) => spot.includes('was cut at the number'))).toBe(true);
  });

  it('lists the most lines a passport lists when there are many more, the sensitive ones first', () => {
    const names = Array.from({ length: 800 }, (_, i) =>
      i % 2 === 0 ? `PLAIN_${i}` : `TOKEN_${i}`,
    );
    const { passport } = took({ 'a.js': names.map((name) => `process.env.${name};`).join('\n') });

    expect(passport.lines).toHaveLength(MAX_LINES);
    expect(passport.lines.filter((line) => line.sensitive)).toHaveLength(400);
    expect(
      passport.blindSpots.some((spot) => spot.startsWith('300 more findings were found')),
    ).toBe(true);
  });
});

describe('text that is not text', () => {
  it('counts files that are not UTF-8 and reads the rest', () => {
    const bad = Uint8Array.from([0xff, 0xfe, 0xfd, 0x70, 0x72, 0x6f]);
    const { passport } = took({
      'a.js': { bytes: bad },
      'SKILL.md': { bytes: bad },
      'package.json': { bytes: bad },
      'ok.js': 'process.env.FINE_KEY;\n',
    });

    expect(passport.blindSpots.some((spot) => spot.startsWith('3 files looked binary'))).toBe(true);
    expect(linesOf(passport, 'cred.env').map((line) => line.subject)).toEqual(['FINE_KEY']);
  });

  it('reads files with names and contents full of characters a passport cannot hold', () => {
    const nasty = 'a\u202eb\u200bc\u0001d\ud800e';
    const { passport } = took({
      'dir/$(id)/odd name.js': `process.env.${'X'.repeat(200)};\n// ${nasty}\nfetch("https://${nasty}.example/")\n`,
      [`${'long'.repeat(55)}.js`]: 'eval(x);\n',
      'hooks.json': JSON.stringify({
        hooks: { [nasty]: [{ hooks: [{ type: 'command', command: nasty }] }] },
      }),
    });

    expect(JSON.stringify(passport)).not.toMatch(/[\u202e\u200b\u0001]/);
    expect(passport.lines.length).toBeGreaterThan(0);
  });
});
