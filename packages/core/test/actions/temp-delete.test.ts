import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import {
  isNamedTempTarget,
  type LineFacts,
  type TempScope,
} from '../../src/actions/temp-delete.js';

/**
 * Deleting a named path under the system temp directory is routine (`rm -rf /tmp/test_output &&
 * mkdir -p /tmp/test_output`: twenty of them in one public agent benchmark, each a question). What
 * stays a question is every spelling that can reach more than the name says: the folder itself, a
 * glob at its first level, `..`, a trailing slash or `/.` (which follow a link at the name to its
 * target), a variable that is not known, and a link that really leaves the temp directory.
 *
 * Nothing here runs a command. The strings are classified, and the links the tests make are in a
 * folder of their own, made with `mkdtemp`.
 */

const CWD = '/workspace/project';
const classes = (command: string): readonly string[] => classifyCommand(command, CWD).classes;
const asks = (command: string): boolean => classes(command).includes('shell.destructive');

afterEach(() => vi.unstubAllEnvs());

describe('a named path under the temp directory is not destructive', () => {
  it.each([
    'rm -rf /tmp/test_output',
    'rm -rf /tmp/test_output && mkdir -p /tmp/test_output',
    'rm -rf /var/tmp/build-cache',
    'rm -r /tmp/x',
    'rm -fr /tmp/x',
    'rm -Rf /tmp/x',
    'rm --recursive --force /tmp/x',
    'rm -rf -- /tmp/x',
    'rm -rf "/tmp/x"',
    "rm -rf '/tmp/x'",
    'rm -rf /tmp/x /tmp/y',
    'rm -rf /tmp/.hidden-dir',
    'rm -rf /tmp/run-1.2_b+c@d%e,f=g:h',
    'rm -rf /tmp/edge_test_cache\nmkdir -p /tmp/edge_test_cache\ncd /app && python3 run.py',
    'rm -rf /tmp/final_prod1 /tmp/final_prod2 && /opt/hpc_portal/bin/build_evidence.sh /opt/hpc_portal/prod',
    'rm -rf /tmp/smoke_output2 && cd /app/src && python3 run_pipeline.py /data/smoke /tmp/smoke_output2',
    // A name that is a link is removed as a link (no trailing slash), whatever it points to.
    'ln -s ~ /tmp/a && rm -rf /tmp/a',
    'rm -rf /tmp/a/b',
    'rm -rf /tmp/a/b/c',
    'mkdir -p /tmp/a/b && rm -rf /tmp/a/b',
    'echo "" > /tmp/kiosk-test/keyring/revoked.txt && rm -rf /tmp/kiosk-test/cache/*',
  ])('%s', (command) => {
    expect(classes(command)).not.toContain('shell.destructive');
  });
});

describe('what stays a question', () => {
  it.each([
    // The folder itself, and everything at its first level.
    'rm -rf /tmp',
    'rm -rf /var/tmp',
    'rm -rf /tmp/',
    'rm -rf /tmp/*',
    'rm -rf /tmp/.*',
    'rm -rf /tmp/./',
    'rm -rf /tmp/foo*',
    'rm -rf /tmp/f?o',
    'rm -rf /tmp/[ab]',
    'rm -rf /tmp/{a,b}',
    'rm -rf /tmp/{a,../../home}',
    'rm -rf /var/tmp/*',
    'rm -rf /tmp/.*/x',
    // Upward, anywhere.
    'rm -rf /tmp/..',
    'rm -rf /tmp/../home/user',
    'rm -rf /tmp/x/../../home',
    'rm -rf /tmp/a/b/..',
    'rm -rf /tmp/../tmp/x',
    // A trailing slash or a dot follows a link at the name.
    'rm -rf /tmp/x/',
    'rm -rf /tmp/x//',
    'rm -rf /tmp/x/.',
    'rm -rf /tmp/x/./',
    'rm -rf /tmp/a/b/',
    'rm -rf /tmp//x',
    'rm -rf /tmp/x//y',
    // A name the shell expands, splits or escapes.
    'rm -rf /tmp/$X',
    'rm -rf /tmp/${X}',
    'rm -rf /tmp/$(pwd)',
    'rm -rf /tmp/`pwd`',
    'rm -rf /tmp/~',
    'rm -rf /tmp/x*y/z',
    'rm -rf /tmp/a/b*',
    'rm -rf /tmp/a/*/c',
    'rm -rf /tmp/a/.*',
    'rm -rf /tmp/a/**',
    'rm -rf /tmp/a?',
    // A variable stays a variable.
    'rm -rf "$TMPDIR"',
    'rm -rf $TMPDIR',
    'rm -rf ${TMPDIR}',
    'rm -rf $TMPDIR/',
    'rm -rf "$TMPDIR"/',
    'rm -rf $TMP/x',
    'rm -rf $HOME/x',
    'rm -rf ${TMPDIR:-/tmp}/x',
    'rm -rf ${TMPDIR:=/}/home',
    // A path that only looks like one.
    'rm -rf /tmpx/y',
    'rm -rf /tmp.d/y',
    'rm -rf /home/tmp/x',
    'rm -rf /private/etc',
    'rm -rf /Tmp/x',
    // One more option.
    'rm -rf --no-preserve-root /tmp/x',
    'rm --no-preserve-root -r /tmp/x',
    // A target that is not under it, beside one that is.
    'rm -rf /tmp/x ~',
    'rm -rf /tmp/x /home/user',
    'rm -rf /tmp/x /',
    'rm -rf /tmp/x /tmp/*',
    'rm -rf /tmp/x /app/build',
  ])('%s', (command) => {
    expect(asks(command)).toBe(true);
  });

  it.each([
    // The home, the root and the rest keep what they had.
    'rm -rf ~',
    'rm -rf ~/Documents',
    'rm -rf /',
    'rm -rf /app/build',
    'rm -rf /var/spool/dlm/planner',
    'rm -rf /etc',
    'rm -rf /cache',
  ])('%s is unchanged', (command) => {
    expect(asks(command)).toBe(true);
  });

  it('keeps asking for the other deletes of a temp folder: find, xargs, a program that deletes', () => {
    expect(asks('find /tmp/x -delete')).toBe(true);
    expect(asks('find /tmp/x -type f -exec rm -rf {} +')).toBe(true);
    expect(asks('echo /tmp/x | xargs rm -rf')).toBe(true);
  });

  it('is not made safe by the other things the line does when the path is more than one name deep', () => {
    for (const command of [
      'ln -s ~ /tmp/a && rm -rf /tmp/a/Documents',
      'ln -s ~ /tmp/a; rm -rf /tmp/a/Documents',
      'rm -rf /tmp/a/Documents; ln -s ~ /tmp/a',
      'ln -s ~ /tmp/a && rm -rf /tmp/a/*',
      'mv ~ /tmp/a && rm -rf /tmp/a/Documents',
      'tar -xf evil.tar -C /tmp && rm -rf /tmp/a/b',
      'python3 mk.py && rm -rf /tmp/a/b',
      'git clone https://example.invalid/r /tmp/a && rm -rf /tmp/a/b',
      'bash mk.sh && rm -rf /tmp/a/b',
      'cp -s ~/x /tmp/a && rm -rf /tmp/a/b',
      'echo "$(ln -s ~ /tmp/a)" && rm -rf /tmp/a/b',
      'echo `ln -s ~ /tmp/a` && rm -rf /tmp/a/b',
      'rm() { ln -s ~ /tmp/a; command rm "$@"; }; rm -rf /tmp/a/b',
      'alias rm="ln -s ~ /tmp/a; rm"; rm -rf /tmp/a/b',
      'FOO=1; rm -rf /tmp/a/b',
      'export FOO=1; rm -rf /tmp/a/b',
      'for d in x; do ln -s ~ /tmp/a; done; rm -rf /tmp/a/b',
      'ln -s ~ /tmp/a & rm -rf /tmp/a/b',
      'ssh-keygen -q; rm -rf /tmp/a/b',
    ])
      expect(asks(command), command).toBe(true);
  });
});

describe('$TMPDIR', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stroq-temp-delete-'));
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it('is the directory the hook runs in, when that is a temp directory and the line does not set it', () => {
    vi.stubEnv('TMPDIR', tempDir);
    expect(asks('rm -rf $TMPDIR/build')).toBe(false);
    expect(asks('rm -rf "$TMPDIR/build"')).toBe(false);
    expect(asks('rm -rf "${TMPDIR}/build"')).toBe(false);
    expect(asks('rm -rf "$TMPDIR"/build')).toBe(false);
    expect(asks('rm -rf $TMPDIR/build && mkdir -p $TMPDIR/build')).toBe(false);
  });

  it('is the folder itself, or all of it, or more than a name: a question', () => {
    vi.stubEnv('TMPDIR', tempDir);
    for (const command of [
      'rm -rf "$TMPDIR"',
      'rm -rf $TMPDIR',
      'rm -rf $TMPDIR/',
      'rm -rf $TMPDIR/*',
      'rm -rf $TMPDIR/.*',
      'rm -rf $TMPDIR/..',
      'rm -rf $TMPDIR/../x',
      'rm -rf $TMPDIR/x/',
      'rm -rf $TMPDIR/x/.',
      'rm -rf $TMPDIR//x',
      'rm -rf $TMPDIR/$X',
      'rm -rf $TMPDIR/x*',
      'rm -rf $TMPDIR_OTHER/x',
      'rm -rf ${TMPDIR:-/}/x',
    ])
      expect(asks(command), command).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['the root', '/'],
    ['a home directory', '/home/user'],
    ['a relative path', 'tmp'],
    ['a path that goes up', '/tmp/../home/user'],
    ['a glob', '/tmp/*'],
    ['a path with a variable', '/tmp/$X'],
    ['a path with a space', '/tmp/a b'],
    ['a path that is only the prefix of a temp directory', '/tmpx'],
  ])('is not trusted when it is %s', (_name, value) => {
    if (value === undefined) vi.stubEnv('TMPDIR', undefined as unknown as string);
    else vi.stubEnv('TMPDIR', value);
    expect(asks('rm -rf $TMPDIR/build')).toBe(true);
    expect(asks('rm -rf "${TMPDIR}/build"')).toBe(true);
  });

  it('is not trusted once the line sets it, however', () => {
    vi.stubEnv('TMPDIR', tempDir);
    for (const command of [
      'export TMPDIR=/ && rm -rf $TMPDIR/home',
      'TMPDIR=/; rm -rf $TMPDIR/home',
      'TMPDIR=/ rm -rf $TMPDIR/home && true',
      'declare -x TMPDIR=/; rm -rf $TMPDIR/home',
      'read TMPDIR <<< /; rm -rf $TMPDIR/home',
      'printf -v TMPDIR / ; rm -rf $TMPDIR/home',
      'for TMPDIR in /; do rm -rf $TMPDIR/home; done',
      'eval "export TMPDIR=/"; rm -rf $TMPDIR/home',
      'source ./env.sh; rm -rf $TMPDIR/home',
      '. ./env.sh; rm -rf $TMPDIR/home',
      'export "TM""PDIR=/"; rm -rf $TMPDIR/home',
    ])
      expect(asks(command), command).toBe(true);
  });
});

/** What the rest of a line is, as `isNamedTempTarget` is told: all of it inert, and it does not set `TMPDIR`. */
const facts = (inert: boolean, setsTempDir = false): LineFacts => ({
  inert: () => inert,
  setsTempDir: () => setsTempDir,
  probe: () => true,
  scope: () => ({ roots: [], tmpdir: null }),
});

describe('a link that leaves the temp directory', () => {
  // The folder the tests make is the temp directory for them: the line names it by `$TMPDIR`.
  const outside = dirname(fileURLToPath(import.meta.url));
  const scope = mkdtempSync(join(tmpdir(), 'stroq-temp-links-'));
  beforeAll(() => {
    mkdirSync(join(scope, 'plain', 'inner'), { recursive: true });
    symlinkSync(outside, join(scope, 'out'));
    symlinkSync(join(scope, 'plain'), join(scope, 'in'));
    symlinkSync(outside, join(scope, 'plain', 'inner', 'up'));
    symlinkSync(join(outside, 'no-such-folder-here'), join(scope, 'dangling'));
    symlinkSync('/', join(scope, 'root'));
  });
  afterAll(() => rmSync(scope, { recursive: true, force: true }));

  it.each([
    ['a link at the name, to somewhere else', 'rm -rf $TMPDIR/out'],
    ['a link at the name, to the root', 'rm -rf $TMPDIR/root'],
    ['a link above the name', 'rm -rf $TMPDIR/out/child'],
    ['a link above the name, deeper', 'rm -rf $TMPDIR/plain/inner/up/child'],
    ['a link at the end of a path', 'rm -rf $TMPDIR/plain/inner/up'],
    ['a link to a place that is not there, outside', 'rm -rf $TMPDIR/dangling'],
  ])('%s keeps the question', (_name, command) => {
    vi.stubEnv('TMPDIR', scope);
    expect(asks(command), command).toBe(true);
  });

  it.each([
    ['a plain folder', 'rm -rf $TMPDIR/plain'],
    ['a folder in it', 'rm -rf $TMPDIR/plain/inner'],
    ['a name that is not there', 'rm -rf $TMPDIR/missing'],
    ['a name below one that is not there', 'rm -rf $TMPDIR/missing/deeper'],
    ['a link to a folder inside it', 'rm -rf $TMPDIR/in'],
    ['a link to a folder inside it, with a name below', 'rm -rf $TMPDIR/in/inner'],
  ])('%s does not', (_name, command) => {
    vi.stubEnv('TMPDIR', scope);
    expect(asks(command), command).toBe(false);
  });

  it('is judged where the path is, for a root that is given', () => {
    const roots: TempScope = { roots: [scope], tmpdir: null };
    const named = (target: string): boolean => isNamedTempTarget(target, facts(true), CWD, roots);
    expect(named(`${scope}/plain`)).toBe(true);
    expect(named(`${scope}/in/inner`)).toBe(true);
    expect(named(`${scope}/out`)).toBe(false);
    expect(named(`${scope}/out/child`)).toBe(false);
    expect(named(`${scope}/root/etc`)).toBe(false);
    expect(named(scope)).toBe(false);
    expect(named(`${scope}/`)).toBe(false);
  });
});

describe('isNamedTempTarget', () => {
  const system: TempScope = {
    roots: ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'],
    tmpdir: null,
  };
  const named = (target: string, inert = true): boolean =>
    isNamedTempTarget(target, facts(inert), CWD, system);

  it('takes a name, and names below it when nothing else on the line can make a link', () => {
    expect(named('/tmp/x')).toBe(true);
    expect(named('/tmp/x', false)).toBe(true);
    expect(named('/tmp/x/y')).toBe(true);
    expect(named('/tmp/x/y', false)).toBe(false);
    expect(named('/tmp/x/*')).toBe(true);
    expect(named('/tmp/x/*', false)).toBe(false);
  });

  it('takes $TMPDIR only when the scope has one, and the line does not set it', () => {
    const scoped: TempScope = { roots: system.roots, tmpdir: '/var/folders/zz/T' };
    expect(isNamedTempTarget('$TMPDIR/x', facts(true), CWD, scoped)).toBe(true);
    expect(isNamedTempTarget('${TMPDIR}/x', facts(true), CWD, scoped)).toBe(true);
    expect(isNamedTempTarget('$TMPDIR/x', facts(false), CWD, scoped)).toBe(false);
    expect(isNamedTempTarget('$TMPDIR/x', facts(true, true), CWD, scoped)).toBe(false);
    expect(isNamedTempTarget('$TMPDIR/x', facts(true), CWD, system)).toBe(false);
    expect(isNamedTempTarget('$TMPDIR', facts(true), CWD, scoped)).toBe(false);
    expect(isNamedTempTarget('$TMPDIR/', facts(true), CWD, scoped)).toBe(false);
  });

  it('takes the folders that are the same place on a Mac', () => {
    expect(named('/private/tmp/x')).toBe(true);
    expect(named('/private/var/tmp/x')).toBe(true);
  });

  it('does not take a target that is not an absolute path under a temp folder', () => {
    for (const target of [
      '',
      'x',
      './x',
      'tmp/x',
      '/',
      '/tmp',
      '/tmp/',
      '/var',
      '/var/x',
      '/private/tmp',
    ])
      expect(named(target), target).toBe(false);
  });
});
