import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool } from '../../src/actions/classify-tool.js';

/**
 * `classify-redos-gate.test.ts` holds the shell classifier to linear time on commands
 * built to be slow. The same is asked here of what a file tool and an MCP call WRITE: the
 * text is the agent's, hook stdin has no length cap, a hook that outlives its timeout is
 * answered as an allow on some hosts, and a security review found three quadratic
 * searches in these paths that no command-shaped input reached. Held as growth, not
 * milliseconds, for the reason that file gives: each input is timed at a quarter of its
 * size and at its full size, and only one that is slow AND growing faster than linear
 * fails.
 */
const SIZE = 256 * 1024;
const BOUND_MS = 1_000;
const MAX_GROWTH = 8;
const cwd = '/tmp';

type Build = (size: number) => string;
const repeated =
  (unit: string): Build =>
  (size) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const timed = (run: () => unknown): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

const holds = (name: string, run: (size: number) => unknown): void => {
  it(name, () => {
    const quarter = timed(() => run(SIZE / 4));
    const full = timed(() => run(SIZE));
    const growth = `${quarter.toFixed(0)} ms at ${SIZE / 4096} KiB, ${full.toFixed(0)} ms at ${SIZE / 1024} KiB`;
    expect(full < BOUND_MS || full < MAX_GROWTH * quarter, growth).toBe(true);
  });
};

const TEXTS: ReadonlyArray<readonly [string, Build]> = [
  ['newlines', repeated('\n')],
  ['newlines then a key', (size) => `${'\n'.repeat(size)}hooks:`],
  ['spaces', repeated(' ')],
  ['tabs and newlines', repeated('\t\n')],
  ['section headers', repeated('[a]\n')],
  ['unclosed section headers', repeated('[a ')],
  ['dotted section names', repeated('[a "b.c.d."]\n')],
  ['assignments', repeated('key = value\n')],
  ['quotes', repeated('"')],
  ['comment openers', repeated('/*')],
  ['comment openers after a key', (size) => `"runOn": ${'/*'.repeat(size / 2)}`],
  ['line comments after a key', (size) => `"runOn": ${'//\n'.repeat(size / 3)}`],
  ['frontmatter fences', repeated('---\n')],
  ['an unclosed frontmatter', (size) => `---\n${'a: b\n'.repeat(size / 5)}`],
  ['braces', repeated('{[')],
  ['directives', repeated('Match ')],
  ['proxy words', repeated('ProxyCommand ')],
];

const TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['an MCP server list', `${cwd}/.mcp.json`],
  ['an agent definition', `${cwd}/.github/agents/x.agent.md`],
  ['a skill', `${cwd}/.claude/skills/x/SKILL.md`],
  ['an editor task file', `${cwd}/.vscode/tasks.json`],
  ['a workspace file', `${cwd}/a.code-workspace`],
  ['an ssh client configuration', '/home/dev/.ssh/config'],
  ['a file named like nothing', `${cwd}/.alt/config`],
];

describe('the text a Write carries stays linear', () => {
  for (const [targetName, path] of TARGETS) {
    for (const [textName, build] of TEXTS) {
      holds(`${textName} written to ${targetName}`, (size) =>
        classifyTool('Write', { file_path: path, content: build(size) }, cwd),
      );
    }
  }
});

describe('the text an MCP call carries stays linear', () => {
  holds('a long list of strings beside a path', (size) =>
    classifyTool(
      'mcp__fs__write_file',
      { path: `${cwd}/.mcp.json`, lines: Array.from({ length: size / 8 }, (_, i) => `line ${i}`) },
      cwd,
    ),
  );
  holds('many paths and many strings', (size) =>
    classifyTool(
      'mcp__fs__write_file',
      {
        files: Array.from({ length: Math.min(size / 64, 3_000) }, (_, i) => `/tmp/f${i}`),
        notes: Array.from({ length: size / 16 }, () => 'a note'),
      },
      cwd,
    ),
  );
  holds('deeply nested junk after the server', (size) =>
    classifyTool(
      'mcp__fs__write_file',
      {
        path: `${cwd}/.mcp.json`,
        content: JSON.stringify({ junk: Array.from({ length: size / 4 }, (_, i) => i) }),
      },
      cwd,
    ),
  );
});

const COMMANDS: ReadonlyArray<readonly [string, Build]> = [
  ['python open(', (size) => `python3 -c "${'open('.repeat(size / 5)}`],
  [
    'python open( then a startup file',
    (size) => `python3 -c "${'open('.repeat(size / 5)} ~/.zshrc"`,
  ],
  ['interpreter calls', repeated('python3 -c x; ')],
  ['interpreter options', repeated('node --a ')],
  ['startup file names in prose', repeated('.zshrc and ')],
  ['dotfile slashes', repeated('.config/////')],
  ['cd chains', repeated('cd a && ')],
  ['pushd chains', repeated('pushd a; ')],
  ['braces', repeated('{a,b}')],
  ['tee with braces', (size) => `tee ${'~/.{a,b}'.repeat(size / 9)}`],
  ['dd of', repeated('dd of=x ')],
  ['git clone', repeated('git clone a ')],
  ['tar -C', repeated('tar -C a ')],
  [
    'quoted heredoc text',
    (size) => `cat > .mcp.json <<'EOF'\n${'"command": "sh",\n'.repeat(size / 17)}EOF`,
  ],
  ['many quoted strings', repeated("echo 'abcd' > f; ")],
  ['ssh with quoted options', repeated('ssh -o "a b" ')],
  ['ssh clusters', repeated('ssh -tpA ')],
  ['sshpass', repeated('sshpass -p x ssh a "b" ')],
  ['kubectl', repeated('kubectl -n a ')],
  ['aws global options', repeated('aws --profile a ')],
  ['gcloud words', repeated('gcloud a ')],
  ['helm words', repeated('helm a ')],
  ['firebase words', repeated('firebase a ')],
  ['rsync --del', repeated('rsync --del ')],
  ['traps', repeated("trap 'echo' EXIT; ")],
  ['double-quoted traps', repeated('trap "a" ')],
  ['trap with escapes', (size) => `trap "${'\\"'.repeat(size / 2)}`],
  ['trap --', repeated('trap -- ')],
];

describe('the commands of the 2026-Q3 detectors stay linear', () => {
  for (const [name, build] of COMMANDS) {
    holds(name, (size) => classifyTool('Bash', { command: build(size) }, cwd));
  }
  holds('a command alone (no file tool)', (size) =>
    classifyCommand(`ssh a "${'x | '.repeat(size / 4)}`, cwd),
  );
});
