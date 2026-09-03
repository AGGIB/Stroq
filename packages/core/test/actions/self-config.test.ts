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
  ])('does not match: %s', (text) => expect(SELF_CONFIG_FILE.test(text)).toBe(false));

  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.cursor/hooks.json',
    '.stroq',
    '~/.stroq',
    '.stroq/audit.jsonl',
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
