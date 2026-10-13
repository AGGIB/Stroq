import { describe, expect, it } from 'vitest';
import { installedFile, notesOf } from '../../src/commands/init-flow.js';

describe('notesOf', () => {
  it('has no notes for no output', () => {
    expect(notesOf('')).toEqual([]);
  });

  it('drops the indented lines, which are the config the installer wrote', () => {
    const out = '  PreToolUse         → Bash|Write\n  PostToolUse        → Read\n';

    expect(notesOf(out)).toEqual([]);
  });

  it('drops the line that names the file', () => {
    expect(notesOf('Stroq hooks installed in /p/.claude/settings.json\n')).toEqual([]);
  });

  it('drops the line that names the plugin directory', () => {
    expect(notesOf('Stroq plugin installed in /h/.stroq/openclaw-plugin\n')).toEqual([]);
  });

  it('drops the line that tells the person to run doctor', () => {
    expect(notesOf('Run "stroq doctor" to verify.\n')).toEqual([]);
  });

  it('drops the line that says how to remove the hooks', () => {
    expect(notesOf('To remove them: stroq uninstall --agent cursor\n')).toEqual([]);
  });

  it('drops blank lines and lines that are only spaces', () => {
    expect(notesOf('\n   \n\t\n')).toEqual([]);
  });

  it('keeps a note about a restart, even one that mentions doctor', () => {
    const note = 'Restart Cursor, then run "stroq doctor" to verify.';

    expect(notesOf(`Stroq hooks installed in /p/.cursor/hooks.json\n${note}\n`)).toEqual([note]);
  });

  it('keeps a note about an approval, and the notes after it, in order', () => {
    const out = [
      'Stroq hooks installed in /p/.codex/hooks.json',
      '  PreToolUse  → Bash',
      "Codex runs a new or changed hook only after you approve it: start codex and approve Stroq's hooks",
      'when it lists them for review.',
      '"stroq init --agent codex --user" writes ~/.codex/hooks.json instead.',
      'Run "stroq doctor" to verify.',
      'To remove them: stroq uninstall --agent codex',
      '',
    ].join('\n');

    expect(notesOf(out)).toEqual([
      "Codex runs a new or changed hook only after you approve it: start codex and approve Stroq's hooks",
      'when it lists them for review.',
      '"stroq init --agent codex --user" writes ~/.codex/hooks.json instead.',
    ]);
  });

  it('keeps a warning, and a line that begins with a dollar sign', () => {
    const out = 'Warning: /p/.devin/hooks.json defines hooks\n$ openclaw plugins enable stroq\n';

    expect(notesOf(out)).toEqual([
      'Warning: /p/.devin/hooks.json defines hooks',
      '$ openclaw plugins enable stroq',
    ]);
  });

  it('keeps an error that has no file in it', () => {
    expect(notesOf('cannot parse /p/.claude/settings.json: boom\n')).toEqual([
      'cannot parse /p/.claude/settings.json: boom',
    ]);
  });

  it('trims the end of each note, and reads lines that end in a carriage return', () => {
    expect(notesOf('first note   \r\nsecond note\r\n')).toEqual(['first note', 'second note']);
  });

  it('keeps the spaces inside a note', () => {
    expect(notesOf('Restart it, then   run   doctor.\n')).toEqual([
      'Restart it, then   run   doctor.',
    ]);
  });

  it('keeps nothing of the output of a plain Claude Code install', () => {
    const out = [
      'Stroq hooks installed in /p/.claude/settings.json',
      '  PreToolUse         → Bash',
      '  PostToolUse        → Read',
      '  PostToolUseFailure → Read',
      'Run "stroq doctor" to verify.',
      'To remove them: stroq uninstall',
      '',
    ].join('\n');

    expect(notesOf(out)).toEqual([]);
  });
});

describe('installedFile', () => {
  it('is the file a hooks install says it wrote', () => {
    const out = 'Stroq hooks installed in /p/.claude/settings.json\n  PreToolUse → Bash\n';

    expect(installedFile(out)).toBe('/p/.claude/settings.json');
  });

  it('is the directory a plugin install says it wrote', () => {
    expect(installedFile('Stroq plugin installed in /h/.stroq/openclaw-plugin\n')).toBe(
      '/h/.stroq/openclaw-plugin',
    );
  });

  it('keeps a path with spaces whole', () => {
    expect(
      installedFile('Stroq hooks installed in /Users/Jane Doe/my app/.claude/settings.json\n'),
    ).toBe('/Users/Jane Doe/my app/.claude/settings.json');
  });

  it('trims spaces and a carriage return from the end of the path', () => {
    expect(installedFile('Stroq hooks installed in /p/x.json  \r\nnext\r\n')).toBe('/p/x.json');
  });

  it('finds the line when other lines come before it', () => {
    const out =
      'Stroq ran from the npx cache; the hooks run a copy at /h/cli\nStroq hooks installed in /p/x.json\n';

    expect(installedFile(out)).toBe('/p/x.json');
  });

  it('takes the first when there are two', () => {
    const out = 'Stroq hooks installed in /first.json\nStroq hooks installed in /second.json\n';

    expect(installedFile(out)).toBe('/first.json');
  });

  it('is null when no file is named', () => {
    expect(installedFile('Restart Cursor.\n')).toBeNull();
    expect(installedFile('')).toBeNull();
  });

  it('is null for a line that only mentions an install in the middle of it', () => {
    expect(installedFile('note: Stroq hooks installed in /p/x.json\n')).toBeNull();
  });

  it('is null for an install line with no path after it', () => {
    expect(installedFile('Stroq hooks installed in \n')).toBeNull();
  });
});
