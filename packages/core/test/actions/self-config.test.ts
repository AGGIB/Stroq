import { describe, expect, it } from 'vitest';
import {
  classifySelfConfigSegment,
  PROTECTED_DIRS,
  SELF_CONFIG_FILE,
  selfTamperSignals,
} from '../../src/actions/self-config.js';

describe('SELF_CONFIG_FILE (F5-1: protected files only, not bare .claude)', () => {
  it.each([
    'echo "# notes" > .claude/CLAUDE.md',
    '.claude/rules/style.md',
    'cp templates/CLAUDE.md .claude/CLAUDE.md',
    "sed -i 's/foo/bar/' .claude/CLAUDE.md",
    'rm .claude/CLAUDE.md.bak',
    'git checkout -- .claude/CLAUDE.md',
    'touch .claude/rules/new.md',
    'mv .claude/CLAUDE.md .claude/CLAUDE.md.bak',
    'chmod 644 .claude/CLAUDE.md',
    'rm -rf .claude-code/cache',
    'cd .claude && ls',
    'tar czf backup.tgz .claude',
    'vim .claude/CLAUDE.md',
    // `.github` is only protected where a literal `/hooks` or `/copilot` follows it:
    // an api.github.com URL and the workflows directory are not agent security config.
    'curl -s https://api.github.com/repos',
    'rm .github/workflows/ci.yml',
    'cat .github/copilot/instructions.md',
    // A file whose NAME starts with `hooks` is not the hooks directory: these are
    // documentation, and denying an edit to them is a false positive.
    'rm .github/hooks.md',
    "sed -i 's/a/b/' .github/hooks-README.md",
    // `.openclaw` is protected only at its three security-relevant entries: the
    // config file that can disable a plugin, and the two directories plugins and
    // extensions load from. Agent instructions and skills under it are not
    // security config, and a file whose NAME merely starts with `plugins` or
    // `extensions` is documentation.
    'cat .openclaw/agents/reviewer.md',
    'rm .openclaw/skills/deploy.md',
    'rm .openclaw/plugins.md',
    "sed -i 's/a/b/' .openclaw/extensions-README.md",
    // `.windsurf` is protected only at its hooks file: rules and workflows under it
    // are ordinary project content, and denying an edit to them would be the same
    // false positive the bare `.claude` match once was.
    'cat .windsurf/rules/style.md',
    'rm .windsurf/workflows/deploy.md',
    "sed -i 's/a/b/' .windsurf/hooks.md",
    // The capitalised system-directory alternative must not fire on a lowercase path.
    'rm ~/.codeium/windsurf/memories/notes.md',
  ])('does not match: %s', (text) => expect(SELF_CONFIG_FILE.test(text)).toBe(false));

  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.cursor/hooks.json',
    '.stroq',
    '~/.stroq',
    '.stroq/audit.jsonl',
    '.github/hooks/stroq.json',
    '.github/hooks',
    '.github/hooks/',
    // The directory still matches when something that cannot continue a filename
    // follows it, which is how `rm -rf .github/hooks && …` stays self-tampering.
    'rm -rf .github/hooks && echo done',
    'rm -rf ".github/hooks"',
    '.copilot/hooks/',
    '.github/copilot/settings.json',
    '.github/copilot/settings.local.json',
    '~/.copilot/hooks/stroq.json',
    '~/.copilot/settings.json',
    '.openclaw/openclaw.json',
    '~/.openclaw/openclaw.json',
    '.openclaw/plugins',
    '.openclaw/plugins/stroq/index.js',
    '.openclaw/extensions/',
    // The directory still matches when something that cannot continue a filename
    // follows it, which is how `rm -rf ~/.openclaw/plugins && …` stays self-tampering.
    'rm -rf ~/.openclaw/plugins && echo done',
    '.windsurf/hooks.json',
    '~/.codeium/windsurf/hooks.json',
    // The JetBrains plugin's file, which `init` does not write but a tainted agent
    // must still not be able to edit.
    '~/.codeium/hooks.json',
    '/etc/windsurf/hooks.json',
    '/Library/Application Support/Windsurf/hooks.json',
    'rm -f .windsurf/hooks.json',
  ])('matches protected file/dir: %s', (text) => expect(SELF_CONFIG_FILE.test(text)).toBe(true));
});

describe('PROTECTED_DIRS (F5-2: bare directories, find-only usage)', () => {
  it.each(['.claude -name', '.cursor/', '.stroq', '~/.stroq -delete'])(
    'matches bare protected dir: %s',
    (text) => expect(PROTECTED_DIRS.test(text)).toBe(true),
  );
  it('does not match an unrelated dotted word', () => {
    expect(PROTECTED_DIRS.test('mystroqrc')).toBe(false);
  });
  it.each(['.copilot -name', '.github/hooks -name', '.github/copilot/'])(
    'matches a bare Copilot dir: %s',
    (text) => expect(PROTECTED_DIRS.test(text)).toBe(true),
  );
  it('does not match .github on its own', () => {
    expect(PROTECTED_DIRS.test('.github -name')).toBe(false);
  });
  it.each(['.openclaw -name', '.openclaw/', '~/.openclaw -delete'])(
    'matches a bare OpenClaw dir: %s',
    (text) => expect(PROTECTED_DIRS.test(text)).toBe(true),
  );
  it.each(['.windsurf -name', '.windsurf/', '~/.codeium -delete', '.codeium/windsurf/'])(
    'matches a bare Windsurf dir: %s',
    (text) => expect(PROTECTED_DIRS.test(text)).toBe(true),
  );
});

describe('classifySelfConfigSegment', () => {
  it.each([
    'echo "# notes" > .claude/CLAUDE.md',
    'cp templates/CLAUDE.md .claude/CLAUDE.md',
    "sed -i 's/foo/bar/' .claude/CLAUDE.md",
    'rm .claude/CLAUDE.md.bak',
    'git checkout -- .claude/CLAUDE.md',
    'touch .claude/rules/new.md',
    'mv .claude/CLAUDE.md .claude/CLAUDE.md.bak',
    'chmod 644 .claude/CLAUDE.md',
    'rm -rf .claude-code/cache',
    'cd .claude && ls',
    'tar czf backup.tgz .claude',
    'vim .claude/CLAUDE.md',
  ])('null (no touch): %s', (segment) => expect(classifySelfConfigSegment(segment)).toBeNull());

  it.each([
    'echo x > ~/.claude/settings.json',
    'rm -rf .claude/settings.local.json',
    "python3 -c \"open('.claude/settings.json','w').write('{}')\"",
    'rm -rf ~/.stroq',
    'cat hooks.json > .cursor/hooks.json',
  ])('deny (write intent on protected file): %s', (segment) =>
    expect(classifySelfConfigSegment(segment)).toBe('deny'),
  );

  it('editing a protected file asks instead of denying', () => {
    expect(classifySelfConfigSegment('vim .claude/settings.json')).toBe('ask');
  });

  it('reading a protected file is not a touch', () => {
    expect(classifySelfConfigSegment('cat .claude/settings.json')).toBeNull();
  });
});

describe('find write intent (F5-2: -exec/-execdir gated on inner writer/reader)', () => {
  it.each([
    'find ~/.stroq -exec rm -rf {} \\;',
    'find .claude -name settings.json -exec sed -i s/a/b/ {} \\;',
    'find ~/.stroq -delete',
    "find .claude -name 'settings.json' -delete",
  ])('deny: %s', (segment) => expect(classifySelfConfigSegment(segment)).toBe('deny'));

  it.each(["find .claude -name '*.md' -exec cat {} \\;", "find .claude -name 'settings.json'"])(
    'null (reader exec or plain find): %s',
    (segment) => expect(classifySelfConfigSegment(segment)).toBeNull(),
  );
});

describe('F6 FIND_EXEC_WRITE_WORDS aligned with SELF_CONFIG_WRITE_COMMANDS', () => {
  it.each([
    'find ~/.stroq -exec touch {} \\;',
    'find ~/.stroq -exec dd of={} if=/dev/null \\;',
    'find .claude -name settings.json -exec bash -c "rm {}" \\;',
  ])('deny: %s', (segment) => expect(classifySelfConfigSegment(segment)).toBe('deny'));

  it('a plain reader inner command is still not write intent', () => {
    expect(classifySelfConfigSegment("find .claude -name '*.md' -exec cat {} \\;")).toBeNull();
  });
});

describe('selfTamperSignals', () => {
  it('produces deny signals for a write-intent segment and nothing for a benign one', () => {
    const result = selfTamperSignals(['echo "{}" > .claude/settings.json', 'ls -la']);
    expect(result.deny).toEqual(['self-config-write']);
    expect(result.ask).toEqual([]);
  });
  it('produces ask signals for an editor touch', () => {
    const result = selfTamperSignals(['vim .claude/settings.json']);
    expect(result.deny).toEqual([]);
    expect(result.ask).toEqual(['self-config-touch']);
  });
});

describe('switching the gate off through the agent’s own CLI (spec §2b)', () => {
  it.each([
    'openclaw plugins disable stroq',
    'openclaw plugins remove stroq',
    'openclaw plugins uninstall stroq',
    'openclaw config set plugins.entries.stroq.enabled false',
    // A wrapper word, an absolute path and an inner `-exec` are the same command.
    'sudo openclaw plugins disable stroq',
    '/usr/local/bin/openclaw plugins uninstall stroq',
    'find . -name x -exec openclaw plugins remove stroq \\;',
  ])('deny (the firewall stops running): %s', (segment) =>
    expect(classifySelfConfigSegment(segment)).toBe('deny'),
  );

  it.each([
    'openclaw plugins list',
    'openclaw plugins inspect stroq --runtime',
    'openclaw plugins enable stroq',
    'openclaw gateway restart',
    // A name that merely starts with the same letters is a different program.
    'myopenclaw plugins disable stroq',
  ])('null (checking or repairing the install is not tampering): %s', (segment) =>
    expect(classifySelfConfigSegment(segment)).toBeNull(),
  );

  it.each([
    'openclaw plugins install --link ~/.stroq/openclaw-plugin',
    'openclaw config get plugins.entries.stroq.enabled',
  ])('still only asks where a protected word is named: %s', (segment) => {
    // Pre-existing behaviour, pinned here so the new gate cannot turn the documented
    // repair and inspection commands into denies: both name `.stroq` (the plugin
    // directory, and the `entries.stroq` config key) through a command word that is
    // neither a known reader nor a known writer, which has always been an ask.
    expect(classifySelfConfigSegment(segment)).toBe('ask');
  });

  it('names its own signal, so the audit says which kind of tamper it was', () => {
    expect(selfTamperSignals(['openclaw plugins disable stroq'])).toEqual({
      deny: ['self-config-disable'],
      ask: [],
    });
  });
});
