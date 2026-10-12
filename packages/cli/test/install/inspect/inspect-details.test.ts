import { describe, expect, it } from 'vitest';
import { addressOf } from '../../../src/install/inspect/addresses.js';
import { TALLY_KEYS, tallySpots } from '../../../src/install/inspect/blind-spots.js';
import { hooksOf, MAX_HOOKS } from '../../../src/install/inspect/hook-lines.js';
import { showable } from '../../../src/install/inspect/safe-text.js';
import { ShellQueue } from '../../../src/install/inspect/shell-queue.js';
import { lineOf, linesOf, passportOf, subjectsOf } from '../../helpers/inspect.js';

describe('addressOf', () => {
  it.each([
    ['https://example.com/a/b.tgz?token=abc#frag', 'url', 'example.com', 'example.com/a/b.tgz'],
    ['HTTP://User:Pw@Host.Example:8080/x', 'url', 'host.example', 'host.example/x'],
    ['git+https://github.com/o/r.git#v1', 'git', 'github.com', 'github.com/o/r.git'],
    ['git+ssh://git@github.com/o/r.git', 'git', 'github.com', 'github.com/o/r.git'],
    ['ssh://git@host.example:o/r.git', 'git', 'host.example', 'host.example/o/r.git'],
    ['git@gitlab.example:team/proj.git', 'git', 'gitlab.example', 'gitlab.example/team/proj.git'],
    ['hg+https://hg.example/repo', 'git', 'hg.example', 'hg.example/repo'],
    ['file:../local', 'file', null, 'file:../local'],
    ['./vendor/x', 'file', null, './vendor/x'],
    ['~/pkgs/x', 'file', null, '~/pkgs/x'],
    ['github:owner/repo#main', 'github', null, 'github:owner/repo#main'],
    ['owner/repo', 'github', null, 'owner/repo'],
  ])('reads %s', (spec, kind, host, display) => {
    expect(addressOf(spec)).toEqual({ kind, host, display });
  });

  it.each([
    '',
    '  ',
    '^1.2.3',
    '~1.2',
    'latest',
    '1.x',
    '>=1 <2',
    'npm:other@1',
    'workspace:*',
    '@scope/name',
  ])('does not take %j for an address', (spec) => {
    expect(addressOf(spec)).toBeNull();
  });

  it('says an address it cannot read the host of, without the user information', () => {
    const address = addressOf('git+https://');

    expect(address).toMatchObject({ kind: 'git', host: null });
    const odd = addressOf('https://user:secret@');
    expect(odd?.host).toBeNull();
    expect(odd?.display).not.toContain('secret');
  });
});

describe('hooksOf', () => {
  it('reads groups with a hooks list, and groups that are the hook', () => {
    expect(
      hooksOf({
        Stop: [{ hooks: [{ type: 'command', command: 'a' }] }, { type: 'command', command: 'b' }],
      }),
    ).toEqual([
      { event: 'Stop', command: 'a', type: 'command' },
      { event: 'Stop', command: 'b', type: 'command' },
    ]);
  });

  it.each([
    ['a value that is not an object', 'x'],
    ['an event that is not a list', { Stop: 'x' }],
    ['a group that is not an object', { Stop: ['x'] }],
    ['a hook that is not an object', { Stop: [{ hooks: ['x'] }] }],
  ])('does not read %s', (_what, value) => {
    expect(hooksOf(value)).toBeNull();
  });

  it('stops reading once there are more than it takes', () => {
    const many = {
      Stop: Array.from({ length: MAX_HOOKS * 3 }, () => ({ type: 'command', command: 'x' })),
    };

    expect(hooksOf(many)?.length).toBe(MAX_HOOKS + 1);
  });

  it('says so in the passport when a skill declares more hooks than it reads', () => {
    const hooks = Array.from(
      { length: MAX_HOOKS + 20 },
      (_, i) => `        - type: command\n          command: "echo ${i}"`,
    ).join('\n');
    const passport = passportOf({
      'SKILL.md': `---\nhooks:\n  Stop:\n    - hooks:\n${hooks}\n---\n`,
    });

    expect(subjectsOf(passport, 'hook')).toHaveLength(MAX_HOOKS);
    expect(passport.blindSpots.some((spot) => spot.includes('was cut at the number'))).toBe(true);
  });
});

describe('the words of the blind spots', () => {
  it.each(TALLY_KEYS)('says %s for one and for several, in words and without a name', (key) => {
    const [one] = tallySpots({ [key]: 1 });
    const [several] = tallySpots({ [key]: 3 });

    expect(one).toBeTruthy();
    expect(several).toBeTruthy();
    expect(one).not.toMatch(/undefined|NaN|\[object/);
    expect(several).not.toMatch(/undefined|NaN|\[object/);
  });

  it('says nothing for a count of none', () => {
    expect(tallySpots({})).toEqual([]);
    expect(tallySpots({ gitlink: 0 })).toEqual([]);
  });
});

describe('showable', () => {
  it('cuts a text far longer than it reads, and marks the cut', () => {
    const text = showable('word '.repeat(100_000), 20);

    expect(Array.from(text).length).toBeLessThanOrEqual(20);
    expect(text.endsWith('…')).toBe(true);
  });

  it('makes room for the mark when text of escapes is cut', () => {
    const text = showable('​'.repeat(100), 20);

    expect(Array.from(text).length).toBeLessThanOrEqual(20);
    expect(text).toContain('\\u200b');
    expect(text.endsWith('…')).toBe(true);
  });

  it('counts a character outside the BMP as one and an escape of it by its length', () => {
    expect(showable('\u{1f600}\u{1f600}\u{1f600}', 3)).toBe('\u{1f600}\u{1f600}\u{1f600}');
    expect(showable('\u{e0041}', 20)).toBe('\\u{e0041}');
  });
});

describe('ShellQueue', () => {
  it('lists what it was given by file, then line, then origin, whatever the order it was given in', () => {
    const queue = new ShellQueue();
    queue.add({ file: 'b', line: 1, text: 'x', origin: 'doc' });
    queue.add({ file: 'a', line: 2, text: 'x', origin: 'script' });
    queue.add({ file: 'a', line: 2, text: 'x', origin: 'doc' });
    queue.add({ file: 'a', line: 1, text: 'x', origin: 'hook' });
    queue.add({ file: 'a', line: 3, text: '   ', origin: 'doc' });

    expect(queue.snippets().map((s) => `${s.file}:${s.line}:${s.origin}`)).toEqual([
      'a:1:hook',
      'a:2:doc',
      'a:2:script',
      'b:1:doc',
    ]);
  });
});

describe('Python requirements, in more shapes', () => {
  const flagged = (text: string) =>
    subjectsOf(passportOf({ 'requirements.txt': text }, { kind: 'mcp' }), 'signal');

  it('reads a reference with extras and a name before the at sign', () => {
    expect(flagged('pkg[extra] @ https://files.example/p.whl')).toEqual([
      'non-registry-dependency: pkg (url, files.example/p.whl)',
    ]);
  });

  it('does not flag the index everybody uses, named out loud', () => {
    expect(
      flagged(
        '-i https://pypi.org/simple\n--index-url=https://pypi.org/simple\n--trusted-host files.pythonhosted.org',
      ),
    ).toEqual([]);
  });

  it('flags another index, however it is written', () => {
    expect(flagged('--index-url=https://pypi.internal.example/simple')).toEqual([
      'non-registry-dependency: index (url, pypi.internal.example/simple)',
    ]);
    expect(flagged('-f ./wheels')).toEqual(['non-registry-dependency: index (file, ./wheels)']);
  });

  it('reads an editable local path and a comment after a requirement', () => {
    expect(flagged('-e ./local-pkg  # my copy\nrequests # https://not.read.example')).toEqual([
      'non-registry-dependency: (file, ./local-pkg)',
    ]);
  });

  it('names the egg of a repository requirement', () => {
    expect(flagged('git+https://github.com/o/r.git#egg=thing')).toEqual([
      'non-registry-dependency: thing (git, github.com/o/r.git)',
    ]);
  });

  it('reads a pyproject with a poetry table and an address in a dependency', () => {
    const passport = passportOf(
      {
        'pyproject.toml':
          '[tool.poetry.dependencies]\nfoo = { url = "https://files.example/foo.whl" }\nbar = { git = "https://github.com/o/bar.git" }\n',
      },
      { kind: 'mcp' },
    );

    expect(subjectsOf(passport, 'signal')).toEqual([
      'non-registry-dependency: bar (git, github.com/o/bar.git)',
      'non-registry-dependency: foo (url, files.example/foo.whl)',
    ]);
  });
});

describe('submodules in bulk', () => {
  it('lists a bounded number of them and says the rest were cut', () => {
    const modules = Array.from(
      { length: 250 },
      (_, i) => `[submodule "m${i}"]\n\tpath = m${i}\n\turl = https://host${i}.example/r.git`,
    ).join('\n');
    const passport = passportOf({ '.gitmodules': modules });

    expect(linesOf(passport, 'signal')).toHaveLength(200);
    expect(passport.blindSpots.some((spot) => spot.includes('was cut at the number'))).toBe(true);
    expect(lineOf(passport, 'net', 'host0.example')).toBeDefined();
  });
});
