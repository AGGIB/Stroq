import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonObject, writeJsonObject } from '../../src/commands/config-file.js';

let home = '';
let project = '';

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-cfg-home-')));
  project = join(home, 'code', 'repo');
  mkdirSync(project, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  process.env['HOME'] = home;
});

afterEach(() => vi.restoreAllMocks());

describe('writeJsonObject in a repository someone else wrote', () => {
  // A cloned repository chooses what `.claude/settings.json` is. Made a symlink to a
  // file elsewhere, `stroq init` merged its hooks into that file — a write outside
  // the project, into a file the repository's author picked.
  it('refuses to write through a project symlink that leaves the project', () => {
    const victim = join(home, '.config', 'tool.json');
    mkdirSync(join(home, '.config'), { recursive: true });
    writeFileSync(victim, '{"keep":"me"}\n');
    mkdirSync(join(project, '.claude'), { recursive: true });
    symlinkSync(victim, join(project, '.claude', 'settings.json'));
    expect(() => writeJsonObject(join(project, '.claude', 'settings.json'), { hooks: {} })).toThrow(
      /outside/,
    );
    expect(readFileSync(victim, 'utf8')).toBe('{"keep":"me"}\n');
  });

  it('refuses when the config directory itself is the symlink', () => {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(project, '.cursor'));
    expect(() => writeJsonObject(join(project, '.cursor', 'hooks.json'), {})).toThrow(/outside/);
  });

  it('writes an ordinary project file as before', () => {
    const file = join(project, '.claude', 'settings.json');
    writeJsonObject(file, { a: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
  });

  // Dotfile managers such as stow make `~/.claude/settings.json` a link into
  // `~/dotfiles`. That is the user's own home pointing at the user's own home.
  it('still writes a user-scope file that links elsewhere inside the home directory', () => {
    const real = join(home, 'dotfiles', 'claude', 'settings.json');
    mkdirSync(join(home, 'dotfiles', 'claude'), { recursive: true });
    writeFileSync(real, '{}\n');
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(real, join(home, '.claude', 'settings.json'));
    vi.spyOn(process, 'cwd').mockReturnValue(join(home, 'somewhere-else'));
    writeJsonObject(join(home, '.claude', 'settings.json'), { b: 2 });
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ b: 2 });
  });
});

describe('readJsonObject', () => {
  // The same symlink pointed at `~/.npmrc` made the parse error quote the start of
  // the credential file, onto the screen and, when an agent ran `init`, to its model.
  it('never quotes the file it could not parse', () => {
    const file = join(project, 'bad.json');
    writeFileSync(file, '//registry.npmjs.org/:_authToken=npm_SECRETSECRET\n');
    let message = '';
    try {
      readJsonObject(file);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('cannot parse');
    expect(message).not.toContain('registry');
    expect(message).not.toContain('npm_');
  });

  // A repository can commit `.claude/settings.json` as a symlink to `/dev/zero`, and
  // `doctor`, `init` and `exposure` then read an endless stream until memory ran out.
  it('refuses a config that is not a regular file instead of reading it forever', () => {
    const file = join(project, 'zero.json');
    symlinkSync('/dev/zero', file);
    expect(() => readJsonObject(file)).toThrow(/not a regular file/);
  });

  it('refuses a config too large to be a real one', () => {
    const file = join(project, 'huge.json');
    writeFileSync(file, `{"a":"${'x'.repeat(5 * 1024 * 1024)}"}`);
    expect(() => readJsonObject(file)).toThrow(/too large/);
  });
});
