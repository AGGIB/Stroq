import { describe, it } from 'vitest';
import type { TaggedHit } from '../../src/exposure/agent-change.js';
import { hit } from '../../src/exposure/agent-kinds.js';
import { scanFile } from '../../src/exposure/agent-surface.js';
import { annotations, githubSummary } from '../../src/exposure/github-format.js';
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
    "'",
    'command = "',
    'a = [',
    '{ a = ',
    'hooks.',
    'mcp_servers.',
    '\\u00',
    '‍',
    '\u{1F468}‍',
    '\u{E0041}',
    '.vscode/',
    '.vscode//',
    '.claude/settings.json',
    'CLAUDE.md ',
    'ANTHROPIC_',
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
  ['an instruction file', (text) => scanFile('CLAUDE.md', text)],
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
