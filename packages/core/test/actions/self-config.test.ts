import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import {
  classifySelfConfigSegment,
  hasFileRedirect,
  PROTECTED_DIRS,
  SELF_CONFIG_FILE,
  selfTamperSignals,
  stroqStateSignals,
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
    // The same holds for `.devin`: only its hooks file is protected.
    'cat .devin/rules/style.md',
    'rm .devin/workflows/deploy.md',
    "sed -i 's/a/b/' .devin/hooks.md",
    // The capitalised system-directory alternative must not fire on a lowercase path.
    'rm ~/.codeium/windsurf/memories/notes.md',
    // Antigravity is protected at its three config FILES. `.agents` holds agent
    // definitions and `~/.gemini` is the Gemini CLI's whole home, so an edit to
    // anything else under either is ordinary work.
    'cat .agents/reviewer.md',
    'rm .agents/hooks.md',
    "sed -i 's/a/b/' .agents/hooks-README.md",
    'rm ~/.gemini/settings.json',
    'rm ~/.gemini/tmp/session.json',
    'rm ~/.gemini/antigravity-cli/logs/run.log',
    // A project MCP config is NOT protected: adding an MCP server to `.mcp.json` or
    // `.cursor/mcp.json` is routine agent work, and denying it would be the bare
    // `.claude` false positive again. The user-level client configs below are.
    'rm .mcp.json',
    "sed -i 's/a/b/' .cursor/mcp.json",
    // A file whose NAME merely ends with the protected one is not the protected file.
    'rm old_mcp_config.json',
    'cat backup.claude_desktop_config.json',
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
    // Windsurf is now documented as Devin Desktop: `.devin/hooks.json` is the primary
    // workspace file, and `.windsurf/hooks.json` is read only when it is absent or
    // defines no hooks. A file an agent writes there silences a project-scope install.
    '.devin/hooks.json',
    'rm -f .devin/hooks.json',
    '/etc/devin/hooks.json',
    '/Library/Application Support/Devin/hooks.json',
    'C:\\ProgramData\\Devin\\hooks.json',
    'C:\\ProgramData\\Windsurf\\hooks.json',
    'C:/ProgramData/Devin/hooks.json',
    // How a shell writes the same directory without spelling out the drive.
    'echo {} > %ProgramData%\\Devin\\hooks.json',
    'Set-Content $env:ProgramData\\Devin\\hooks.json "{}"',
    // Spelled the other ways a shell reaches the same directory.
    'echo {} > $ProgramData/Devin/hooks.json',
    'Set-Content ${env:ProgramData}\\Devin\\hooks.json "{}"',
    'echo {} > /c/ProgramData/Devin/hooks.json',
    'echo {} > C:////ProgramData/Devin/hooks.json',
    'docs/ProgramData/Devin/hooks.json',
    '.agents/hooks.json',
    'rm -f .agents/hooks.json',
    '~/.gemini/config/hooks.json',
    '~/.gemini/antigravity-cli/settings.json',
    '~/Library/Application Support/Claude/claude_desktop_config.json',
    '~/.config/Claude/claude_desktop_config.json',
    'rm -f claude_desktop_config.json',
    '~/.codeium/windsurf/mcp_config.json',
    '~/.codeium/mcp_config.json',
  ])('matches protected file/dir: %s', (text) => expect(SELF_CONFIG_FILE.test(text)).toBe(true));
});

describe('SELF_CONFIG_FILE anchors the Windsurf system paths (review fix, no bare substring match)', () => {
  it.each([
    'scripts/etc/windsurf/hooks.json',
    'docs/Windsurf/hooks.json',
    'my-etc/windsurf/hooks.json',
    'scripts/etc/devin/hooks.json',
    'docs/Devin/hooks.json',
    'my-etc/devin/hooks.json',
    'MyProgramData/Devin/hooks.json',
    'ProgramData-old/Devin/hooks.json',
  ])('does not match a relative look-alike: %s', (text) =>
    expect(SELF_CONFIG_FILE.test(text)).toBe(false),
  );

  it.each([
    '/etc/windsurf/hooks.json',
    'sudo tee /etc/windsurf/hooks.json',
    '"/etc/windsurf/hooks.json"',
    '"/Library/Application Support/Windsurf/hooks.json"',
    '/Library/Application\\ Support/Windsurf/hooks.json',
  ])('still matches the anchored absolute path: %s', (text) =>
    expect(SELF_CONFIG_FILE.test(text)).toBe(true),
  );

  it('denies a write to the anchored Linux system path', () => {
    expect(classifySelfConfigSegment('rm -f /etc/windsurf/hooks.json')).toBe('deny');
  });
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
  it.each(['.devin -name', '.devin/', '~/.devin -delete'])('matches a bare Devin dir: %s', (text) =>
    expect(PROTECTED_DIRS.test(text)).toBe(true),
  );
  it.each(['.agents -name', '.agents/', '~/.gemini -delete', '.gemini/config/'])(
    'matches a bare Antigravity dir: %s',
    (text) => expect(PROTECTED_DIRS.test(text)).toBe(true),
  );
});

describe('the Antigravity config files', () => {
  it('denies a write to each of the three, and to the bare directories', () => {
    for (const segment of [
      'rm -f .agents/hooks.json',
      "sed -i 's/stroq//' ~/.gemini/config/hooks.json",
      'tee ~/.gemini/antigravity-cli/settings.json',
      'rm -rf .agents',
      'rm -rf ~/.gemini',
      "find .agents -name 'hooks.json' -delete",
    ])
      expect(classifySelfConfigSegment(segment), segment).toBe('deny');
  });

  it('leaves the rest of .agents and ~/.gemini editable', () => {
    for (const segment of [
      'rm .agents/reviewer.md',
      "sed -i 's/a/b/' ~/.gemini/settings.json",
      'rm -rf ~/.gemini/tmp/cache',
    ])
      expect(classifySelfConfigSegment(segment), segment).toBe(null);
  });

  it('does not reach the directory between the bare one and the file', () => {
    // A documented limit rather than a gap: `SELF_CONFIG_FILE` names the three
    // files and `PROTECTED_DIR_BARE` the two bare directories, so a delete of
    // `~/.gemini/antigravity-cli` — which takes the global settings file with it —
    // carries no `config.self`. Pre-existing for every agent's own directory except
    // `.stroq`, and pinned here so the claim and the behaviour cannot drift apart.
    expect(classifySelfConfigSegment('rm -rf ~/.gemini/antigravity-cli')).toBe(null);
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

describe('the two user-level MCP client configs (spec §2d)', () => {
  it('denies a write to a client config and leaves a read alone', () => {
    // Unwrapping the proxy out of either file switches Stroq off for that client, so
    // a write is self-tampering wherever it comes from; reading one is not.
    expect(
      classifySelfConfigSegment(
        'rm -f ~/Library/Application\\ Support/Claude/claude_desktop_config.json',
      ),
    ).toBe('deny');
    expect(classifySelfConfigSegment('cat ~/.codeium/mcp_config.json')).toBe(null);
    expect(classifySelfConfigSegment('vim ~/.codeium/windsurf/mcp_config.json')).toBe('ask');
  });

  it('leaves the project MCP configs editable, which is the stated gap', () => {
    // Stated in the README and SECURITY.md rather than fixed: a content-aware check
    // that protects only the wrapped entries is the follow-up.
    expect(classifySelfConfigSegment('echo "{}" > .mcp.json')).toBe(null);
    expect(classifySelfConfigSegment('echo "{}" > .cursor/mcp.json')).toBe(null);
  });

  it('does not widen the bare-directory list', () => {
    // `PROTECTED_DIRS` is consulted for `find` only and gains nothing here: there is
    // no MCP directory to protect, only two files.
    expect(PROTECTED_DIRS.test('.mcp.json')).toBe(false);
    expect(PROTECTED_DIRS.test('Claude -name')).toBe(false);
  });
});

// An agent that could run these could clear its own taint, waive the scan of the file
// that tainted it, or take the hooks out, and nothing classified the call: each came
// back with no class at all and was allowed in a tainted session.
describe("changing Stroq's own state through its CLI", () => {
  it.each([
    'stroq untaint --all',
    'stroq untaint --session s1',
    'stroq trust README.md',
    'stroq trust --remove README.md',
    'stroq init --agent cursor',
    'stroq uninstall',
    'npx @stroq/cli untaint --all',
    'npx -y @stroq/cli@0.19.2 trust notes.md',
    'pnpm dlx @stroq/cli uninstall --user',
    'node /usr/local/lib/node_modules/@stroq/cli/dist/index.js untaint --all',
    'sudo stroq untaint --all',
    '/usr/local/bin/stroq untaint --all',
    // Found by a review of 0.20.0: each was allowed.
    'npx stroq untaint --all',
    'npx -y stroq untaint --all',
    'pnpm exec stroq untaint --all',
    'pnpm stroq untaint --all',
    'yarn stroq untaint --all',
    'npm exec stroq untaint --all',
    'npm exec -- stroq untaint --all',
    'bunx stroq untaint --all',
    'npx -p @stroq/cli stroq init',
    'npx --package=@stroq/cli stroq untaint',
    'stroq.cmd untaint --all',
    'stroq.exe untaint --all',
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\stroq.cmd untaint --all',
    'node C:\\dev\\node_modules\\@stroq\\cli\\dist\\index.js untaint --all',
    'node packages/cli/dist/index.js untaint --all',
    '$(which stroq) untaint --all',
    '`which stroq` untaint --all',
    'S=stroq; $S untaint --all',
    'S=stroq; ${S} trust notes.md',
    'bash -c "stroq untaint --all"',
    'ls && stroq untaint --all',
    // A string a shell runs is commands, line by line: only text is joined.
    'bash -c "ls\nstroq untaint --all"',
    "sh -c 'echo hi\nstroq trust notes.md'",
    "bash <<'EOF'\nstroq untaint --all\nEOF",
    'eval "ls\nstroq init"',
    // Found by a second review of the reading of functions, 2026-10-07: a command that stands where a command
    // begins in a group, a subshell, a branch, a loop, an arm of `case` or a function was allowed.
    '{ stroq untaint --all; }',
    '(stroq untaint --all)',
    '( stroq untaint --all )',
    'if true; then stroq untaint --all; fi',
    'if false; then :; else stroq untaint --all; fi',
    'for i in 1; do stroq untaint --all; done',
    'while true; do stroq init; done',
    'until false; do stroq uninstall; done',
    'case x in x) stroq untaint --all ;; esac',
    'case x in\n  x) stroq untaint --all ;;\nesac',
    '! stroq untaint --all',
    'true && { stroq untaint --all; }',
    'f() { stroq untaint --all; }; f',
    'function f { stroq init; }',
    'function f() { stroq init; }',
    'function f { stroq init; }; f',
    'function f() { stroq init; }; f',
    'f() ( stroq untaint --all ); f',
    'g() { stroq "$@"; }; g untaint --all',
    'g() { stroq "$1" "$2"; }; g trust notes.md',
    '{ npx @stroq/cli untaint; }',
    '(S=stroq; $S untaint --all)',
    '{ sudo stroq untaint --all; }',
    // The wrappers that this check had no name for, a redirect that stands before the command, a zsh brace body.
    'echo | xargs -I{} stroq untaint --all',
    "watch -n1 'stroq untaint --all'",
    'stdbuf -oL stroq untaint --all',
    'builtin exec stroq untaint --all',
    '> /dev/null stroq untaint --all',
    '2>/dev/null stroq init --agent cursor',
    'if true { stroq untaint --all }',
    "parallel 'stroq untaint --all' ::: a",
    'setsid stroq uninstall',
    // Found by a third review, 2026-10-07: a program that runs another after a verb or after options of its own, and
    // the options of a package runner that take a value (a package, a directory, a cache, a registry). The strings
    // that `nix-shell --run`, `nix develop -c` and `runuser -c` hand to a shell are read with the texts of the
    // classifier, in `review-round8-readings.test.ts`.
    'direnv exec . stroq untaint --all',
    'mise exec -- stroq uninstall',
    'mise exec node@20 -- stroq untaint',
    'asdf exec stroq init --agent cursor',
    'corepack yarn stroq trust notes.md',
    'corepack pnpm exec stroq untaint',
    'uv run --with x stroq untaint',
    'conda run -n base stroq uninstall',
    'pnpm --filter pkgname exec stroq untaint',
    'pnpm -F pkgname exec stroq untaint',
    'pnpm -C proj exec stroq untaint',
    'pnpm --dir proj exec stroq untaint',
    'npx --prefix /opt stroq untaint',
    'npx --registry http://localhost:1 stroq untaint',
    'npx --cache /tmp/c stroq untaint',
    'npx --userconfig /tmp/rc stroq untaint',
    'npm exec --cache /tmp/c --offline stroq untaint',
    'npm exec --prefix /opt -- stroq untaint',
    'yarn --cwd proj stroq untaint',
    'yarn workspace pkgname stroq untaint',
    'yarn workspace pkgname exec stroq untaint',
    'flock /tmp/l stroq untaint --all',
    'flock -n /tmp/l stroq untaint --all',
    'chrt 10 stroq untaint --all',
    'taskset 1 stroq untaint --all',
    'chroot /x stroq untaint --all',
    'strace -f stroq init',
    'strace -o /tmp/t stroq untaint',
    'ltrace stroq untaint',
    'runuser -u nobody -- stroq untaint',
    'unshare -m stroq untaint',
    'nsenter -t 1 -m stroq untaint',
    'systemd-run --user stroq uninstall',
    'sshpass -p secret stroq untaint',
    'flock /tmp/l chrt 10 stroq untaint --all',
    '{ flock /tmp/l stroq untaint --all; }',
    'flock -w 5 /tmp/l stroq untaint --all',
    'taskset -c 0 stroq untaint --all',
    'unshare --propagation private stroq untaint --all',
    // An option that nothing here knows has a value as likely as not: the program is looked for behind it.
    'pnpx stroq untaint --all',
    'npx --tag next stroq untaint',
    'npx --foo bar stroq untaint',
    'npx -w pkg stroq untaint',
    'npm exec -w pkg stroq untaint',
    'npm -w pkg exec stroq untaint',
    'pnpm -w exec stroq untaint',
    'pnpm -r exec stroq untaint',
    'pnpm recursive exec stroq untaint',
    'pnpm multi exec stroq untaint',
    'pnpm m exec stroq untaint',
    'yarn workspaces foreach -A exec stroq untaint',
    'bunx --bun stroq untaint',
  ])('deny: %s', (command) => expect(stroqStateSignals(command)).toEqual(['stroq-state-change']));

  it.each([
    'stroq doctor',
    'stroq log --json',
    'stroq why',
    'stroq sent --last',
    'stroq replay --last',
    'stroq trust',
    'stroq trust --list',
    'stroq init --dry-run',
    'stroq uninstall --dry-run',
    'npx @stroq/cli doctor',
    'npx stroq why',
    // Asking how a command works is not running it.
    'stroq init --help',
    'stroq untaint -h',
    'npx stroq uninstall --help',
    // Only the command position counts.
    'echo stroq untaint --all',
    'grep "stroq untaint" notes.md',
    // A line of a commit message or a heredoc body is text, not a command.
    'git commit -m "docs: quickstart\n\nstroq init --agent cursor"',
    "git commit -m 'docs\nstroq untaint --all'",
    "cat > NOTES.md <<'EOF'\nRun:\nstroq init\nEOF",
    'cat > NOTES.md <<-EOF\n\tstroq untaint --all\n\tEOF\nls',
    // The same places, with a command that reads or asks, or that is not Stroq.
    '{ stroq doctor; }',
    '(stroq untaint --dry-run)',
    '{ stroq init --help; }',
    '{ echo stroq untaint; }',
    'if stroq doctor; then echo ok; fi',
    'f() { echo "stroq untaint"; }; f',
    'case x in x) echo stroq untaint ;; esac',
    'g() { stroq "$@"; }; g doctor',
    // The wrappers and the runners of the same, with a command that reads or asks, or that is not Stroq.
    'direnv exec . stroq doctor',
    'mise exec -- stroq why',
    'corepack yarn stroq log --json',
    "nix-shell -p hello --run 'hello'",
    'nix develop -c npm test',
    'pnpm --filter pkgname exec stroq doctor',
    'pnpm -C proj exec stroq sent --last',
    'pnpm --filter pkgname test',
    'npx --prefix /opt prettier --check .',
    'npx --registry http://localhost:1 stroq why',
    'npm exec --cache /tmp/c -- tsc --noEmit',
    'yarn workspace pkgname test',
    'yarn --cwd proj build',
    'flock /tmp/l stroq doctor',
    'flock /tmp/l ls',
    'chrt 10 stroq why',
    'strace -f stroq doctor',
    'runuser -u nobody -- stroq doctor',
    "runuser -l nobody -c 'stroq why'",
    'systemd-run --user stroq doctor',
    'sshpass -p secret ssh host ls',
    'uv run pytest -x',
    'conda run -n base python x.py',
    "echo 'flock /tmp/l stroq untaint --all'",
    'npx -y prettier --check .',
    'npx --tag next prettier --check .',
    'npx -y create-vite app',
    'pnpm -r exec tsc --noEmit',
    'pnpm --filter pkgname exec tsc',
    'pnpm exec playwright test',
    'yarn workspaces foreach -A run build',
    'npm exec -w pkg -- tsc',
    'pnpx prettier --check .',
    'bunx --bun prettier .',
    'taskset -c 0 ls',
    // An option written with its value has none to skip: what follows is the program, and it is none of Stroq's.
    'npx --registry=http://localhost:1 cat stroq untaint',
  ])('none (reading, asking, or not Stroq at all): %s', (command) =>
    expect(stroqStateSignals(command)).toEqual([]),
  );

  it('still reads the command after a heredoc ends', () => {
    expect(stroqStateSignals("cat > N.md <<'EOF'\ntext\nEOF\nstroq untaint --all")).toEqual([
      'stroq-state-change',
    ]);
  });
});

// `.devin/hooks.json` is the file Devin Desktop reads first, so a copy, move, link or delete
// that puts a file of the agent's own there silences a project install exactly as editing
// the file would. Each `.devin` command has to be judged the way its `.windsurf` twin is.
describe('the Devin directory is protected as a whole, as the Windsurf one is', () => {
  const twins: readonly (readonly [string, string])[] = [
    ['cp /tmp/hooks.json .devin/', 'cp /tmp/hooks.json .windsurf/'],
    ['mv /tmp/x .devin', 'mv /tmp/x .windsurf'],
    ['install -m 644 /tmp/hooks.json .devin/', 'install -m 644 /tmp/hooks.json .windsurf/'],
    ['rsync -a /tmp/cfg/ .devin/', 'rsync -a /tmp/cfg/ .windsurf/'],
    ['ln -s /tmp/x .devin', 'ln -s /tmp/x .windsurf'],
    ['rm -rf .devin', 'rm -rf .windsurf'],
    ['find .devin -name hooks.json -delete', 'find .windsurf -name hooks.json -delete'],
  ];
  it.each(twins)('%s is not left unclassified', (devin, windsurf) => {
    expect(classifySelfConfigSegment(windsurf)).not.toBeNull();
    expect(classifySelfConfigSegment(devin)).toBe(classifySelfConfigSegment(windsurf));
  });
});

// A third reviewer found, on 2026-10-07, that a message which names a protected file and goes to `>&2`, a read with
// `2>/dev/null`, and every helper function that has one of them in its body were a hard deny: any `>` in a segment
// that names the file was a write to it. A descriptor copied onto another and the null device write no file.
describe('a redirect that writes no file', () => {
  it.each([
    'echo x > f',
    'echo x >> f',
    'echo x &> f',
    'echo x &>> f',
    'echo x >| f',
    'echo x 2> f',
    'echo x >f',
    'echo x 2>&1 > f',
    'echo x >&2 > f',
    'echo x >&2 >f',
    'echo x > /dev/nullx',
    'echo x > /dev/sda',
    'echo x >/dev/null2',
    'awk \'{print > "f"}\'',
    'echo x >& f',
  ])('is a redirect to a file where there is one: %s', (segment) => {
    expect(hasFileRedirect(segment), segment).toBe(true);
  });

  it.each([
    'cat f',
    'cat f 2>&1',
    'cat f >&2',
    'cat f 1>&2',
    'cat f >&-',
    'cat f 2>&-',
    'cat f 2>/dev/null',
    'cat f > /dev/null',
    'cat f >/dev/null 2>&1',
    'cat f &>/dev/null',
    'cat f &> /dev/null',
    'cat f &>> /dev/null',
    'echo hi > /dev/stderr',
    'echo hi >/dev/stdout',
    'echo hi > /dev/tty',
    'echo hi 2>&1 >/dev/null',
    'echo hi >&2 2>/dev/null',
  ])('is none where it copies a descriptor or writes to a device: %s', (segment) => {
    expect(hasFileRedirect(segment), segment).toBe(false);
  });

  const classes = (command: string): readonly string[] =>
    classifyCommand(command, '/home/dev').classes;

  it.each([
    'cat ~/.claude/settings.json 2>/dev/null',
    'cat ~/.claude/settings.json 2>&1',
    'cat ~/.claude/settings.json 2>&1 | head',
    'cat ~/.claude/settings.json > /dev/null',
    '{ cat ~/.claude/settings.json 2>/dev/null; }',
    'cat ~/.stroq/policy.yaml 2>/dev/null',
    'grep -c hooks ~/.claude/settings.json 2>/dev/null',
    'jq . ~/.claude/settings.json 2>&1',
    'echo "error: ~/.claude/settings.json missing" >&2',
    'echo "missing ~/.stroq/policy.yaml" >&2',
    'echo "hook .git/hooks/pre-commit failed" >&2',
    '[ -f ~/.claude/settings.json ] && echo yes >&2',
  ])('does not make a write of a read, or of a message: %s', (command) => {
    expect(classes(command), command).toEqual([]);
  });

  it.each([
    'die() { echo "error: $1" >&2; exit 1; }\ndie "cannot read .claude/settings.json"',
    'show() { cat "$1" 2>/dev/null; }\nshow ~/.claude/settings.json',
    'check() { [ -f "$1" ] || { echo "missing: $1" >&2; return 1; }; }\ncheck ~/.claude/settings.json',
  ])('asks about a helper that is given the file, and does not deny it: %s', (command) => {
    expect(classes(command), command).toEqual(['config.self_touch']);
  });

  it.each([
    'echo x > ~/.claude/settings.json',
    'echo x > ~/.claude/settings.json 2>/dev/null',
    'cat a 2>&1 > .claude/settings.json',
    'echo x >&2 >> ~/.stroq/policy.yaml',
    'echo x 2>/dev/null >> ~/.stroq/policy.yaml',
    'echo x &> ~/.claude/settings.json',
    'echo "[core]" > .git/hooks/pre-commit 2>/dev/null',
    'echo hi >&2; echo x > .claude/settings.json',
    'tee .claude/settings.json < x 2>/dev/null',
    'sed -i s/a/b/ .claude/settings.json 2>&1',
  ])('is still a write where the file is the target of one: %s', (command) => {
    expect(
      classes(command).some((c) => c === 'config.self' || c === 'config.git_exec'),
      command,
    ).toBe(true);
  });
});
