import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { splitCommand } from '../../src/actions/shell-segments.js';

const cwd = '/home/dev/project';
const classes = (command: string) => classifyCommand(command, cwd).classes;

/**
 * A `;` or `|` inside quotes is part of a word, and the shell does not cut there. The plain cut of a
 * command does, and a path that holds one (`'/tmp/a;b/.git/hooks/pre-commit'`) came apart into two
 * segments, none of which held both the write and the file it wrote. The reading that knows the
 * quotes has the command whole; it has to reach the detectors that read a segment.
 */
describe('a separator inside quotes does not hide what a command writes', () => {
  const writes = [
    "echo x > '/tmp/a;b/p/.git/hooks/pre-commit'",
    "echo x > '/tmp/a|b/p/.git/hooks/pre-commit'",
    'echo x > "/tmp/a;b/p/.git/hooks/pre-commit"',
    "cp payload 'a;b/../.git/hooks/pre-commit'",
    "mkdir 'a;b' && cp payload 'a;b/../.git/hooks/pre-commit'",
    "mkdir 'a|b' && cp payload 'a|b/../.git/hooks/pre-commit'",
    "install -m755 payload 'a;b/../.git/hooks/pre-commit'",
    "(cp payload 'a;b/../.git/hooks/pre-commit')",
    "cd repo && echo x > 'a;b/../.git/hooks/post-checkout'",
  ];
  for (const command of writes) {
    it(`finds the git hook written by: ${command}`, () => {
      expect(classes(command)).toContain('config.git_exec');
    });
  }

  it('finds a write to Stroq policy named through a path with a separator', () => {
    expect(classes("echo x > '/home/dev/a;b/../.stroq/policy.yaml'")).toContain('config.self');
  });

  it('is the same answer as for the path without the separator', () => {
    const plain = classes("echo x > '/tmp/ab/p/.git/hooks/pre-commit'");
    expect(plain).toContain('config.git_exec');
    expect(classes("echo x > '/tmp/a;b/p/.git/hooks/pre-commit'")).toEqual(plain);
  });
});

describe('a separator inside quotes is not made into a command of its own', () => {
  const benign = [
    "echo 'a;b' > notes.txt",
    "echo 'a|b' > notes.txt; ls .git/hooks/",
    "grep 'a;b' .git/hooks/pre-commit.sample",
    "ls 'a;b' && cat .git/hooks/pre-commit.sample",
    "git commit -m 'fix: a; b | c'",
    "echo 'x;y' && echo done",
  ];
  for (const command of benign) {
    it(`leaves alone: ${command}`, () => {
      expect(classes(command)).not.toContain('config.git_exec');
      expect(classes(command)).not.toContain('config.self');
    });
  }

  it('keeps the plain cut as well: a command after the separator is still read', () => {
    expect(classes("echo 'a;b'; git config core.hooksPath .evil")).toContain('config.git_exec');
    expect(classes("echo 'a|b' | sh -c 'git config core.fsmonitor /tmp/x'")).toContain(
      'config.git_exec',
    );
  });

  it('does not take a group of commands for one quoted word', () => {
    // The `;` in the group is the shell's own: the write and the read are two commands.
    expect(classes('(echo x > out.txt; ls .git/hooks/)')).not.toContain('config.git_exec');
  });
});

describe('the segments of a command with a separator inside quotes', () => {
  it('hold the quoted word whole, besides the plain cut', () => {
    const command = "echo x > '/tmp/a;b/p/.git/hooks/pre-commit'";
    const { segments } = splitCommand(command);
    expect(segments).toContain(command);
    expect(segments).toContain("echo x > '/tmp/a");
  });

  it('are not changed for a command without one', () => {
    const { segments } = splitCommand("echo x > '/tmp/ab/p/.git/hooks/pre-commit'");
    expect(segments).toEqual([
      "echo x > '/tmp/ab/p/.git/hooks/pre-commit'",
      'echo x > /tmp/ab/p/.git/hooks/pre-commit',
    ]);
  });
});
