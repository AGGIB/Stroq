import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';

const cwd = '/home/dev/project';
const classesOf = (cmd: string) => classifyCommand(cmd, cwd).classes;

describe('F3 self-tamper gate precision: write intent (deny) vs reference (ask)', () => {
  it.each([
    'git add .claude/settings.json',
    'git diff .claude/settings.json',
    'git status .claude/settings.json',
    'echo "edit .claude/settings.json"',
    'test -f .claude/settings.json',
    'mkdir -p ~/.stroq',
    'du -sh ~/.stroq',
    'python3 -m json.tool .claude/settings.json',
  ])('no class at all: %s', (cmd) => {
    const classes = classesOf(cmd);
    expect(classes).not.toContain('config.self');
    expect(classes).not.toContain('config.self_touch');
  });

  it.each([
    'code .claude/settings.json',
    'vim .claude/settings.json',
    'nano .claude/settings.json',
  ])('ask (config.self_touch), not deny: %s', (cmd) => {
    const classes = classesOf(cmd);
    expect(classes).not.toContain('config.self');
    expect(classes).toContain('config.self_touch');
  });

  it.each([
    'echo "{}" > .claude/settings.json',
    'sed -i "s/deny/allow/" .claude/settings.local.json',
    'rm -rf ~/.stroq',
    'cat hooks.json > .cursor/hooks.json',
    'python3 -c "import os;os.remove(\'.claude/settings.json\')"',
    'perl -pi -e "s/hooks//" .claude/settings.json',
    "jq 'del(.hooks)' .claude/settings.json | sponge .claude/settings.json",
    'git checkout HEAD -- .claude/settings.json',
  ])('still denied (write intent): %s', (cmd) => expect(classesOf(cmd)).toContain('config.self'));

  it.each([
    'cat .claude/settings.json',
    'jq .hooks .claude/settings.json',
    'grep stroq .claude/settings.json',
  ])('reads stay entirely clean: %s', (cmd) => {
    const classes = classesOf(cmd);
    expect(classes).not.toContain('config.self');
    expect(classes).not.toContain('config.self_touch');
  });
});

describe('F4 find with actions against protected paths is write intent', () => {
  it.each([
    'find ~/.stroq -delete',
    "find .claude -name 'settings.json' -delete",
    'find ~/.stroq -exec rm -rf {} \\;',
  ])('config.self: %s', (cmd) => expect(classesOf(cmd)).toContain('config.self'));

  it.each(["find .claude -name 'settings.json'", 'find ~/.stroq -type f'])(
    'no class (read-only find): %s',
    (cmd) => {
      const classes = classesOf(cmd);
      expect(classes).not.toContain('config.self');
      expect(classes).not.toContain('config.self_touch');
    },
  );
});

describe('F5-1 SELF_CONFIG narrowed to protected files only (not bare .claude)', () => {
  it.each([
    'echo "# notes" > .claude/CLAUDE.md',
    'echo "- rule" >> .claude/rules/style.md',
    'cp templates/CLAUDE.md .claude/CLAUDE.md',
    "sed -i 's/foo/bar/' .claude/CLAUDE.md",
    'rm .claude/CLAUDE.md.bak',
    'git checkout -- .claude/CLAUDE.md',
    'touch .claude/rules/new.md',
    'mv .claude/CLAUDE.md .claude/CLAUDE.md.bak',
    'chmod 644 .claude/CLAUDE.md',
    'rm -rf .claude-code/cache',
    'echo done > out.txt # updated .claude/CLAUDE.md',
    'cd .claude && ls',
    'tar czf backup.tgz .claude',
    'vim .claude/CLAUDE.md',
  ])('no class at all (routine edit, not self-tamper): %s', (cmd) => {
    const classes = classesOf(cmd);
    expect(classes).not.toContain('config.self');
    expect(classes).not.toContain('config.self_touch');
  });

  it.each([
    'echo x > ~/.claude/settings.json',
    'rm -rf .claude/settings.local.json',
    "python3 -c \"open('.claude/settings.json','w').write('{}')\"",
    'rm -rf ~/.stroq',
    'cat hooks.json > .cursor/hooks.json',
  ])('still config.self (real protected-file tamper): %s', (cmd) =>
    expect(classesOf(cmd)).toContain('config.self'),
  );

  it('editing a protected file still asks, not denies', () => {
    const classes = classesOf('vim .claude/settings.json');
    expect(classes).not.toContain('config.self');
    expect(classes).toContain('config.self_touch');
  });
});

describe('F5-2 find -exec/-execdir write intent gated on the inner command', () => {
  it('a reader inner command is not write intent', () => {
    const classes = classesOf("find .claude -name '*.md' -exec cat {} \\;");
    expect(classes).not.toContain('config.self');
    expect(classes).not.toContain('config.self_touch');
  });
  it.each([
    'find ~/.stroq -exec rm -rf {} \\;',
    'find .claude -name settings.json -exec sed -i s/a/b/ {} \\;',
    'find ~/.stroq -delete',
  ])('a writer/deleter inner command (or -delete) is write intent: %s', (cmd) =>
    expect(classesOf(cmd)).toContain('config.self'),
  );
});

describe('I3 self-tamper gate bypasses', () => {
  it.each([
    'python3 -c "import os;os.remove(\'.claude/settings.json\')"',
    'perl -pi -e "s/hooks//" .claude/settings.json',
    "jq 'del(.hooks)' .claude/settings.json | sponge .claude/settings.json",
    'git checkout HEAD -- .claude/settings.json',
  ])('deny-unless-read: %s', (cmd) => expect(classesOf(cmd)).toContain('config.self'));

  it.each([
    'cat .claude/settings.json',
    'jq .hooks .claude/settings.json',
    'grep stroq .claude/settings.json',
  ])('read-only access is not tampering: %s', (cmd) =>
    expect(classesOf(cmd)).not.toContain('config.self'),
  );
});

describe('the agent’s own CLI can switch the gate off (OpenClaw, spec §2b)', () => {
  it.each([
    'openclaw plugins disable stroq',
    'openclaw plugins remove stroq',
    'openclaw plugins uninstall stroq',
    'openclaw config set plugins.entries.stroq.enabled false',
  ])('config.self: %s', (cmd) => expect(classesOf(cmd)).toContain('config.self'));

  it.each(['openclaw plugins list', 'openclaw plugins enable stroq', 'openclaw gateway restart'])(
    'no class at all (checking or repairing the install): %s',
    (cmd) => {
      const classes = classesOf(cmd);
      expect(classes).not.toContain('config.self');
      expect(classes).not.toContain('config.self_touch');
    },
  );
});
