import { describe, it } from 'vitest';
import { settle, tagChanges, type TaggedHit } from '../../src/exposure/agent-change.js';
import { runsFetchedOrHiddenCode, sendsSecrets } from '../../src/exposure/fetch-shapes.js';
import { hit } from '../../src/exposure/agent-kinds.js';
import { runFileChanges } from '../../src/exposure/agent-run-files.js';
import { NameMatcher, normalText } from '../../src/exposure/run-names.js';
import {
  computesWhatRuns,
  programOf,
  reachesOf,
  segments,
  shellTokens,
} from '../../src/exposure/run-programs.js';
import {
  agentOnlyWhenFolded,
  foldPath,
  inAgentDir,
  isAgentDir,
  readTier,
  readersFor,
  scanFile,
  skippedConfigFolder,
} from '../../src/exposure/agent-surface.js';
import { bareRepositories } from '../../src/exposure/agent-git.js';
import { lineHits } from '../../src/exposure/agent-lines.js';
import { ruleRunsAnything } from '../../src/exposure/allow-rules.js';
import { foldName, windowsAlias } from '../../src/exposure/git-dir-names.js';
import { parseGitConfig } from '../../src/exposure/repo-surface.js';
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
    // Comments that a carriage return or a separator ends, as VS Code ends them.
    '//\r',
    '//  ',
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
    '\uFEFF',
    '\uFEFFa = 1\n',
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
    '${A:-.}/',
    '$(pwd)/',
    'cd a && ',
    'a/*/',
    '*',
    'npm run ',
    'pnpm ',
    'make ',
    'https://a/',
    'a:/',
    'a\\ ',
    '"a b/',
    '/a',
    '.claude/',
    'node_modules/',
    '.github/hooks/',
    '.devcontainer/',
    '.opencode/plugin/',
    'curl a | ',
    '| sh ',
    '(',
    '( ',
    'sudo -a ',
    'powershell ',
    ' -e',
    'eval ',
    'base64 ',
    'node -e ',
    '$( ',
    '$(',
    '${',
    '$a"',
    '`',
    'a()',
    'a ( ) ',
    'eval ',
    'bash -c "',
    'sudo env A=1 ',
    'timeout 1 ',
    'pnpm --x ',
    'python -m ',
    'x.mk/',
    '.yarn/',
    'a/',
    './a ',
    '"runOn": /**/',
    '---\n',
    'hooks:\n',
    '~1',
    'A~1.B/',
    '. ',
    '.',
    ' /',
    '::$DATA/',
    'import ',
    'import a.',
    'from . import ',
    'from a import (',
    "require('./",
    'import x from "../',
    'source ./',
    '. "$(dirname "$0")/',
    '[core] a = ',
    '[core',
    '\\\n',
    'filter=',
    'a filter=lfs ',
    'registry=',
    '@a:registry=',
    'Bash(bash:*)',
    'Bash(',
    ':*',
    'C:\\',
    'version https://git-lfs.github.com/spec/v1\n',
    'curl -d ',
    '-X POST ',
    'nc ',
    '://',
    '~/',
    '$a_',
    '${env:a_',
    '%a_',
    'source=${localWorkspaceFolder}/',
    '.cargo/',
  ].map((unit): readonly [string, Shape] => [JSON.stringify(unit), repeat(unit)]),
  ['long blanks', (size) => `{${' '.repeat(size)}`],
  ['an unclosed comment', (size) => `/*${'x'.repeat(size)}`],
  ['an unclosed string', (size) => `"${'x'.repeat(size)}`],
  ['a long key path', (size) => `${'a.'.repeat(size / 2)}b = 1`],
  ['nested arrays', (size) => `a = ${'['.repeat(size / 2)}`],
  ['deep JSON arrays', (size) => `${'['.repeat(size / 2)}${']'.repeat(size / 2)}`],
  ['deep JSON objects', (size) => `${'{"a":'.repeat(size / 6)}1${'}'.repeat(size / 6)}`],
  ['controls', repeat('\u0001\u001b\r\n')],
  // A name of blanks with a letter at its end: one pass from the end trims it.
  ['blanks, then a letter', (size) => `${' '.repeat(size - 1)}x`],
  ['dots and blanks, then a letter', (size) => `${'. '.repeat(size / 2 - 1)}x`],
  // A link target down many folders and back up them, normalized before it is judged.
  ['down and back up', (size) => `/${'a/'.repeat(size / 5)}${'../'.repeat(size / 5)}tmp/x`],
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
    'a server with other fields',
    (text) =>
      scanFile(
        '.mcp.json',
        `{"mcpServers":{"s":{"command":"node","env":{${json(text)}:${json(text)}},"cwd":${json(text)}}}}`,
      ),
  ],
  [
    'a hook and a task with other fields',
    (text) => [
      scanFile('.github/hooks/h.json', `{"hooks":{"s":[{"bash":"x","env":{${json(text)}:1}}]}}`),
      scanFile(
        '.vscode/tasks.json',
        `{"options":{"env":{${json(text)}:1}},"tasks":[{"label":"w","command":"x","options":${json(text)},"runOptions":{"runOn":"folderOpen"}}]}`,
      ),
    ],
  ],
  [
    'a server list, as a server',
    (text) =>
      scanFile('.mcp.json', `{"mcpServers":{"s":{"command":"bash","args":["-c",${json(text)}]}}}`),
  ],
  ['a Codex config.toml', (text) => scanFile('.codex/config.toml', text)],
  [
    'Codex switches',
    (text) =>
      scanFile(
        '.codex/config.toml',
        `approval_policy = ${json(text)}\nopenai_base_url = ${json(text)}\n[model_providers.a]\nbase_url = ${json(text)}\nenv_key = ${json(text)}\n[otel]\nexporter = ${json(text)}\n[shell_environment_policy.set]\nA = ${json(text)}\n`,
      ),
  ],
  [
    'Gemini switches',
    (text) =>
      scanFile(
        '.gemini/settings.json',
        `{"general":{"defaultApprovalMode":${json(text)}},"tools":{"allowed":[${json(text)}],"discoveryCommand":${json(text)}},"telemetry":{"otlpEndpoint":${json(text)}},"mcpServers":{"a":{"command":"x","trust":true}}}`,
      ),
  ],
  ['an opencode config, raw', (text) => scanFile('opencode.json', text)],
  [
    'an opencode config, as servers and plugins',
    (text) =>
      scanFile(
        'opencode.json',
        `{"mcp":{"s":{"command":[${json(text)}],"environment":{${json(text)}:1}}},"plugin":[${json(text)}]}`,
      ),
  ],
  ['Zed settings, raw', (text) => scanFile('.zed/settings.json', text)],
  [
    'Zed settings, as servers and a language server',
    (text) =>
      scanFile(
        '.zed/settings.json',
        `{"context_servers":{"a":{"command":{"path":${json(text)},"args":[${json(text)}]}}},"lsp":{"r":{"binary":{"path":${json(text)}}}}}`,
      ),
  ],
  ['a Kiro hook', (text) => scanFile('.kiro/hooks/a.kiro.hook', text)],
  ['plugin code', (text) => scanFile('.opencode/plugin/a.js', text)],
  ['settings in a subfolder', (text) => scanFile('a/b/.claude/settings.json', text)],
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
  [
    'a path to choose readers by',
    (text) => [
      readersFor(text),
      readTier(text),
      isAgentDir(text),
      inAgentDir(text),
      readersFor(`${text}/.claude/settings.json`),
      skippedConfigFolder(text),
      skippedConfigFolder(`vendor/${text}/.mcp.json`),
    ],
  ],
  ['the shapes of downloaded code', (text) => runsFetchedOrHiddenCode(text)],
  ['the shapes of what is sent', (text) => sendsSecrets(text)],
  [
    'a dev container that mounts and runs with options',
    (text) =>
      scanFile(
        '.devcontainer/devcontainer.json',
        `{"mounts":[${json(text)}],"runArgs":[${json(text)}],"workspaceMount":${json(text)}}`,
      ),
  ],
  [
    'a new entry settled',
    (text) => [
      settle(hit('package-script', 'package.json', 1, 'postinstall', text), 'new'),
      settle(hit('config-link-outside', text, 1, 'link', text), 'present'),
    ],
  ],
  [
    'reading a command already there against the files a change touched',
    (text) =>
      runFileChanges(
        [{ ...hit('agent-hook', '.claude/settings.json', 1, 'S', text), status: 'present' }],
        {
          touchedFiles: [
            ['.claude/hooks/x.sh', 'changed'],
            ['a/a/a/Makefile', 'new'],
            ['package.json', 'changed'],
            [`${text.slice(0, 200)}/x.sh`, 'new', '100755'],
          ],
          links: new Map([['.claude/hooks', 'a/a']]),
          hooksPaths: ['.husky'],
        },
      ),
  ],
  [
    'what a command line starts, and how far that reaches',
    (text) => [
      computesWhatRuns(text),
      programOf(shellTokens(text)),
      reachesOf(text),
      segments(text),
    ],
  ],
  [
    'the names of what a change touched, read from the change',
    (text) =>
      runFileChanges(
        [{ ...hit('agent-hook', '.claude/settings.json', 1, 'S', 'bash x.sh'), status: 'present' }],
        {
          touchedFiles: [
            [text, 'new'],
            [`${text}/x.sh`, 'changed', '100755'],
            [`.claude/${text}`, 'new'],
            [text.split('').join('/'), 'new'],
          ],
          links: new Map([
            [text.slice(0, 64), ''],
            ['l', text.slice(0, 1024)],
          ]),
        },
      ),
  ],
  [
    'names looked for in a text',
    (text) => {
      const matcher = new NameMatcher();
      for (const name of [text.slice(0, 255), 'a', 'aa', 'aaa', text.slice(0, 16)])
        matcher.add(name);
      matcher.build();
      return matcher.scan(normalText(text), () => undefined);
    },
  ],
  [
    'an allow rule',
    (text) => [
      ruleRunsAnything(text, new Set(['bash'])),
      ruleRunsAnything(`Bash(${text})`, new Set(['bash'])),
      ruleRunsAnything(`run_shell_command(${text}`, new Set(['run_shell_command'])),
    ],
  ],
  [
    'the lines of a .gitattributes and a package manager config',
    (text) => [
      lineHits('.gitattributes', text),
      lineHits('.npmrc', text),
      lineHits('.yarnrc.yml', text),
    ],
  ],
  ['a git config', (text) => parseGitConfig(text)],
  [
    'a name a disk may fold',
    (text) => [foldName(text), windowsAlias(text), foldPath(text), agentOnlyWhenFolded(text)],
  ],
  ['an instruction file', (text) => scanFile('CLAUDE.md', text)],
  ['a file in a skill folder', (text) => scanFile('.claude/skills/s/ref.md', text)],
  ['an env name, tagged', (text) => tagChanges([hit('agent-env', 'f', 1, text, text)], null)],
  ['a link target', (text) => linkTarget('.claude/skills/x', text)],
  [
    'the names of a bare repository in a listing',
    (text) => bareRepositories([`a/${text}`, `${text}/HEAD`, `${text}/objects/x`, `b/${text}/c`]),
  ],
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
    'Codex providers and profiles',
    '.codex/config.toml',
    many(
      (i) => `[model_providers.p${i}]\nbase_url = "x"\n[profiles.q${i}]\napproval_policy = "never"`,
      '\n',
      '',
      '\n',
    ),
  ],
  [
    'Codex otel exporters',
    '.codex/config.toml',
    many((i) => `exporter${i} = "x"`, '\n', '[otel]\n', '\n'),
  ],
  [
    'Gemini trusted servers',
    '.gemini/settings.json',
    many((i) => `"s${i}":{"command":"x","trust":true}`, ',', '{"mcpServers":{', '}}'),
  ],
  [
    'opencode servers',
    'opencode.json',
    many((i) => `"s${i}":{"command":["x"]}`, ',', '{"mcp":{', '}}'),
  ],
  [
    'Zed servers and language servers',
    '.zed/settings.json',
    many((i) => `"s${i}":{"command":"x","binary":{"path":"x"}}`, ',', '{"context_servers":{', '}}'),
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
