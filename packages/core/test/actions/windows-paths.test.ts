import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool, normalizePathForMatch } from '../../src/actions/classify-tool.js';
import { isGitExecPath } from '../../src/actions/git-exec.js';
import {
  classifySelfConfigSegment,
  PROTECTED_DIR_BARE,
  SELF_CONFIG_FILE,
} from '../../src/actions/self-config.js';

/**
 * Every protected path in this codebase was written with `/` as its only separator.
 * On Windows every one of those paths arrives with backslashes — from the agent's
 * `file_path`, from a PowerShell command line, from `%USERPROFILE%` — so none of the
 * patterns matched anything there. Self-tamper protection did not degrade on Windows,
 * it was absent, for every agent at once, while `stroq exposure` and the hook decision
 * both reported a clean result.
 *
 * The rule the fix has to keep: widening a separator must never make a protected path
 * EASIER to hide. Widening a pattern can only add matches, and every outcome of a
 * match here is `deny`, `ask` or "a reader, so nothing" — there is no branch that
 * allows BECAUSE something matched — so the cost lands entirely on POSIX false
 * positives, on paths whose filename genuinely contains a backslash. Those are pinned
 * below as a deliberate price rather than left to be discovered.
 */

const classesOf = (command: string, cwd = '/repo'): readonly string[] =>
  classifyCommand(command, cwd).classes;

describe('protected agent-config files, spelled the way Windows spells them', () => {
  it.each([
    '.claude\\settings.json',
    '.claude\\settings.local.json',
    'C:\\Users\\me\\.claude\\settings.json',
    '.cursor\\hooks.json',
    '.codex\\hooks.json',
    '.codex\\config.toml',
    '.github\\hooks\\stroq.json',
    '.github\\copilot\\settings.json',
    '.copilot\\hooks\\stroq.json',
    '.copilot\\settings.json',
    '.openclaw\\openclaw.json',
    '.openclaw\\plugins\\stroq\\index.js',
    '.windsurf\\hooks.json',
    'C:\\Users\\me\\.codeium\\windsurf\\hooks.json',
    'C:\\Users\\me\\.codeium\\hooks.json',
    '.agents\\hooks.json',
    'C:\\Users\\me\\.gemini\\config\\hooks.json',
    'C:\\Users\\me\\.gemini\\antigravity-cli\\settings.json',
    '%APPDATA%\\Claude\\claude_desktop_config.json',
    'C:\\Users\\me\\.codeium\\windsurf\\mcp_config.json',
    '.stroq\\audit.jsonl',
  ])('matches: %s', (path) => expect(SELF_CONFIG_FILE.test(path)).toBe(true));

  /**
   * The narrowing that was fought for on the POSIX side has to survive the widening:
   * every one of these is somebody's own file whose name merely starts the same way,
   * and denying an edit to it is the false positive the bare `.claude` match once was.
   */
  it.each([
    'notes\\.claude\\CLAUDE.md',
    '.github\\hooks.md',
    '.github\\hooks-README.md',
    '.github\\workflows\\ci.yml',
    '.openclaw\\plugins.md',
    '.openclaw\\extensions-README.md',
    '.windsurf\\rules\\style.md',
    '.agents\\reviewer.md',
    'C:\\Users\\me\\.gemini\\settings.json',
    'C:\\temp\\claudesettings.json',
    'node_modules\\.cache\\index',
    'old_mcp_config.json',
    'backup.claude_desktop_config.json',
  ])('does not match: %s', (path) => expect(SELF_CONFIG_FILE.test(path)).toBe(false));
});

describe('a write to a protected file spelled with backslashes', () => {
  // The verb here is one the POSIX gate already knows. Recognising PowerShell's own
  // verbs (`Remove-Item`, `Set-Content`, …) is the PowerShell classifier's job, and
  // is covered there — this is about the path arriving in the other spelling.
  it.each([
    'rm -Force C:\\Users\\me\\.codeium\\windsurf\\hooks.json',
    'mv .agents\\hooks.json .agents\\hooks.json.bak',
    "sed -i 's/a/b/' .github\\hooks\\stroq.json",
  ])('denies: %s', (segment) => expect(classifySelfConfigSegment(segment)).toBe('deny'));

  it('denies deleting the whole protected directory by its Windows path', () => {
    // A drive-qualified absolute path is the ordinary shape on Windows, and this
    // command takes Stroq's hook entry with everything else under the directory.
    expect(PROTECTED_DIR_BARE.test('rm -Recurse -Force C:\\Users\\me\\.claude')).toBe(true);
    expect(classifySelfConfigSegment('rm -Recurse -Force C:\\Users\\me\\.claude')).toBe('deny');
  });
});

/**
 * The tool route, which reaches the same patterns through `normalizePathForMatch`.
 * The normaliser resolves `.` and `..` so that `.claude/./settings.json` cannot walk
 * past the gate; on Windows it saw one long segment with no separator in it at all,
 * so the evasion it exists to stop worked there unchanged.
 */
describe('normalizePathForMatch on a Windows path', () => {
  it('reads a backslash as the separator it is', () => {
    expect(normalizePathForMatch('.claude\\settings.json')).toBe('.claude/settings.json');
  });

  it('collapses the dot segments that would otherwise walk past the gate', () => {
    expect(normalizePathForMatch('.claude\\.\\settings.json')).toBe('.claude/settings.json');
    expect(normalizePathForMatch('.claude\\sub\\..\\settings.json')).toBe('.claude/settings.json');
    expect(normalizePathForMatch('.claude\\\\settings.json')).toBe('.claude/settings.json');
  });

  it('still normalises a POSIX path exactly as before', () => {
    expect(normalizePathForMatch('.claude/./sub/../settings.json')).toBe('.claude/settings.json');
  });
});

describe('classifyTool on Windows tool arguments', () => {
  it('classifies a write to the protected settings file', () => {
    const result = classifyTool(
      'Write',
      { file_path: 'C:\\Users\\me\\.claude\\settings.json' },
      '',
    );
    expect(result.classes).toContain('config.self');
  });

  it('classifies a write that walks through a dot segment to get there', () => {
    const result = classifyTool('Edit', { file_path: '.claude\\.\\settings.json' }, '');
    expect(result.classes).toContain('config.self');
  });

  it('classifies a write that installs repository-supplied execution', () => {
    const result = classifyTool('Write', { file_path: '.git\\hooks\\pre-commit' }, '');
    expect(result.classes).toContain('config.git_exec');
  });

  it('classifies a read of a credential file', () => {
    const result = classifyTool('Read', { file_path: 'C:\\Users\\me\\.ssh\\id_rsa' }, '');
    expect(result.classes).toContain('fs.secrets');
  });

  it('leaves an ordinary Windows path alone', () => {
    expect(classifyTool('Write', { file_path: 'C:\\src\\app\\index.ts' }, '').classes).toEqual([]);
  });
});

describe('the command route: credential and git-exec paths with backslashes', () => {
  it.each([
    'Get-Content C:\\Users\\me\\.ssh\\id_rsa',
    'Get-Content $env:USERPROFILE\\.aws\\credentials',
    'type .kube\\config',
    'Get-Content .config\\gcloud\\credentials.db',
  ])('sees the credential path in: %s', (command) =>
    expect(classesOf(command)).toContain('fs.secrets'),
  );

  it('sees a write to a git hook file spelled with backslashes', () => {
    expect(isGitExecPath('.git\\hooks\\pre-commit')).toBe(true);
    expect(isGitExecPath('.git\\config')).toBe(true);
    expect(classesOf('rm .git\\hooks\\pre-commit')).toContain('config.git_exec');
  });

  it('still refuses a document that merely talks about one', () => {
    expect(isGitExecPath('docs\\.gitattributes.md')).toBe(false);
  });
});

/**
 * POSIX is not weakened, and one POSIX hole closes as a side effect. `\/` is a legal
 * way to write `/` in a shell word, so `rm .claude\/settings.json` deleted the
 * protected file while the pattern — which required the two names to be adjacent
 * across exactly one slash — saw nothing. Accepting a run of separators in either
 * spelling covers it.
 */
describe('POSIX behaviour under the widened separator', () => {
  it.each([
    '.claude/settings.json',
    '~/.codeium/windsurf/hooks.json',
    '/etc/windsurf/hooks.json',
    '/Library/Application Support/Windsurf/hooks.json',
    '.github/hooks',
  ])('still matches the POSIX spelling: %s', (path) =>
    expect(SELF_CONFIG_FILE.test(path)).toBe(true),
  );

  it.each([
    'echo "# notes" > .claude/CLAUDE.md',
    'rm .github/workflows/ci.yml',
    'rm .github/hooks.md',
    'cat .openclaw/agents/reviewer.md',
    'rm .mcp.json',
  ])('still leaves alone: %s', (text) => expect(SELF_CONFIG_FILE.test(text)).toBe(false));

  it('now catches a backslash-escaped slash, which named the protected file all along', () => {
    expect(classifySelfConfigSegment('rm .claude\\/settings.json')).toBe('deny');
  });

  /**
   * The price, stated rather than discovered: a backslash is a legal character in a
   * POSIX filename, so a single file genuinely named `.claude\settings.json` is now
   * treated as the protected one. It is an over-match, which on this gate means an
   * extra confirmation rather than a bypass — the direction every other judgement
   * call in this file already errs in.
   */
  it('over-matches a POSIX filename that contains a literal backslash', () => {
    expect(SELF_CONFIG_FILE.test('./.claude\\settings.json')).toBe(true);
  });
});
