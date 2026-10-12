import { describe, expect, it } from 'vitest';
import { lineOf, linesOf, passportOf, subjectsOf } from '../../helpers/inspect.js';

const signalsOf = (passport: ReturnType<typeof passportOf>) =>
  subjectsOf(passport, 'signal').filter((subject) => !subject.startsWith('shell.'));

describe('tree checks: files that run on their own', () => {
  it('flags a dev container that runs a command, with the commands it names', () => {
    const passport = passportOf({
      '.devcontainer/devcontainer.json':
        '{\n  // comment\n  "image": "node:22",\n  "postCreateCommand": "npm ci",\n  "initializeCommand": "echo hi"\n}\n',
    });

    expect(
      lineOf(passport, 'signal', 'devcontainer: initializeCommand, postCreateCommand'),
    ).toMatchObject({
      sensitive: true,
      basis: 'declared',
    });
    expect(
      lineOf(passport, 'signal', 'devcontainer: initializeCommand, postCreateCommand')?.detector,
    ).toContain('on the machine that opens it');
  });

  it('flags a dev container that runs nothing without making it sensitive', () => {
    const passport = passportOf({ '.devcontainer/devcontainer.json': '{"image": "node:22"}' });

    expect(lineOf(passport, 'signal', 'devcontainer')).toMatchObject({ sensitive: false });
  });

  it('flags the file of a dev container in the root, and the other files of its folder', () => {
    const passport = passportOf({
      '.devcontainer.json': '{"onCreateCommand": "make"}',
      '.devcontainer/Dockerfile': 'FROM node:22\nRUN make\n',
    });

    expect(
      passport.signals
        .filter((signal) => signal.ruleId === 'devcontainer')
        .map((signal) => signal.file),
    ).toEqual(['.devcontainer.json', '.devcontainer/Dockerfile']);
  });

  it('flags a husky hook, and not the helper folder or a dot file in it', () => {
    const passport = passportOf({
      '.husky/pre-commit': 'npm test\n',
      '.husky/_/helper': 'x\n',
      '.husky/.gitignore': '_\n',
    });

    expect(
      passport.signals
        .filter((signal) => signal.ruleId === 'husky-hook')
        .map((signal) => signal.file),
    ).toEqual(['.husky/pre-commit']);
    expect(lineOf(passport, 'signal', 'husky-hook: pre-commit')?.sensitive).toBe(true);
  });

  it('flags an .envrc, which direnv runs when a person enters the folder', () => {
    const passport = passportOf({ '.envrc': 'export A=1\n' });

    expect(lineOf(passport, 'signal', 'envrc')).toMatchObject({
      sensitive: true,
      where: [{ file: '.envrc', line: null }],
    });
  });

  it.each([
    ['.vscode/tasks.json', '{"tasks":[{"label":"x","runOptions":{"runOn":"folderOpen"}}]}'],
    ['.vscode/settings.json', '{"task.allowAutomaticTasks": "on"}'],
    ['my.code-workspace', '{"tasks":{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}}'],
  ])('flags %s that runs a task when the folder is opened', (path, text) => {
    const passport = passportOf({ [path]: text });

    expect(passport.signals).toContainEqual({ ruleId: 'editor-autorun', file: path });
    expect(lineOf(passport, 'signal', 'editor-autorun')?.sensitive).toBe(true);
  });

  it('does not flag editor files that run nothing on their own', () => {
    const passport = passportOf({
      '.vscode/tasks.json': '{"tasks":[{"label":"build"}]}',
      'config/tasks.json': '{"runOptions":{"runOn":"folderOpen"}}',
    });

    expect(passport.signals).toEqual([]);
  });
});

describe('tree checks: git files', () => {
  it('makes a net line of the host of a submodule, and a signal', () => {
    const passport = passportOf({
      '.gitmodules':
        '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://github.com/owner/lib.git\n[submodule "tools"]\n\tpath = tools\n\turl = git@gitlab.example:team/tools.git\n[submodule "rel"]\n\tpath = rel\n\turl = ../rel.git\n',
    });

    expect(subjectsOf(passport, 'net')).toEqual(['github.com', 'gitlab.example']);
    expect(lineOf(passport, 'net', 'github.com')).toMatchObject({
      basis: 'declared',
      sensitive: true,
    });
    expect(signalsOf(passport)).toEqual([
      'submodule: rel (../rel.git)',
      'submodule: tools (gitlab.example/team/tools.git)',
      'submodule: vendor/lib (github.com/owner/lib.git)',
    ]);
  });

  it('flags a driver named in .gitattributes without making it sensitive', () => {
    const passport = passportOf({
      '.gitattributes': '* text=auto\n*.bin filter=secrets diff=secrets\n',
    });

    expect(signalsOf(passport)).toEqual([
      'gitattributes-driver: diff.secrets',
      'gitattributes-driver: filter.secrets',
    ]);
    expect(linesOf(passport, 'signal').every((line) => !line.sensitive)).toBe(true);
  });

  it('flags a nested repository, and says it was not opened', () => {
    const passport = passportOf({ 'SKILL.md': '# s\n', 'vendor/sub': { gitlink: true } });

    expect(lineOf(passport, 'signal', 'gitlink')).toMatchObject({
      sensitive: true,
      where: [{ file: 'vendor/sub', line: null }],
    });
    expect(
      passport.blindSpots.some((spot) =>
        spot.startsWith('1 nested repository (a gitlink) was recorded and not opened'),
      ),
    ).toBe(true);
  });

  it('flags a Git LFS pointer, whose content is not in the tree, on the basis unknown', () => {
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a2146\nsize 12345\n';
    const passport = passportOf({
      'models/big.bin': pointer,
      'notes.txt': 'version https://example.com\n',
    });

    expect(passport.signals).toEqual([{ ruleId: 'lfs-pointer', file: 'models/big.bin' }]);
    const line = linesOf(passport, 'signal')[0];
    expect(line).toMatchObject({ basis: 'unknown', sensitive: true });
    expect(line?.subject).toContain('its content is stored elsewhere');
    expect(
      passport.blindSpots.some((spot) => spot.startsWith('1 Git LFS pointer file stands')),
    ).toBe(true);
  });
});

describe('tree checks: links and executables', () => {
  it('flags a link inside the tree without making it sensitive, and says links are not followed', () => {
    const passport = passportOf({
      'a.md': 'a',
      'docs/b.md': { symlink: '../a.md' },
      'c.md': { symlink: 'a.md' },
    });

    expect(signalsOf(passport)).toEqual(['symlink: c.md -> a.md', 'symlink: docs/b.md -> ../a.md']);
    expect(linesOf(passport, 'signal').every((line) => !line.sensitive)).toBe(true);
    expect(passport.blindSpots).toContain('2 symbolic links were recorded and not followed');
  });

  it.each([
    '/etc/passwd',
    '../../outside',
    '../../x',
    '~/.ssh/id_rsa',
    'C:/Windows/win.ini',
    '\\\\server\\share',
    'a/../../../up',
  ])('flags a link to %s as one that leaves the tree', (target) => {
    const passport = passportOf({ 'dir/link': { symlink: target } });

    expect(linesOf(passport, 'signal')[0]).toMatchObject({ sensitive: true });
    expect(linesOf(passport, 'signal')[0]?.subject).toContain('outside the tree');
  });

  it('flags a link that climbs and comes back as inside the tree', () => {
    const passport = passportOf({ 'a/b/link': { symlink: '../../a/b/file' } });

    expect(linesOf(passport, 'signal')[0]?.sensitive).toBe(false);
  });

  it('flags an executable that is not in a bin or scripts folder', () => {
    const passport = passportOf({
      'lib/helper': { text: 'x', exec: true },
      'bin/tool': { text: 'x', exec: true },
      'scripts/run': { text: 'x', exec: true },
      'pkg/bin/other': { text: 'x', exec: true },
      'lib/plain': 'x',
    });

    expect(signalsOf(passport)).toEqual(['executable-file: lib/helper']);
    expect(linesOf(passport, 'signal')[0]?.sensitive).toBe(true);
  });
});
