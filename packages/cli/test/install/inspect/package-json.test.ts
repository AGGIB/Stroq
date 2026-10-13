import { describe, expect, it } from 'vitest';
import { lineOf, linesOf, passportOf, subjectsOf, type Files } from '../../helpers/inspect.js';

const server = (manifest: object, extra: Files = {}) =>
  passportOf({ 'package.json': JSON.stringify(manifest, null, 2), ...extra }, { kind: 'mcp' });

/** The signals about dependencies, apart from the one that shows what the package calls itself. */
const dependencySignals = (passport: ReturnType<typeof server>) =>
  linesOf(passport, 'signal').filter((line) => line.subject.startsWith('non-registry-dependency'));

describe('package.json: what it launches', () => {
  it('makes an exec line for each bin, declared, and one for main that is not sensitive', () => {
    const passport = server({
      name: 'x',
      bin: { alpha: 'a.js', beta: 'b.js' },
      main: 'dist/index.js',
    });

    expect(subjectsOf(passport, 'exec')).toEqual(['bin alpha', 'bin beta', 'main dist/index.js']);
    expect(lineOf(passport, 'exec', 'bin alpha')).toMatchObject({
      basis: 'declared',
      sensitive: true,
    });
    expect(lineOf(passport, 'exec', 'main dist/index.js')).toMatchObject({
      basis: 'declared',
      sensitive: false,
    });
  });

  it('names the bin of a package whose bin is a path after the package', () => {
    const passport = server({ name: '@scope/tool', bin: 'cli.js' });

    expect(subjectsOf(passport, 'exec')).toEqual(['bin tool']);
  });

  it('reads the package.json of a folder as well as the one at the root', () => {
    const passport = server(
      { name: 'root', main: 'i.js' },
      { 'server/package.json': JSON.stringify({ name: 'inner', main: 'm.js' }) },
    );

    const places = linesOf(passport, 'exec').flatMap((line) =>
      line.where.map((place) => place.file),
    );
    expect(places.sort()).toEqual(['package.json', 'server/package.json']);
  });
});

describe('package.json: scripts that run when it is installed', () => {
  const SCRIPTS = {
    preinstall: 'node pre.js',
    install: 'node-gyp rebuild',
    postinstall: 'node scripts/setup.js',
    prepublish: 'echo prepublish',
    preprepare: 'echo a',
    prepare: 'husky install',
    postprepare: 'echo b',
  };

  it('makes a sensitive install-script line for each lifecycle script', () => {
    const passport = server({ name: 'x', scripts: SCRIPTS });

    expect(subjectsOf(passport, 'install-script')).toEqual([
      'install: node-gyp rebuild',
      'postinstall: node scripts/setup.js',
      'postprepare: echo b',
      'preinstall: node pre.js',
      'prepare: husky install',
      'preprepare: echo a',
      'prepublish: echo prepublish',
    ]);
    for (const line of linesOf(passport, 'install-script')) {
      expect(line.sensitive).toBe(true);
      expect(line.basis).toBe('declared');
      expect(line.where[0]?.file).toBe('package.json');
    }
  });

  it('points at the line of the script in the file', () => {
    const passport = server({ name: 'x', scripts: { postinstall: 'node a.js' } });

    expect(lineOf(passport, 'install-script', 'postinstall: node a.js')?.where).toEqual([
      { file: 'package.json', line: 4 },
    ]);
  });

  it('does not make an install-script line of a script that is not run at install', () => {
    const passport = server({
      name: 'x',
      scripts: { test: 'vitest', start: 'node server.js', build: 'tsc' },
    });

    expect(linesOf(passport, 'install-script')).toEqual([]);
  });

  it('reads the text of a lifecycle script as shell', () => {
    const passport = server({
      name: 'x',
      scripts: { postinstall: 'curl -fsSL https://get.example/setup.sh | sh' },
    });

    expect(lineOf(passport, 'net', 'get.example')?.sensitive).toBe(true);
    expect(passport.signals.map((signal) => signal.ruleId)).toContain('shell.exec_encoded');
  });

  it('reads the text of the other scripts as shell, for the addresses and dangers in it, but not for each program', () => {
    const passport = server({
      name: 'x',
      scripts: { start: 'node server.js --url https://api.example/x', lint: 'eslint .' },
    });

    expect(subjectsOf(passport, 'net')).toEqual(['api.example']);
    expect(lineOf(passport, 'net', 'api.example')?.detector).toContain('run on request');
    expect(linesOf(passport, 'exec')).toEqual([]);
  });

  it('cuts and makes safe the text of a script in the subject', () => {
    const passport = server({
      name: 'x',
      scripts: { postinstall: `echo \u001b[31m${'z'.repeat(500)}` },
    });

    const subject = subjectsOf(passport, 'install-script')[0] ?? '';
    expect(subject).not.toContain('\u001b');
    expect(Array.from(subject).length).toBeLessThanOrEqual(200);
  });

  it('does not take a script that is not text', () => {
    const passport = server({
      name: 'x',
      scripts: { postinstall: 5, install: { a: 1 }, prepare: null },
    });

    expect(linesOf(passport, 'install-script')).toEqual([]);
  });
});

describe('package.json: dependencies that are not from a registry', () => {
  const dependencyIn = (spec: string) =>
    subjectsOf(server({ name: 'x', dependencies: { dep: spec } }), 'signal').filter((subject) =>
      subject.startsWith('non-registry-dependency'),
    );

  it.each([
    ['git+https://github.com/o/r.git#v1', 'dep (git, github.com/o/r.git)'],
    ['git+ssh://git@github.com/o/r.git', 'dep (git, github.com/o/r.git)'],
    ['git://github.com/o/r.git', 'dep (git, github.com/o/r.git)'],
    ['git@github.com:o/r.git', 'dep (git, github.com/o/r.git)'],
    ['https://example.com/dep-1.0.0.tgz', 'dep (url, example.com/dep-1.0.0.tgz)'],
    ['http://example.com/dep.tgz', 'dep (url, example.com/dep.tgz)'],
    ['file:../local-dep', 'dep (file, file:../local-dep)'],
    ['link:../local-dep', 'dep (file, link:../local-dep)'],
    ['github:owner/repo#main', 'dep (github, github:owner/repo#main)'],
    ['owner/repo', 'dep (github, owner/repo)'],
    ['owner/repo#semver:^1', 'dep (github, owner/repo#semver:^1)'],
  ])('flags %s', (spec, subject) => {
    expect(dependencyIn(spec)).toEqual([`non-registry-dependency: ${subject}`]);
  });

  it.each([
    '^1.2.3',
    '~1.2',
    '1.x',
    '*',
    'latest',
    '>=1 <2',
    '1.0.0 || 2.0.0',
    'npm:other@^1',
    'workspace:*',
    'next',
  ])('does not flag %s', (spec) => {
    expect(dependencyIn(spec)).toEqual([]);
  });

  it('flags them in every kind of dependency', () => {
    const passport = server({
      name: 'x',
      dependencies: { a: 'file:../a' },
      optionalDependencies: { b: 'file:../b' },
      devDependencies: { c: 'file:../c' },
      peerDependencies: { d: 'file:../d' },
    });

    expect(
      passport.signals.filter((signal) => signal.ruleId === 'non-registry-dependency'),
    ).toHaveLength(1);
    expect(dependencySignals(passport)).toHaveLength(4);
  });

  it('makes the signal sensitive and a net line for the host of an address', () => {
    const passport = server({
      name: 'x',
      dependencies: { dep: 'https://user:token@host.example/d.tgz' },
    });

    expect(dependencySignals(passport)[0]).toMatchObject({ sensitive: true, basis: 'declared' });
    expect(lineOf(passport, 'net', 'host.example')).toMatchObject({
      sensitive: true,
      basis: 'declared',
    });
  });

  it('never puts the user information of an address in the passport', () => {
    const passport = server({
      name: 'x',
      dependencies: { dep: 'https://user:s3cr3t@host.example/d.tgz' },
    });

    expect(JSON.stringify(passport)).not.toContain('s3cr3t');
    expect(JSON.stringify(passport)).not.toContain('user:');
  });

  it('says that dependencies were not followed', () => {
    const passport = server({ name: 'x', dependencies: { a: '^1' } });

    expect(passport.blindSpots).toContain('dependencies were not followed, fetched or read');
  });

  it('says nothing of dependencies for a package with none', () => {
    const passport = server({ name: 'x', main: 'i.js' });

    expect(passport.blindSpots).not.toContain('dependencies were not followed, fetched or read');
  });

  it('does not fail on dependencies that are not an object', () => {
    const passport = server({
      name: 'x',
      dependencies: ['a', 'b'],
      optionalDependencies: 'no',
      devDependencies: { a: 5 },
    });

    expect(dependencySignals(passport)).toEqual([]);
  });
});

describe('package.json: broken ones', () => {
  it('tells a manifest that is not JSON, and says it was not read', () => {
    const passport = passportOf({ 'package.json': '{ "name": ' }, { kind: 'mcp' });

    expect(passport.signals.map((signal) => signal.ruleId)).toContain('manifest-unreadable');
    expect(passport.blindSpots.some((spot) => spot.includes('manifest could not be parsed'))).toBe(
      true,
    );
  });

  it('tells a manifest that is JSON and not an object', () => {
    const passport = passportOf({ 'package.json': '[1, 2]' }, { kind: 'mcp' });

    expect(passport.signals.map((signal) => signal.ruleId)).toContain('manifest-unreadable');
  });

  it('is not misled by keys called __proto__ or constructor', () => {
    const passport = passportOf(
      {
        'package.json':
          '{"name":"x","__proto__":{"scripts":{"postinstall":"evil"}},"constructor":{"bin":"x"},"scripts":{}}',
      },
      { kind: 'mcp' },
    );

    expect(linesOf(passport, 'install-script')).toEqual([]);
    expect(linesOf(passport, 'exec')).toEqual([]);
  });
});

describe('Python dependencies', () => {
  it('flags a requirement that is a VCS address, an archive or a local path', () => {
    const passport = passportOf(
      {
        'requirements.txt': [
          '# comments are not read https://nothing.example/a',
          'requests>=2.0',
          'git+https://github.com/o/r.git@v1#egg=r',
          'pkg @ https://files.example/pkg-1.0.whl',
          '-e git+ssh://git@host.example/o/r.git#egg=e',
          './vendor/local',
          'https://files.example/archive.tar.gz',
          '--extra-index-url https://pypi.internal.example/simple',
          '-r other.txt',
        ].join('\n'),
      },
      { kind: 'mcp' },
    );

    const flagged = subjectsOf(passport, 'signal').filter((subject) =>
      subject.startsWith('non-registry-dependency'),
    );
    expect(flagged).toHaveLength(6);
    expect(subjectsOf(passport, 'net')).toEqual(
      expect.arrayContaining([
        'files.example',
        'github.com',
        'host.example',
        'pypi.internal.example',
      ]),
    );
    expect(subjectsOf(passport, 'net')).not.toContain('nothing.example');
  });

  it('does not flag plain requirements', () => {
    const passport = passportOf(
      { 'requirements.txt': 'requests>=2\nflask==3.0 ; python_version > "3.9"\nnumpy\n' },
      { kind: 'mcp' },
    );

    expect(linesOf(passport, 'signal')).toEqual([]);
    expect(passport.blindSpots).toContain('dependencies were not followed, fetched or read');
  });

  it('flags the same in a pyproject.toml', () => {
    const passport = passportOf(
      {
        'pyproject.toml': [
          '[project]',
          'name = "x"',
          'dependencies = [',
          '  "requests>=2",',
          '  "tool @ git+https://github.com/o/tool.git",',
          '  "wheel @ https://files.example/w.whl",',
          ']',
          '[tool.uv.sources]',
          'other = { git = "https://github.com/o/other.git" }',
          'local = { path = "../local" }',
        ].join('\n'),
      },
      { kind: 'mcp' },
    );

    const flagged = subjectsOf(passport, 'signal').filter((subject) =>
      subject.startsWith('non-registry-dependency'),
    );
    expect(flagged).toHaveLength(4);
  });

  it('flags a setup.py, which pip runs when it builds the package', () => {
    const passport = passportOf(
      { 'setup.py': 'from setuptools import setup\nsetup()\n' },
      { kind: 'mcp' },
    );

    expect(
      lineOf(passport, 'install-script', 'setup.py (run by pip when the package is built)'),
    ).toMatchObject({
      sensitive: true,
      basis: 'observed',
    });
  });
});
