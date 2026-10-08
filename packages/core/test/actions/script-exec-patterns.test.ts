import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { classifyReferencedScripts } from '../../src/actions/script-exec.js';
import { cpuNow } from '../cpu-time.js';

let dir = '';

beforeAll(() => {
  // Resolved: on macOS the temp directory is itself reached through a link (/var → /private/var).
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-script-patterns-')));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A shell expands a name before `bash` sees it, so a pattern or a brace expansion in the name of
// a script runs a file that the words of the command do not spell.
describe('a script named by a pattern or a brace expansion is the files it stands for', () => {
  /** A directory of its own, so that one test's files are not another's matches. */
  const room = (files: Readonly<Record<string, string>>): string => {
    const where = mkdtempSync(join(dir, 'glob-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(where, name)), { recursive: true });
      writeFileSync(join(where, name), text);
    }
    return where;
  };
  const classesIn = (where: string, command: string) =>
    classifyTool('Bash', { command }, where).classes;

  it.each([
    'bash x.s?',
    'bash x.s[h]',
    'bash x.s[a-z]',
    'bash x.s[!a]',
    'bash ./x.*',
    'bash *.sh',
    'bash ?.sh',
    'bash {x,y}.sh',
    'bash x{.sh,}',
    'bash x.{sh,bash}',
    'bash -x x.s?',
    'bash -- x.s?',
    'bash -e -o pipefail x.s?',
    'sudo bash x.s?',
    'sh x.s?',
    'zsh x.s?',
    'source x.s?',
    '. ./x.s?',
    'bash ./?/x.sh',
    'bash */x.sh',
    'bash d/*.sh',
    // `$PWD` is a Windows path with backslashes in a POSIX shell's words.
    ...(process.platform === 'win32' ? [] : ['bash $PWD/x.s?']),
    'bash --rcfile x.s? -i',
    'BASH_ENV=x.s? bash -c true',
    "f='x.s?'; bash $f",
    'f=x.s?; bash $f',
    'f={x,y}.sh; bash $f',
  ])('reads the file in %s', (command) => {
    const where = room({ 'x.sh': 'rm -rf ~\n', 'd/x.sh': 'rm -rf ~\n' });
    expect(classesIn(where, command)).toContain('shell.destructive');
  });

  it('does not read what a pattern matches when no shell is told to run it', () => {
    const where = room({ 'tool.sh': '#!/bin/sh\nrm -rf ~\n', 'a.sh': '#!/bin/sh\nrm -rf ~\n' });
    // A program run by its path with a pattern in it is not expanded: most such words are not that.
    expect(classesIn(where, './tool.s?')).not.toContain('shell.destructive');
    // A listing of scripts is not the commands they hold.
    expect(classesIn(where, 'x=$(ls ./*.sh) && echo $x')).toEqual([]);
    expect(classesIn(where, 'ls ./*.sh | head -3')).toEqual([]);
    expect(classesIn(where, 'git add \\\n  ./tool.s? \\\n  ./*.sh')).toEqual([]);
  });

  it('reads every file a pattern stands for, since the shell runs one and hands it the rest', () => {
    const where = room({ 'a.sh': 'echo fine\n', 'b.sh': 'rm -rf ~\n', 'c.sh': 'echo fine\n' });
    expect(classesIn(where, 'bash *.sh')).toContain('shell.destructive');
  });

  it('does not match a hidden file by a wildcard, or a file that is not there', () => {
    const where = room({ '.hidden.sh': 'rm -rf ~\n', 'ok.sh': 'echo fine\n' });
    expect(classesIn(where, 'bash *.sh')).not.toContain('shell.destructive');
    expect(classesIn(where, 'bash .h*.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'bash nothing*.sh')).not.toContain('shell.destructive');
    expect(classesIn(where, 'bash nodir/*.sh')).toEqual([]);
  });

  it('reads a file that is named as it is spelt, whatever pattern characters it holds', () => {
    const where = room({ 'file[1].sh': 'rm -rf ~\n' });
    expect(classesIn(where, "bash 'file[1].sh'")).toContain('shell.destructive');
  });

  it('reads a clean script that a pattern names, and adds nothing', () => {
    const where = room({ 'ok.sh': 'echo fine\n' });
    expect(classesIn(where, 'bash o?.sh')).toEqual([]);
    expect(classesIn(where, 'bash *.sh')).toEqual([]);
  });

  it('asks about a pattern that stands for more scripts than one command reads', () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, n) => [`s${n}.sh`, 'echo fine\n'] as const),
    );
    const found = classifyReferencedScripts(['bash s*.sh'], room(files));
    expect(found?.classes).toContain('shell.unparsed');
    expect(found?.signals).toContain('script-limit');
  });

  it('asks about a recursive pattern and a brace expansion that makes too many names', () => {
    const where = room({ 'x.sh': 'echo fine\n' });
    expect(classesIn(where, 'bash **/x.sh')).toContain('shell.unparsed');
    expect(classesIn(where, `bash ${'{a,b}'.repeat(7)}.sh`)).toContain('shell.unparsed');
  });

  it('leaves alone a name that an expansion this cannot know stands in', () => {
    const where = room({ 'x.sh': 'rm -rf ~\n' });
    expect(classesIn(where, 'bash $(cat name.txt)')).not.toContain('shell.destructive');
    expect(classesIn(where, 'bash "$UNKNOWN"/x.s?')).not.toContain('shell.destructive');
  });

  it('follows a cd that only goes down, and one that goes up and down', () => {
    const where = room({ 'a/b/x.sh': 'rm -rf ~\n', 'c/x.sh': 'echo fine\n' });
    expect(classesIn(where, 'cd a/b && bash x.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'cd a; cd b; bash x.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'cd a/../a/b && bash x.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'cd ./a/./b && bash x.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'cd c && bash x.sh')).not.toContain('shell.destructive');
    expect(classesIn(where, 'cd a/b/.. && bash b/x.sh')).toContain('shell.destructive');
  });

  it('reads a name that a substitution only prints', () => {
    const where = room({ 'x.sh': 'rm -rf ~\n' });
    expect(classesIn(where, 'bash $(echo x.sh)')).toContain('shell.destructive');
    expect(classesIn(where, 'bash `printf x.sh`')).toContain('shell.destructive');
    expect(classesIn(where, 'bash "$(echo x.sh)"')).toContain('shell.destructive');
  });

  it('reads patterns across a whole command in time that does not grow with how many there are', () => {
    const where = room({ 'x.sh': 'echo fine\n' });
    const command = Array.from({ length: 400 }, () => 'bash x.s? *.sh ?.sh').join('; ');
    const started = cpuNow();
    classesIn(where, command);
    expect(cpuNow() - started).toBeLessThan(5000);
  });
});

// The files a pattern lists, and the directories a command is in, are what the shell sees at the
// moment it runs: a name that is not there is not a script, and a `cd` can fail.
describe('what a pattern lists, and where a command is', () => {
  const room = (files: Readonly<Record<string, string>>): string => {
    const where = mkdtempSync(join(dir, 'where-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(where, name)), { recursive: true });
      writeFileSync(join(where, name), text);
    }
    return where;
  };
  const classesIn = (where: string, command: string) =>
    classifyTool('Bash', { command }, where).classes;
  const PAYLOAD = 'rm -rf ~\n';

  it.each([
    'cd nope; bash x.sh',
    'cd nope 2>/dev/null; bash x.sh',
    'cd nope || true; bash x.sh',
    'false && cd d; bash x.sh',
    'if false; then cd d; fi; bash x.sh',
    'cd d | cat; bash x.sh',
    'pushd d; popd; bash x.sh',
    'cd d; cd -; bash x.sh',
    'cd() { :; }; cd /tmp; bash x.sh',
    'for i in 1; do cd d; bash x.sh; done',
  ])(
    'reads the script where the command began as well as where a cd may have left it: %s',
    (command) => {
      const where = room({ 'x.sh': PAYLOAD, 'd/y.sh': 'echo fine\n' });
      expect(classesIn(where, command)).toContain('shell.destructive');
    },
  );

  it('reads the script in the directory a cd that worked leads to', () => {
    const where = room({ 'd/x.sh': PAYLOAD });
    expect(classesIn(where, 'cd d && bash x.sh')).toContain('shell.destructive');
    expect(classesIn(where, '(cd d; bash x.sh)')).toContain('shell.destructive');
  });

  it('reads a script by the directory above a link, as the system follows one', () => {
    const where = room({ 'real/x.sh': PAYLOAD, 'real/sub/keep': '' });
    symlinkSync(join(where, 'real', 'sub'), join(where, 'link'));
    expect(classesIn(where, 'bash link/../x.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'cd link; bash ../x.sh')).toContain('shell.destructive');
  });

  it.each(['bash a?b.sh', 'bash a*b.sh', 'bash a[$]b.sh', "bash 'a$b.sh'", 'bash a\\$b.sh'])(
    'reads a file whose name holds a dollar: %s',
    (command) => {
      const where = room({ 'a$b.sh': PAYLOAD });
      expect(classesIn(where, command)).toContain('shell.destructive');
    },
  );

  // A backtick, an angle bracket and a bar cannot be in the name of a file on Windows.
  const posixNames = process.platform === 'win32' ? it.skip : it;
  posixNames.each(['bash c?d.sh', 'bash e?f.sh', 'bash g?h.sh', 'bash i?j.sh'])(
    'reads a file whose name holds a backtick, an angle bracket or a bar: %s',
    (command) => {
      const where = room({
        'c`d.sh': PAYLOAD,
        'e<f.sh': PAYLOAD,
        'g>h.sh': PAYLOAD,
        'i|j.sh': PAYLOAD,
      });
      expect(classesIn(where, command)).toContain('shell.destructive');
    },
  );

  it('does not ask about a pattern that stands for one file among many directories', () => {
    const files: Record<string, string> = { 'pkg3/build.sh': 'echo fine\n' };
    for (let n = 0; n < 70; n += 1) files[`pkg${n}/keep`] = '';
    const where = room(files);
    expect(classesIn(where, 'bash */build.sh')).toEqual([]);
    expect(classesIn(where, 'bash pkg*/build.sh')).toEqual([]);
  });

  it('reads a brace word that holds a home directory, after the braces are expanded', () => {
    const where = room({ 'x.sh': PAYLOAD });
    expect(classesIn(where, 'bash {$PWD,/nonexistent}/x.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'bash ~+/x.sh')).toContain('shell.destructive');
  });

  it.each([
    'shopt -s dotglob; bash *.sh',
    'shopt -s nocaseglob; bash X.S?',
    'GLOBIGNORE=zzz; bash ?hidden.sh',
    'setopt globdots; bash *.sh',
    'setopt nocaseglob; bash X.S?',
    'bash *.sh(D)',
    'bash ***/x.sh',
    'bash x.s[[.h.]]',
    'bash [[=x=]].sh',
  ])(
    'asks about what an option or a form it does not read could make of a pattern: %s',
    (command) => {
      const where = room({ 'x.sh': 'echo fine\n', '.hidden.sh': PAYLOAD });
      expect(classesIn(where, command)).toContain('shell.unparsed');
    },
  );

  it('reads a zero-padded range as a shell that pads it does', () => {
    const where = room({ 'x01.sh': PAYLOAD });
    expect(classesIn(where, 'bash x{01..02}.sh')).toContain('shell.destructive');
    expect(classesIn(where, 'bash x{001..001}.sh')).not.toContain('shell.destructive');
  });

  it('stays linear in the number of pattern words and in how hostile each is', () => {
    const where = room({ 'x.sh': 'echo fine\n' });
    const hostile = `bash {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}${'[[:'.repeat(60)}.sh`;
    const started = cpuNow();
    classesIn(where, `${hostile}; ${hostile}; ${hostile}; ${hostile}`);
    expect(cpuNow() - started).toBeLessThan(2000);
  });
});
