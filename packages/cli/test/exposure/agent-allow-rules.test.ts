import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { scanFile } from '../../src/exposure/agent-surface.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * An allow rule hands the agent the whole shell when the program it lets run without asking runs
 * whatever it is given: a shell, a wrapper, an interpreter, a package runner, or a pattern that
 * is a wildcard however it is spelled.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const claudeAllows = (rules: readonly string[]): string[] =>
  scanFile('.claude/settings.json', JSON.stringify({ permissions: { allow: rules } }))
    .filter((h) => h.kind === 'agent-broad-allow')
    .map((h) => h.value);

const geminiAllows = (rules: readonly string[]): string[] =>
  scanFile('.gemini/settings.json', JSON.stringify({ tools: { allowed: rules } }))
    .filter((h) => h.kind === 'agent-broad-allow')
    .map((h) => h.value);

const WHOLE = [
  'Bash',
  'Bash(*)',
  'Bash(:*)',
  'Bash(**)',
  'Bash( *)',
  'Bash(* *)',
  'Bash(*:*)',
  'Bash(?*)',
  'Bash(bash:*)',
  'Bash(sh:*)',
  'Bash(/bin/sh:*)',
  'Bash(bash -c:*)',
  'Bash(zsh *)',
  'Bash(env:*)',
  'Bash(sudo:*)',
  'Bash(xargs:*)',
  'Bash(nohup:*)',
  'Bash(timeout:*)',
  'Bash(busybox:*)',
  'Bash(python3:*)',
  'Bash(python:*)',
  'Bash(node:*)',
  'Bash(ruby:*)',
  'Bash(perl:*)',
  'Bash(php:*)',
  'Bash(deno:*)',
  'Bash(bun:*)',
  'Bash(npx:*)',
  'Bash(uvx:*)',
  'Bash(pnpm dlx:*)',
  'Bash(npm exec:*)',
  'Bash(yarn dlx:*)',
  'Bash(b*:*)',
  'bash(*)',
  '*',
  'mcp__*',
  'B*',
  // A package manager or git without a subcommand known to run nothing: the agent writes the
  // script, the package, the hook or the config that subcommand runs.
  'Bash(npm test)',
  'Bash(npm run lint:*)',
  'Bash(npm:*)',
  'Bash(npm -g ls)',
  'Bash(npm l*)',
  'Bash(pnpm install:*)',
  'Bash(cargo run:*)',
  'Bash(go test:*)',
  'Bash(pip install:*)',
  'Bash(uv run:*)',
  'Bash(git:*)',
  'Bash(git commit:*)',
  'Bash(git -c x=y status)',
  // A task runner, a test runner or a tool whose config is code.
  'Bash(make:*)',
  'Bash(just build)',
  'Bash(pytest:*)',
  'Bash(prettier --write:*)',
  // A first word that assigns, expands, or is spelled in pieces.
  'Bash(FOO=1 git status)',
  'Bash($SHELL:*)',
  'Bash(b\\ash:*)',
  'Bash("sh":*)',
  "Bash('ba'sh -c:*)",
  'Bash(C:\\bin\\sh.exe:*)',
  'Bash({bash,x}:*)',
  // A program not known to run nothing: each of these runs, writes or sends what it is given.
  'Bash(find:*)',
  'Bash(sed:*)',
  'Bash(tar:*)',
  'Bash(rsync:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(vim:*)',
  'Bash(vi:*)',
  'Bash(less:*)',
  'Bash(man:*)',
  'Bash(ed:*)',
  'Bash(emacs:*)',
  'Bash(gcc:*)',
  'Bash(cc:*)',
  'Bash(java:*)',
  'Bash(dotnet:*)',
  'Bash(tmux:*)',
  'Bash(screen:*)',
  'Bash(gdb:*)',
  'Bash(lldb:*)',
  'Bash(sqlite3:*)',
  'Bash(psql:*)',
  'Bash(open:*)',
  'Bash(launchctl:*)',
  'Bash(crontab:*)',
  'Bash(kubectl:*)',
  'Bash(terraform:*)',
  'Bash(gh:*)',
  'Bash(curl:*)',
  'Bash(cp:*)',
  'Bash(mv:*)',
  'Bash(tee:*)',
  'Bash(chmod:*)',
  'Bash(ln:*)',
  'Bash(rg:*)',
  'Bash(echo:*)',
  'Bash(tsc --noEmit)',
  'Bash(~/bin/tool:*)',
  'Bash(cargo fmt:*)',
  'Bash(yarn why:*)',
  // Git, where a wildcard or a flag can write a file or run a program the config names.
  'Bash(git log -p)',
  'Bash(git diff --ext-diff)',
  'Bash(git diff --output=x)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git tag:*)',
  'Bash(git stash:*)',
  'Bash(git add:*)',
  'Bash(git grep:*)',
  // A shell operator in the pattern: what follows it is another command, or a file written.
  'Bash(ls > ~/.zshrc)',
  'Bash(git status; id)',
  'Bash(cat x | sh)',
];

/** Grants of files outside the repository, or of the network, without asking. */
const OUTSIDE = [
  'Write(~/.zshrc)',
  'Edit(//Users/**)',
  'Read(~/.ssh/**)',
  'Read(//etc/**)',
  'Read(../secrets/**)',
  'Edit(src/../../x)',
  'Edit',
  'Write',
  'MultiEdit',
  'WebFetch',
  'WebFetch(domain:*)',
  'WebFetch(https://evil.invalid)',
  'WebSearch',
];

describe('a Claude Code allow rule that hands the agent the whole shell', () => {
  it.each(WHOLE)('reports %j', (rule) => {
    expect(claudeAllows([rule])).toEqual([rule]);
  });

  it.each(OUTSIDE)('reports %j', (rule) => {
    expect(claudeAllows([rule])).toEqual([rule]);
  });

  it.each([
    'Bash(npm ls)',
    'Bash(npm view:*)',
    'Bash(git status:*)',
    'Bash(git log --oneline)',
    'Bash(git diff --stat)',
    'Bash(ls:*)',
    'Bash(cat:*)',
    'Bash(grep:*)',
    'Bash(echo done)',
    'Read',
    'Grep',
    'Edit(*)',
    'Read(src/**)',
    'Write(/docs/**)',
    'WebFetch(domain:example.com)',
    'mcp__docs__search',
  ])('leaves %j alone', (rule) => {
    expect(claudeAllows([rule])).toEqual([]);
  });

  it('reports a folder outside the repository the agent is given, and a mode that asks less', () => {
    const hits = scanFile(
      '.claude/settings.json',
      JSON.stringify({
        permissions: {
          additionalDirectories: ['~', '/', '../other', 'packages/app'],
          defaultMode: 'acceptEdits',
        },
      }),
    );
    expect(hits.map((h) => `${h.kind} ${h.name} ${h.value}`)).toEqual([
      'agent-broad-allow permissions.additionalDirectories ~',
      'agent-broad-allow permissions.additionalDirectories /',
      'agent-broad-allow permissions.additionalDirectories ../other',
      'agent-permission-bypass permissions.defaultMode acceptEdits',
    ]);
    for (const mode of ['default', 'plan', 'dontAsk'])
      expect(
        scanFile('.claude/settings.json', JSON.stringify({ permissions: { defaultMode: mode } })),
      ).toEqual([]);
  });

  it('fails a new one in a change', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, {
      '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(bash:*)'] } }),
    });
    expect(
      agentChanges(dir, base)
        .hits.filter((h) => isFailing(h, 'new'))
        .map((h) => `${h.status} ${h.kind} ${h.value}`),
    ).toEqual(['new agent-broad-allow Bash(bash:*)']);
  });
});

describe('a long list of allow rules', () => {
  it('lists the first 200 that hand over the shell, and fails for the rest', () => {
    const rules = Array.from({ length: 250 }, (_, i) => `Bash(bash ./s${i}.sh)`);
    const hits = scanFile(
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: rules } }),
    );
    expect(hits.filter((h) => h.kind === 'agent-broad-allow')).toHaveLength(200);
    expect(hits.filter((h) => h.kind === 'unreadable-config').map((h) => h.name)).toEqual([
      'too many broad allow rules',
    ]);
    const shell = rules.map((r) => r.replace('Bash(', 'run_shell_command('));
    const gemini = scanFile('.gemini/settings.json', JSON.stringify({ tools: { allowed: shell } }));
    expect(gemini.filter((h) => h.kind === 'unreadable-config').map((h) => h.name)).toEqual([
      'too many broad allow rules',
    ]);
  });
});

describe('a Gemini or Qwen allow rule that hands the agent the whole shell', () => {
  it.each([
    'run_shell_command',
    'run_shell_command()',
    'run_shell_command(*)',
    'run_shell_command(bash)',
    'run_shell_command(sh)',
    'run_shell_command(python3)',
    'run_shell_command(env)',
    'ShellTool(npx)',
  ])('reports %j', (rule) => {
    expect(geminiAllows([rule])).toEqual([rule]);
  });

  it.each(['run_shell_command(git status)', 'read_file', 'run_shell_command(ls)'])(
    'leaves %j alone',
    (rule) => {
      expect(geminiAllows([rule])).toEqual([]);
    },
  );
});
