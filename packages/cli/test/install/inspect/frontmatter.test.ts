import { describe, expect, it } from 'vitest';
import { FRONTMATTER_CAP_BYTES } from '../../../src/install/inspect/blind-spots.js';
import { cpuNow } from '../../helpers/cpu-time.js';
import { lineOf, linesOf, passportOf, skillWith, subjectsOf } from '../../helpers/inspect.js';

const toolsOf = (frontMatter: string, name = 'SKILL.md') =>
  linesOf(passportOf({ [name]: skillWith(frontMatter) }), 'allowed-tools');

describe('front matter: allowed-tools', () => {
  it('makes a line for each tool of a comma-separated list, declared, at the line of the key', () => {
    const lines = toolsOf('name: demo\nallowed-tools: Read, Grep, Bash(git status:*)');

    expect(lines.map((line) => line.subject)).toEqual(['Bash(git status:*)', 'Grep', 'Read']);
    expect(lines.every((line) => line.basis === 'declared')).toBe(true);
    expect(lines[0]?.where).toEqual([{ file: 'SKILL.md', line: 3 }]);
  });

  it('reads a list written as a YAML list', () => {
    const lines = toolsOf('allowed-tools:\n  - Read\n  - Edit(src/**)');

    expect(lines.map((line) => line.subject)).toEqual(['Edit(src/**)', 'Read']);
  });

  it('reads a list separated by blanks', () => {
    const lines = toolsOf('allowed-tools: Read Grep Bash');

    expect(lines.map((line) => line.subject)).toEqual(['Bash', 'Grep', 'Read']);
  });

  it('keeps a tool with blanks, commas and quotes inside its pattern as one tool', () => {
    const lines = toolsOf('allowed-tools: Read, Bash(git commit -m "a, b":*), Grep');

    expect(lines.map((line) => line.subject)).toEqual([
      'Bash(git commit -m "a, b":*)',
      'Grep',
      'Read',
    ]);
  });

  it('does not fail on a pattern that is never closed', () => {
    const lines = toolsOf('allowed-tools: Read, Bash(git add:*, Grep');

    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it.each<[string, boolean]>([
    ['Bash', true],
    ['Bash(*)', true],
    ['Bash(:*)', true],
    ['Bash(git status:*)', false],
    ['Bash(npm test)', false],
    ['Bash(sudo:*)', true],
    ['Bash(curl:*)', true],
    ['Bash(bash:*)', true],
    ['WebFetch', true],
    ['WebFetch(domain:example.com)', true],
    ['WebSearch', true],
    ['mcp__github__create_issue', true],
    ['mcp__*', true],
    ['*', true],
    ['Write', true],
    ['Edit', true],
    ['Write(/etc/**)', true],
    ['Write(~/.ssh/*)', true],
    ['Write(../outside/**)', true],
    ['Write(.claude/**)', true],
    ['Write(src/**)', false],
    ['Edit(docs/*.md)', false],
    ['Read', false],
    ['Read(src/**)', false],
    ['Read(~/.aws/credentials)', true],
    ['Read(/etc/passwd)', true],
    ['Grep', false],
    ['Glob', false],
    ['Task', false],
    ['TodoWrite', false],
  ])('judges %s sensitive: %s', (tool, sensitive) => {
    const lines = toolsOf(`allowed-tools: ${JSON.stringify(tool)}`);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.sensitive).toBe(sensitive);
  });

  it('cuts a very long list and says it did', () => {
    const tools = Array.from({ length: 300 }, (_, i) => `Tool${i}`).join(', ');
    const passport = passportOf({ 'SKILL.md': skillWith(`allowed-tools: ${tools}`) });

    expect(linesOf(passport, 'allowed-tools')).toHaveLength(100);
    expect(passport.blindSpots.some((spot) => spot.includes('was cut at the number'))).toBe(true);
  });

  it('says nothing when there is no allowed-tools', () => {
    expect(toolsOf('name: demo\ndescription: x')).toEqual([]);
  });

  it('does not take an allowed-tools nested under another key for the skill’s own', () => {
    expect(toolsOf('metadata:\n  allowed-tools: Bash')).toEqual([]);
  });

  it('writes out a character in a tool name that a passport cannot hold', () => {
    const lines = toolsOf('allowed-tools: "Evil\\u202eTool"');

    expect(lines[0]?.subject).toContain('\\u202e');
  });

  it('tells a value that is neither text nor a list', () => {
    const passport = passportOf({ 'SKILL.md': skillWith('allowed-tools: {a: 1}') });

    expect(linesOf(passport, 'allowed-tools')).toEqual([]);
    expect(subjectsOf(passport, 'signal').join(' ')).toContain('frontmatter-unreadable');
  });
});

describe('front matter: hooks', () => {
  const HOOKS = `hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/check.sh"
  Stop:
    - hooks:
        - type: command
          command: "echo done"`;

  it('makes a sensitive hook line for each command, with the event it runs on', () => {
    const passport = passportOf({ 'SKILL.md': skillWith(HOOKS) });

    expect(subjectsOf(passport, 'hook')).toEqual([
      'PreToolUse: ./scripts/check.sh',
      'Stop: echo done',
    ]);
    for (const line of linesOf(passport, 'hook')) {
      expect(line.sensitive).toBe(true);
      expect(line.basis).toBe('declared');
      expect(line.where).toEqual([{ file: 'SKILL.md', line: 2 }]);
    }
  });

  it('makes a line for a hook that is not a command, and for hooks it cannot read the shape of', () => {
    const passport = passportOf({
      'SKILL.md': skillWith(
        'hooks:\n  PostToolUse:\n    - hooks:\n        - type: prompt\n          prompt: "check it"',
      ),
      'skills/b/SKILL.md': skillWith('hooks: yes'),
    });

    expect(subjectsOf(passport, 'hook')).toEqual([
      'PostToolUse: prompt hook',
      'hooks declared (shape not understood)',
    ]);
    expect(lineOf(passport, 'hook', 'hooks declared (shape not understood)')?.basis).toBe(
      'unknown',
    );
  });

  it('makes no line for hooks that are an empty list', () => {
    expect(subjectsOf(passportOf({ 'SKILL.md': skillWith('hooks: {}') }), 'hook')).toEqual([]);
  });

  it('does not walk into hooks nested a hundred deep, and does not fail', () => {
    const nested = Array.from({ length: 100 }, (_, i) => `${' '.repeat(2 * (i + 1))}k${i}:`).join(
      '\n',
    );

    const passport = passportOf({ 'SKILL.md': skillWith(`hooks:\n${nested}`) });

    expect(subjectsOf(passport, 'hook')).toEqual(['hooks declared (shape not understood)']);
  });
});

describe('front matter: broken, long and in other places', () => {
  const unreadable = (files: Record<string, string>) =>
    passportOf(files).lines.filter(
      (line) => line.kind === 'signal' && line.subject.startsWith('frontmatter-unreadable'),
    );

  it.each([
    ['not valid YAML', 'name: [1, 2'],
    ['not a mapping', '- a\n- b'],
    ['a scalar', 'just text'],
    ['a repeated key', 'name: a\nname: b'],
    ['an alias', 'a: &x [1]\nb: *x'],
    ['a tab for indentation', 'a:\n\tb: 1'],
  ])('tells %s as a sign to look, not as an error', (_what, block) => {
    const lines = unreadable({ 'SKILL.md': skillWith(block) });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.sensitive).toBe(true);
    expect(lines[0]?.detector).toContain('could not be read');
  });

  it('reads nothing from a front matter that is broken', () => {
    const passport = passportOf({ 'SKILL.md': skillWith('allowed-tools: Bash\nname: [oops') });

    expect(linesOf(passport, 'allowed-tools')).toEqual([]);
    expect(passport.signals.map((signal) => signal.ruleId)).toContain('frontmatter-unreadable');
  });

  /** A front matter whose text, through the closing line without its newline, is `size` bytes. */
  const regionOf = (size: number): string => {
    const filler = size - '---\ndescription: '.length - '\n---'.length;
    return `---\ndescription: ${'a'.repeat(filler)}\n---`;
  };

  it('accepts a front matter that is exactly the cap, and refuses one byte more', () => {
    expect(Buffer.byteLength(regionOf(FRONTMATTER_CAP_BYTES))).toBe(FRONTMATTER_CAP_BYTES);

    expect(unreadable({ 'SKILL.md': `${regionOf(FRONTMATTER_CAP_BYTES)}\n# body\n` })).toHaveLength(
      0,
    );
    const tooLong = passportOf({ 'SKILL.md': `${regionOf(FRONTMATTER_CAP_BYTES + 1)}\n# body\n` });
    expect(tooLong.signals.map((signal) => signal.ruleId)).toContain('frontmatter-unreadable');
    expect(
      tooLong.blindSpots.some((spot) => spot.includes('front matter block was not read')),
    ).toBe(true);
  });

  it('counts the cap in bytes, so that text of wide characters is not let through', () => {
    const wide = `---\ndescription: ${'\u00e9'.repeat(FRONTMATTER_CAP_BYTES / 2)}\n---\n# body\n`;

    const passport = passportOf({ 'SKILL.md': wide });

    expect(passport.signals.map((signal) => signal.ruleId)).toContain('frontmatter-unreadable');
  });

  it('tells a front matter that is never closed', () => {
    const passport = passportOf({ 'SKILL.md': '---\nname: x\nallowed-tools: Bash\n# no end\n' });

    expect(passport.signals.map((signal) => signal.ruleId)).toContain('frontmatter-unreadable');
    expect(linesOf(passport, 'allowed-tools')).toEqual([]);
  });

  it('ignores a file that does not begin with a front matter', () => {
    expect(unreadable({ 'SKILL.md': '# Title\n\n---\nallowed-tools: Bash\n---\n' })).toHaveLength(
      0,
    );
    expect(toolsOf('')).toEqual([]);
  });

  it('finds the front matter after a byte order mark and with Windows line ends', () => {
    const text = '\ufeff---\r\nallowed-tools: Bash\r\n---\r\n# body\r\n';
    const lines = linesOf(passportOf({ 'SKILL.md': text }), 'allowed-tools');

    expect(lines.map((line) => line.subject)).toEqual(['Bash']);
    expect(lines[0]?.where).toEqual([{ file: 'SKILL.md', line: 2 }]);
  });

  it('reads the front matter of a skill in a folder and of a command, and not of other documents', () => {
    const passport = passportOf({
      'SKILL.md': skillWith('name: root'),
      'skills/inner/SKILL.md': skillWith('allowed-tools: WebFetch'),
      'commands/run.md': skillWith('allowed-tools: Bash'),
      'docs/page.md': skillWith('allowed-tools: Write'),
    });

    const files = linesOf(passport, 'allowed-tools').flatMap((line) =>
      line.where.map((place) => place.file),
    );
    expect(files.sort()).toEqual(['commands/run.md', 'skills/inner/SKILL.md']);
  });

  it('takes the name and version of the skill from the front matter of the root SKILL.md', () => {
    const passport = passportOf({
      'SKILL.md': skillWith('name: pdf-tools\nversion: 1.4.0\ndescription: Work with PDFs'),
    });

    expect(passport.artifact.name).toBe('pdf-tools');
    expect(passport.artifact.version).toBe('1.4.0');
  });

  it('takes the version from metadata when the skill puts it there', () => {
    const passport = passportOf({
      'SKILL.md': skillWith('name: pdf-tools\nmetadata:\n  version: "2.0"'),
    });

    expect(passport.artifact.version).toBe('2.0');
  });

  it('falls back to the source when the front matter has no name, or a name that is not text', () => {
    expect(passportOf({ 'SKILL.md': skillWith('name: 12') }).artifact.name).toBe('fixture');
    expect(passportOf({ 'SKILL.md': skillWith('name: [a]') }).artifact.name).toBe('fixture');
    expect(passportOf({ 'SKILL.md': '# no front matter\n' }).artifact.name).toBe('fixture');
  });
});

describe('front matter: hostile input', () => {
  const bounded = (frontMatter: string) => {
    const started = cpuNow();
    const passport = passportOf({ 'SKILL.md': skillWith(frontMatter) });
    return { passport, took: cpuNow() - started };
  };

  it('reads a front matter of the most nested flow sequences it can hold in no time', () => {
    const { passport, took } = bounded(`a: ${'['.repeat(8000)}${']'.repeat(8000)}`);

    expect(passport.artifact.kind).toBe('skill');
    expect(took).toBeLessThan(1500);
  });

  it('reads a front matter of as many keys as the cap holds in no time', () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `k${i}: ${i}`).join('\n');
    const { took } = bounded(keys.slice(0, FRONTMATTER_CAP_BYTES - 40));

    expect(took).toBeLessThan(1500);
  });

  it('reads a front matter of deeply nested blocks in no time', () => {
    const block = Array.from({ length: 800 }, (_, i) => `${' '.repeat(i)}a:`).join('\n');
    const { took } = bounded(block.slice(0, FRONTMATTER_CAP_BYTES - 40));

    expect(took).toBeLessThan(1500);
  });

  it('reads a front matter of a million aliases as a broken one, without expanding them', () => {
    const { passport, took } = bounded(
      'a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b]',
    );

    expect(passport.signals.map((signal) => signal.ruleId)).toContain('frontmatter-unreadable');
    expect(took).toBeLessThan(1500);
  });
});
