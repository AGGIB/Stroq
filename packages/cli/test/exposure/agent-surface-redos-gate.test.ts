import { describe, it } from 'vitest';
import { tagChanges, type TaggedHit } from '../../src/exposure/agent-change.js';
import { hit } from '../../src/exposure/agent-kinds.js';
import { pathWords } from '../../src/exposure/agent-run-files.js';
import { scanFile } from '../../src/exposure/agent-surface.js';
import { annotations, githubSummary } from '../../src/exposure/github-format.js';
import { linkTarget } from '../../src/exposure/git-tree.js';
import { lineOf, stripJsonc } from '../../src/exposure/jsonc.js';
import { expectLinear, repeat, SIZES, type EntryPoint } from '../helpers/linear-gate.js';

/**
 * Every file `stroq inspect` reads is written by the author of the change it checks, and in a
 * pull request check that author is the attacker. A reader that goes super-linear on some text
 * would let a change hold the check for minutes, so each reader is timed on text built to be
 * slow for it, at three sizes, in processor time; see `helpers/linear-gate.ts`.
 */
type Shape = (size: number) => string;

const SHAPES: readonly (readonly [name: string, shape: Shape])[] = [
  ...[
    '/*',
    '//',
    '/',
    '*/',
    '"',
    '\\"',
    '\\',
    ',',
    ', ',
    ',]',
    '[',
    '{',
    '"a":',
    '"hooks":{"S":[{"command":"',
    '#',
    '[[',
    '[a.',
    '"""',
    "'''",
    "'",
    // One single-quoted string after another on one line: each looked for the next newline.
    "'a'",
    "a='b' ",
    '"""a"""',
    'a = """\\\n',
    'command = "',
    'a = [',
    '{ a = ',
    'hooks.',
    'mcp_servers.',
    '\\u00',
    '‍',
    '\u{1F468}‍',
    '\u{E0041}',
    '\uFE0F',
    '\u2764\uFE0F\u200D',
    '\u{1F3FD}\u200D',
    '\u00AD',
    '\u0000',
    '.vscode/',
    '.vscode//',
    '.claude/settings.json',
    'CLAUDE.md ',
    'ANTHROPIC_',
    'DYLD_',
    'BASH_FUNC_',
    'GIT_',
    'aHelper',
    'Bash(',
    '$CLAUDE_PROJECT_DIR/',
    './a ',
    '"runOn": /**/',
    '---\n',
    'hooks:\n',
  ].map((unit): readonly [string, Shape] => [JSON.stringify(unit), repeat(unit)]),
  ['long blanks', (size) => `{${' '.repeat(size)}`],
  ['an unclosed comment', (size) => `/*${'x'.repeat(size)}`],
  ['an unclosed string', (size) => `"${'x'.repeat(size)}`],
  ['a long key path', (size) => `${'a.'.repeat(size / 2)}b = 1`],
  ['nested arrays', (size) => `a = ${'['.repeat(size / 2)}`],
  ['deep JSON arrays', (size) => `${'['.repeat(size / 2)}${']'.repeat(size / 2)}`],
  ['deep JSON objects', (size) => `${'{"a":'.repeat(size / 6)}1${'}'.repeat(size / 6)}`],
  ['controls', repeat('\u0001\u001b\r\n')],
];

const json = (text: string): string => JSON.stringify(text);
const hostile = (text: string): TaggedHit => ({
  ...hit('agent-hook', text.slice(0, 4096), 1, text, text),
  status: 'new',
});

const ENTRY_POINTS: readonly (readonly [name: string, run: EntryPoint])[] = [
  ['stripJsonc', (text) => stripJsonc(text)],
  ['lineOf', (text) => lineOf(text, ['"hooks"', '"S"', `${text.slice(0, 64)}x`])],
  ['a Claude settings file, raw', (text) => scanFile('.claude/settings.json', text)],
  [
    'a Claude settings file, as a hook command',
    (text) =>
      scanFile(
        '.claude/settings.json',
        `{"hooks":{"S":[{"hooks":[{"command":${json(text)}}]}]},"env":{"ANTHROPIC_BASE_URL":${json(text)}}}`,
      ),
  ],
  ['a tasks.json, raw', (text) => scanFile('.vscode/tasks.json', text)],
  [
    'a VS Code auto-approve value',
    (text) => scanFile('.vscode/settings.json', `{"chat.tools.autoApprove":${text}}`),
  ],
  [
    'a tasks.json, as a task',
    (text) =>
      scanFile(
        '.vscode/tasks.json',
        `{"tasks":[{"label":${json(text)},"command":${json(text)},"dependsOn":[${json(text)}],"runOptions":{"runOn":"folderOpen"}}]}`,
      ),
  ],
  ['a server list, raw', (text) => scanFile('.mcp.json', text)],
  [
    'a server list, as a server',
    (text) =>
      scanFile('.mcp.json', `{"mcpServers":{"s":{"command":"bash","args":["-c",${json(text)}]}}}`),
  ],
  ['a Codex config.toml', (text) => scanFile('.codex/config.toml', text)],
  [
    'a Codex config.toml, as a server',
    (text) => scanFile('.codex/config.toml', `[mcp_servers.s]\ncommand = ${json(text)}\n`),
  ],
  ['a dev container', (text) => scanFile('.devcontainer/devcontainer.json', text)],
  [
    'a package.json install script',
    (text) => scanFile('package.json', `{"scripts":{"postinstall":${json(text)}}}`),
  ],
  [
    'an env name and an allow rule',
    (text) =>
      scanFile(
        '.claude/settings.json',
        `{"env":{${json(text)}:"x"},"permissions":{"allow":[${json(text)}]}}`,
      ),
  ],
  [
    'a settings key, and a command under it',
    (text) =>
      scanFile(
        '.claude/settings.json',
        `{${json(text)}:"x","k":{${json(text)}:{"command":${json(text)}}},"enabledMcpjsonServers":[${json(text)}]}`,
      ),
  ],
  ['the file words of a command line', (text) => pathWords(text)],
  ['an instruction file', (text) => scanFile('CLAUDE.md', text)],
  ['a file in a skill folder', (text) => scanFile('.claude/skills/s/ref.md', text)],
  ['an env name, tagged', (text) => tagChanges([hit('agent-env', 'f', 1, text, text)], null)],
  ['a link target', (text) => linkTarget('.claude/skills/x', text)],
  ['an agent definition', (text) => scanFile('.claude/agents/a.md', `---\n${text}\n---\n`)],
  ['GitHub annotations', (text) => annotations([hostile(text)], 'new')],
  ['a GitHub summary', (text) => githubSummary([hostile(text)], { failOn: 'new' })],
];

describe('the readers of stroq inspect stay linear on text built to be slow', () => {
  describe.each(ENTRY_POINTS)('%s', (_name, run) => {
    it.each(SHAPES)('%s', (_shape, build) => {
      expectLinear(
        SIZES.map((size) => build(size)),
        run,
      );
    });
  });
});

/** `count` entries made by `entry`, as many as fit in `size` characters. */
const many =
  (entry: (i: number) => string, join: string, open: string, close: string) =>
  (size: number): string => {
    const parts: string[] = [];
    for (let i = 0, used = open.length; used < size; i += 1) {
      const part = entry(i);
      parts.push(part);
      used += part.length + join.length;
    }
    return `${open}${parts.join(join)}${close}`;
  };

/** `i` written in capital letters, for names that take only letters. */
const letters = (i: number): string =>
  [...i.toString(26)].map((d) => String.fromCharCode(65 + parseInt(d, 26))).join('');

/**
 * One file with many entries: each entry's line was looked for from the top of the file, so
 * 40,000 servers in a megabyte took seconds. Every reader that reports one entry each is here.
 */
const MANY: readonly (readonly [name: string, path: string, build: (size: number) => string])[] = [
  [
    'MCP servers',
    '.mcp.json',
    many((i) => `"s${i}":{"command":"x"}`, ',', '{"mcpServers":{', '}}'),
  ],
  [
    'Codex servers',
    '.codex/config.toml',
    many((i) => `[mcp_servers.s${i}]\ncommand = "x"`, '\n', '', '\n'),
  ],
  [
    'folder-open tasks',
    '.vscode/tasks.json',
    many(
      (i) => `{"label":"t${i}","command":"x","runOptions":{"runOn":"folderOpen"}}`,
      ',',
      '{"tasks":[',
      ']}',
    ),
  ],
  [
    'enabled plugins',
    '.claude/settings.json',
    many((i) => `"p${i}@m":true`, ',', '{"enabledPlugins":{', '}}'),
  ],
  [
    'env variables that load code',
    '.claude/settings.json',
    many((i) => `"DYLD_${letters(i)}":"x"`, ',', '{"env":{', '}}'),
  ],
  [
    'helper keys',
    '.claude/settings.json',
    many((i) => `"k${letters(i)}Helper":"x"`, ',', '{', '}'),
  ],
  [
    'commands under settings keys',
    '.claude/settings.json',
    many((i) => `"k${i}":{"command":"x"}`, ',', '{', '}'),
  ],
  [
    'approved servers',
    '.claude/settings.json',
    many((i) => `"s${i}"`, ',', '{"enabledMcpjsonServers":[', ']}'),
  ],
  [
    'env variables nobody knows',
    '.claude/settings.json',
    many((i) => `"V${i}":"x"`, ',', '{"env":{', '}}'),
  ],
  [
    'plugin sources',
    '.claude/settings.json',
    many((i) => `"m${i}":{"source":"x"}`, ',', '{"extraKnownMarketplaces":{', '}}'),
  ],
];

describe('a file with many entries is read in linear time', () => {
  it.each(MANY)('%s', (_name, path, build) => {
    expectLinear(
      SIZES.map((size) => build(size)),
      (text) => scanFile(path, text),
    );
  });
});
