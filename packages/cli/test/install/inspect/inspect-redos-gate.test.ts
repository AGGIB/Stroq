import { describe, expect, it } from 'vitest';
import { addressOf } from '../../../src/install/inspect/addresses.js';
import { inspectTree } from '../../../src/install/inspect/index.js';
import { readMarkdownShell } from '../../../src/install/inspect/markdown-shell.js';
import { obfuscationReasons } from '../../../src/install/inspect/obfuscation.js';
import { showable } from '../../../src/install/inspect/safe-text.js';
import { shebangInterpreter } from '../../../src/install/inspect/shell-sources.js';
import { splitToolList, toolIsSensitive } from '../../../src/install/inspect/tool-spec.js';
import { buildTree } from '../../../src/install/tree.js';
import { cpuNow } from '../../helpers/cpu-time.js';
import { CONTEXT } from '../../helpers/inspect.js';
import { fileEntry } from '../../helpers/install-tree.js';

/**
 * The text of an artifact is written by whoever wrote the artifact, and the inspectors run a good
 * many patterns over it before anything is decided. A pattern that goes super-linear on some text
 * would let an artifact of a few hundred kilobytes hold `stroq vet` for minutes, so every reader is timed
 * on text built to be slow for a pattern, at three sizes, in processor time (never the wall clock).
 *
 * What is held is the growth, not a number of milliseconds, as in `safe-path-redos-gate.test.ts`: each
 * shape is timed at a sixteenth of the top size, a quarter of it and all of it, and each time is
 * compared with the one before. Linear work takes about four times as long for four times the text; a
 * quadratic pattern takes sixteen. Only a time that is both slow and growing faster than it should
 * fails, and a size that looks too slow is timed again, because noise only adds.
 */
const SIZE = 256 * 1024;
const SIZES = [SIZE / 16, SIZE / 4, SIZE] as const;
/** A time under this is not slow, however much it grew. */
const BOUND_MS = 300;
const MAX_GROWTH = 11;
const TRIES = 3;

const repeat =
  (unit: string) =>
  (size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

type Shape = (size: number) => string;

/** Near misses of what each pattern looks for, repeated: each is the start of something the patterns match. */
const SHAPES: readonly (readonly [name: string, shape: Shape])[] = [
  ...[
    'process.env.',
    'process.env[',
    "process.env['",
    'process.env?.',
    'process.env',
    'const {',
    'const { A, B',
    'const { A } = process.env',
    'os.environ[',
    "os.environ['",
    'os.environ.get(',
    "os.getenv('",
    'environ[',
    'getenv(',
    'Deno.env.get(',
    'Bun.env.',
    'import.meta.env.',
    'fetch(',
    'fetch(url',
    'fetch (  ',
    'axios.get(',
    'axios.',
    'requests.get(',
    'urlopen(',
    'https://',
    'http://[',
    'https:/',
    "'https://'",
    '"https://" +',
    'https://${',
    'https://{',
    'https://%s',
    'exec',
    'exec ',
    'exec (',
    'eval',
    'eval ',
    'Function',
    'Function (',
    'new Function',
    'child_process',
    "require('",
    "require('child",
    "from '",
    'subprocess',
    'os.system',
    'os.exec',
    'pty.spawn',
    'asyncio.create_subprocess_',
    'vm.',
    'vm.runIn',
    'Bun.spawn',
    '\\x41',
    '\\x4',
    '\\u004',
    '\\',
    '_0x1a2b',
    '_0x1a',
    'Qk',
    '+/',
    '{[(<>)]};:,.!?',
  ].map((unit): readonly [string, Shape] => [JSON.stringify(unit), repeat(unit)]),
  ['long blanks after a word', (size) => `exec${' '.repeat(size)}`],
  ['long blanks after an open call', (size) => `fetch(${' '.repeat(size)}`],
  ['a long word after fetch(', (size) => `fetch(${'a'.repeat(size)}`],
  ['a long run of dots after fetch(', (size) => `fetch(a${'.'.repeat(size)}`],
  ['a long url', (size) => `https://${'a'.repeat(size)}`],
  ['a long url in brackets', (size) => `https://[${'a'.repeat(size)}`],
  ['a long braces list', (size) => `const {${'A,'.repeat(size / 2)}`],
  ['unicode marks', repeat('é̖')],
  ['astral characters', repeat('\u{1f600}')],
  ['lone surrogates', repeat('\ud800')],
  ['controls', repeat('\u0001\u001b')],
];

const inspectOne = (path: string, text: string): unknown =>
  inspectTree(buildTree([fileEntry(path, text)], { complete: true }), CONTEXT);

type EntryPoint = (text: string) => unknown;

const ENTRY_POINTS: readonly (readonly [name: string, run: EntryPoint])[] = [
  ['a JavaScript file', (text) => inspectOne('a.js', text)],
  ['a Python file', (text) => inspectOne('a.py', text)],
  [
    'a script with a shebang and no extension',
    (text) => inspectOne('bin/tool', `#!/usr/bin/env node\n${text}`),
  ],
  ['the front matter of a skill', (text) => inspectOne('SKILL.md', `---\n${text}\n---\n`)],
  ['a skill whose front matter is never closed', (text) => inspectOne('SKILL.md', `---\n${text}`)],
  [
    'a package.json',
    (text) =>
      inspectOne(
        'package.json',
        `{"name":"x","scripts":{"postinstall":${JSON.stringify(text)}},"dependencies":{"d":${JSON.stringify(text)}}}`,
      ),
  ],
  ['a requirements.txt', (text) => inspectOne('requirements.txt', text)],
  ['a pyproject.toml', (text) => inspectOne('pyproject.toml', `[tool.uv.sources]\n${text}`)],
  ['a .gitmodules', (text) => inspectOne('.gitmodules', text)],
  ['a .gitattributes', (text) => inspectOne('.gitattributes', text)],
  [
    'a .mcp.json',
    (text) =>
      inspectOne(
        '.mcp.json',
        `{"mcpServers":{"s":{"command":${JSON.stringify(text)},"env":{"A":${JSON.stringify(text)}}}}}`,
      ),
  ],
  ['a dev container', (text) => inspectOne('.devcontainer/devcontainer.json', text)],
  ['an editor task file', (text) => inspectOne('.vscode/tasks.json', text)],
  ['a Markdown file (the scanner, not the shell it finds)', (text) => readMarkdownShell(text)],
  ['obfuscationReasons', (text) => obfuscationReasons(text)],
  ['splitToolList', (text) => splitToolList(text)],
  ['toolIsSensitive', (text) => toolIsSensitive(text.slice(0, 4096))],
  ['addressOf', (text) => addressOf(text)],
  ['shebangInterpreter', (text) => shebangInterpreter(`#!${text}`)],
  ['showable', (text) => showable(text, 200)],
];

const timed = (run: () => unknown): number => {
  const started = cpuNow();
  run();
  return cpuNow() - started;
};

/** Fails if a time is both slow and more than `MAX_GROWTH` times the one before it. */
function expectLinear(inputs: readonly string[], run: EntryPoint): void {
  const times: number[] = [];
  for (const input of inputs) {
    const before = times[times.length - 1];
    let took = timed(() => run(input));
    for (
      let tries = 1;
      tries < TRIES && before !== undefined && took >= BOUND_MS && took >= MAX_GROWTH * before;
      tries += 1
    ) {
      took = Math.min(
        took,
        timed(() => run(input)),
      );
    }
    times.push(took);
  }
  const growth = times.map((ms, i) => `${ms.toFixed(1)} ms at ${(SIZES[i] ?? 0) / 1024} KiB`);
  for (let i = 1; i < times.length; i += 1) {
    const small = times[i - 1] ?? 0;
    const big = times[i] ?? 0;
    expect(big < BOUND_MS || big < MAX_GROWTH * small, growth.join(', ')).toBe(true);
  }
}

describe('the gate itself', () => {
  // A gate that nothing fails proves nothing: this reader is quadratic on purpose, and must be caught.
  it('fails a reader whose work grows with the square of the text', () => {
    const quadratic = (text: string): number => {
      let total = 0;
      for (let i = 0; i < text.length; i += 1) {
        for (let j = 0; j < i / 64; j += 1) total += j;
      }
      return total;
    };

    expect(() =>
      expectLinear(
        SIZES.map((size) => 'a'.repeat(size)),
        quadratic,
      ),
    ).toThrow();
  });

  it('passes a reader whose work grows with the text', () => {
    const linear = (text: string): number => {
      let total = 0;
      for (let i = 0; i < text.length; i += 1) total += text.charCodeAt(i);
      return total;
    };

    expect(() =>
      expectLinear(
        SIZES.map((size) => 'a'.repeat(size)),
        linear,
      ),
    ).not.toThrow();
  });
});

describe('the inspectors stay linear on text built to be slow', () => {
  describe.each(ENTRY_POINTS)('%s', (_name, run) => {
    it.each(SHAPES)('%s', (_shape, build) => {
      expectLinear(
        SIZES.map((size) => build(size)),
        run,
      );
    });
  });
});
