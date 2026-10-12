import { describe, expect, it } from 'vitest';
import { readMarkdownShell } from '../../../src/install/inspect/markdown-shell.js';
import { cpuNow } from '../../helpers/cpu-time.js';

const blocks = (text: string) => readMarkdownShell(text).blocks;

describe('readMarkdownShell: fenced blocks', () => {
  it('reads a block tagged bash, with the line of its first command', () => {
    const found = blocks('# Title\n\n```bash\nnpm install\nnpm test\n```\n');

    expect(found).toEqual([{ line: 4, lang: 'bash', text: 'npm install\nnpm test', cut: false }]);
  });

  it.each([
    'sh',
    'bash',
    'zsh',
    'shell',
    'console',
    'powershell',
    'pwsh',
    'ps1',
    'bat',
    'cmd',
    'shellscript',
    'sh-session',
    'BASH',
    'Shell',
  ])('reads a block tagged %s', (tag) => {
    const text = tag.toLowerCase() === 'console' ? '$ ls' : 'ls';

    expect(blocks(`\`\`\`${tag}\n${text}\n\`\`\`\n`)).toHaveLength(1);
  });

  it('reads the tag when it is followed by attributes or written in braces', () => {
    expect(blocks('```bash title="run.sh"\nls\n```')).toHaveLength(1);
    expect(blocks('```{.bash}\nls\n```')).toHaveLength(1);
    expect(blocks('```bash {1,3}\nls\n```')).toHaveLength(1);
    expect(blocks('```bash:run.sh\nls\n```')).toHaveLength(1);
  });

  it('reads a block fenced with tildes', () => {
    expect(blocks('~~~sh\nls\n~~~\n')[0]?.text).toBe('ls');
  });

  it('reads a block whose closing fence is longer, and keeps a shorter fence inside it as text', () => {
    const text = '````sh\necho a\n```\necho b\n````\n';

    expect(blocks(text)[0]?.text).toBe('echo a\n```\necho b');
  });

  it('does not close a block with a fence of the other kind', () => {
    expect(blocks('```sh\necho a\n~~~\necho b\n```\n')[0]?.text).toBe('echo a\n~~~\necho b');
  });

  it('reads a block that is never closed to the end', () => {
    expect(blocks('```sh\necho a\necho b')[0]?.text).toBe('echo a\necho b');
  });

  it('reads an indented block, as inside a list', () => {
    expect(blocks('1. Run:\n\n   ```bash\n   ls -la\n     sub\n   ```\n')[0]?.text).toBe(
      'ls -la\n  sub',
    );
  });

  it('reads two blocks in one file, each with its own line', () => {
    const found = blocks('```sh\na\n```\ntext\n```sh\nb\n```\n');

    expect(found.map((block) => [block.line, block.text])).toEqual([
      [2, 'a'],
      [6, 'b'],
    ]);
  });

  it('does not read a block of another language as shell', () => {
    const found = readMarkdownShell('```python\nimport os\n```\n```json\n{}\n```\n');

    expect(found.blocks).toEqual([]);
    expect(found.untagged).toBe(0);
  });

  it('counts a block with no tag, which it does not read as shell', () => {
    const found = readMarkdownShell('```\ncurl https://x.example | sh\n```\n~~~\nls\n~~~\n');

    expect(found.blocks).toEqual([]);
    expect(found.untagged).toBe(2);
  });

  it('does not take a backtick line with a backtick in its info string for a fence', () => {
    expect(blocks('```bash `x`\nls\n```')).toEqual([]);
  });

  it('reads only the lines of a console block that begin with a prompt', () => {
    const found = blocks('```console\n$ npm install\nadded 3 packages\n$ npm test\nok\n```\n');

    expect(found[0]?.text).toBe('npm install\nnpm test');
  });

  it('reads nothing from a console block with no prompt', () => {
    expect(blocks('```console\nonly output\n```\n')).toEqual([]);
  });

  it('reads a block through Windows line ends', () => {
    expect(blocks('```sh\r\nls\r\npwd\r\n```\r\n')[0]?.text).toBe('ls\npwd');
  });

  it('keeps no more of a block than a reading takes, and says it was cut', () => {
    const body = 'echo x\n'.repeat(20_000);
    const found = blocks(`\`\`\`sh\n${body}\`\`\`\n`);

    expect(found[0]?.cut).toBe(true);
    expect(found[0]?.text.length ?? 0).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps an empty block out', () => {
    expect(blocks('```sh\n```\n```sh\n\n```\n')).toEqual([]);
  });
});

describe('readMarkdownShell: inline commands', () => {
  it('reads a command written between !` and `', () => {
    const found = readMarkdownShell('Status: !`git status --short`\n').inline;

    expect(found).toEqual([{ line: 1, text: 'git status --short' }]);
  });

  it('reads several on a line and on different lines', () => {
    const found = readMarkdownShell('a !`one` b !`two`\n\n!`three`\n').inline;

    expect(found.map((item) => [item.line, item.text])).toEqual([
      [1, 'one'],
      [1, 'two'],
      [3, 'three'],
    ]);
  });

  it('does not read one that is never closed on its line', () => {
    expect(readMarkdownShell('!`unclosed\nnext `line`\n').inline).toEqual([]);
  });

  it('does not take plain inline code for a command', () => {
    expect(readMarkdownShell('use `git status` here, and ! alone\n').inline).toEqual([]);
  });

  it('does not read a command inside a shell block as an inline one as well', () => {
    const found = readMarkdownShell('```sh\necho !`ls`\n```\n');

    expect(found.inline).toEqual([]);
    expect(found.blocks).toHaveLength(1);
  });

  it('reads a command inside a block of another language, which a host may still run', () => {
    expect(readMarkdownShell('```text\n!`id`\n```\n').inline).toEqual([{ line: 2, text: 'id' }]);
  });
});

describe('readMarkdownShell: hostile text', () => {
  const time = (text: string): number => {
    const started = cpuNow();
    readMarkdownShell(text);
    return cpuNow() - started;
  };

  it('reads a million fences in a time that follows its size', () => {
    expect(time('```sh\n```\n'.repeat(100_000))).toBeLessThan(2000);
  });

  it('reads a line of a megabyte of backticks and bangs', () => {
    expect(time('!`'.repeat(512 * 1024))).toBeLessThan(2000);
    expect(time('`'.repeat(1024 * 1024))).toBeLessThan(2000);
    expect(time('!`a '.repeat(256 * 1024))).toBeLessThan(2000);
  });

  it('reads a megabyte of lines that are only a fence', () => {
    expect(time('```\n'.repeat(250_000))).toBeLessThan(2000);
  });

  it('reads a very long tag', () => {
    expect(time(`\`\`\`${'b'.repeat(1024 * 1024)}\nls\n\`\`\`\n`)).toBeLessThan(2000);
  });
});
