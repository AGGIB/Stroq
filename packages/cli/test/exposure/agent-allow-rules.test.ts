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
];

describe('a Claude Code allow rule that hands the agent the whole shell', () => {
  it.each(WHOLE)('reports %j', (rule) => {
    expect(claudeAllows([rule])).toEqual([rule]);
  });

  it.each([
    'Bash(npm ls)',
    'Bash(npm view:*)',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(cargo fmt:*)',
    'Bash(tsc --noEmit)',
    'Bash(~/bin/tool:*)',
    'Bash(ls:*)',
    'Read',
    'Edit(*)',
    'WebFetch(domain:example.com)',
    'mcp__docs__search',
  ])('leaves %j alone', (rule) => {
    expect(claudeAllows([rule])).toEqual([]);
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
