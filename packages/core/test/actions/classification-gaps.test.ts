import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool, normalizePathForMatch } from '../../src/actions/classify-tool.js';

const cwd = '/home/dev/project';
const cmd = (c: string) => classifyCommand(c, cwd).classes;
const write = (p: string) => classifyTool('Write', { file_path: p }, cwd).classes;
const read = (p: string) => classifyTool('Read', { file_path: p }, cwd).classes;

describe('a protected directory named as a whole', () => {
  // SELF_CONFIG_FILE protects files, so destroying the directory that holds them all
  // — the hook entry included — was classified as nothing at all.
  for (const c of [
    'rm -rf .claude',
    'rm -rf /home/dev/project/.claude',
    'rm -rf .claude/',
    'mv .claude /tmp/stash',
    'mv ./.cursor /tmp/stash',
    'rm -rf .stroq',
    'chmod 000 .codex',
  ]) {
    it(`is self-tamper: ${c}`, () => {
      expect(cmd(c)).toContain('config.self');
    });
  }

  // The bare `.claude` match was narrowed once already because ordinary work happens
  // inside these directories. This must not undo that.
  for (const c of [
    "sed -i '' 's/a/b/' .claude/CLAUDE.md",
    'cp README.md .claude/skills/notes/SKILL.md',
    'touch .claude/skills/new/SKILL.md',
    'mv .claude/skills/a .claude/skills/b',
    'rm -rf .claude/plugins/cache/old',
    'rm -rf node_modules',
    'rm -rf .clauderc',
    'mv src/claude.ts src/agent.ts',
  ]) {
    it(`is ordinary work: ${c}`, () => {
      expect(cmd(c)).not.toContain('config.self');
    });
  }

  it('leaves a read of the directory alone', () => {
    expect(cmd('ls -la .claude')).not.toContain('config.self');
  });

  // The shell expands the glob to exactly the files this protects.
  for (const c of ['rm -rf .claude/*', 'rm -rf .windsurf/*']) {
    it(`covers the glob: ${c}`, () => {
      expect(cmd(c)).toContain('config.self');
    });
  }

  // `.github` is the exception that proves the rule: two of its subdirectories are
  // Stroq's, and deleting a CI workflow is not a claim this project makes.
  for (const c of ['rm -rf .github/hooks', 'rm -rf .github/copilot']) {
    it(`covers ${c}`, () => {
      expect(cmd(c)).toContain('config.self');
    });
  }
  for (const c of ['rm -rf .github', 'rm -rf .github/workflows']) {
    it(`leaves ${c} alone`, () => {
      expect(cmd(c)).not.toContain('config.self');
    });
  }
});

describe('normalizePathForMatch', () => {
  it('collapses the spellings that name the same file', () => {
    const want = '/repo/.claude/settings.json';
    for (const p of [
      '/repo/.claude/settings.json',
      '/repo/.claude//settings.json',
      '/repo/.claude/./settings.json',
      '/repo/.claude/././settings.json',
      '/repo/x/../.claude/settings.json',
      '/repo/.CLAUDE/Settings.json',
    ]) {
      expect(normalizePathForMatch(p), p).toBe(want);
    }
  });

  it('leaves a leading .. alone rather than climbing past the root of the string', () => {
    expect(normalizePathForMatch('../../x')).toBe('../../x');
  });
});

describe('a protected file reached by another spelling', () => {
  for (const p of [
    '/home/dev/project/.claude//settings.json',
    '/home/dev/project/.claude/./settings.json',
    '/home/dev/project/x/../.claude/settings.json',
    // macOS and Windows resolve this to the same file; on a case-sensitive
    // filesystem folding can only over-match, which is the safe direction here.
    '/home/dev/project/.CLAUDE/settings.json',
  ]) {
    it(`is still self-tamper: ${p}`, () => {
      expect(write(p)).toContain('config.self');
    });
  }
});

describe('a bare credential directory', () => {
  // `/\.ssh\//` required something after the directory, so a tool pointed at the
  // directory itself carried no class and stayed allowed in a tainted session.
  for (const p of [
    '/home/dev/.ssh',
    '/home/dev/.aws',
    '/home/dev/.kube',
    '/home/dev/.config/gcloud',
  ]) {
    it(`is fs.secrets: ${p}`, () => {
      expect(read(p)).toContain('fs.secrets');
    });
  }

  for (const p of [
    '/home/dev/.sshconfig',
    '/home/dev/myaws/notes.md',
    '/home/dev/project/awsome.md',
    '/home/dev/.kubernetes/readme',
    '/home/dev/project/src/ssh.ts',
  ]) {
    it(`is not: ${p}`, () => {
      expect(read(p)).not.toContain('fs.secrets');
    });
  }
});
