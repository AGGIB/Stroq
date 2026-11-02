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
    'rm -rf /var/folders/zz/abc_123/T/build',
    'rm -rf /private/var/folders/zz/abc_123/T/build',
    'rm -rf /var/folders/n6/cmcn057lg8_xqwf82jfnbr0000gn/T/test_output',
    'rm -rf /var/folders/zz/abc_123/T/a/b',
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
    'rm -rf /var/folders/zz/abc_123/C/build',
    'rm -rf /var/folders/zz/abc_123/T',
    'rm -rf /var/folders/zz/abc_123/T/',
    'rm -rf /var/folders/zz/abc_123/T/*',
    'rm -rf /var/folders/zz/abc_123/T/../C/x',
    'rm -rf /var/folders/zz/abc_123',
    'rm -rf /var/folders',
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

/**
 * A project that is itself under a temp directory (CI, a `mktemp` sandbox, `/private/tmp`): the delete of a
 * name under it can be the project, a folder above it, or the folder beside it. The exemption is off
 * wherever the directory the hook gives is inside scratch space.
 */
describe('a project under the temp directory', () => {
  const asksIn = (command: string, cwd: string): boolean =>
    classifyCommand(command, cwd).classes.includes('shell.destructive');

  it.each([
    ['/tmp/work/proj', 'rm -rf /tmp/work/proj'],
    ['/tmp/work/proj', 'rm -rf /tmp/work'],
    ['/tmp/work/proj', 'rm -rf /tmp/work/other'],
    ['/tmp/work/proj', 'rm -rf /tmp/work/*'],
    ['/tmp/work/proj', 'rm -rf /tmp/test_output'],
    ['/tmp/work/proj', 'rm -rf /var/tmp/test_output'],
    ['/tmp/work', 'rm -rf /tmp/work'],
    ['/var/tmp/work/proj', 'rm -rf /var/tmp/work/proj'],
    ['/var/tmp/work/proj', 'rm -rf /var/tmp/work'],
    ['/private/tmp/work/proj', 'rm -rf /private/tmp/work/proj'],
    ['/private/tmp/work/proj', 'rm -rf /tmp/work/proj'],
    ['/private/tmp/work/proj', 'rm -rf /private/tmp/work'],
    ['/private/var/tmp/work/proj', 'rm -rf /private/var/tmp/work/proj'],
    ['/tmp/work/proj', 'rm -rf "/tmp/work/proj"'],
    ['/tmp/work/proj', 'cd /tmp && rm -rf /tmp/work'],
  ])('keeps the question: in %s, %s', (cwd, command) => {
    expect(asksIn(command, cwd), `${cwd}: ${command}`).toBe(true);
  });

  it.each([
    ['/workspace/project', 'rm -rf /tmp/work/proj'],
    ['/home/dev/project', 'rm -rf /tmp/work'],
    ['/tmpx/work', 'rm -rf /tmp/work'],
    ['/var/tmpx/work', 'rm -rf /tmp/x'],
    ['/home/dev/tmp/work', 'rm -rf /tmp/x'],
  ])('is routine where the project is elsewhere: in %s, %s', (cwd, command) => {
    expect(asksIn(command, cwd), `${cwd}: ${command}`).toBe(false);
  });

  it('is off for a project in the per-user temp folder of a Mac, as spelled and as the disk has it', () => {
    for (const [cwd, command] of [
      ['/var/folders/zz/abc_123/T/work/proj', 'rm -rf /var/folders/zz/abc_123/T/work/proj'],
      ['/var/folders/zz/abc_123/T/work/proj', 'rm -rf /var/folders/zz/abc_123/T/work'],
      ['/var/folders/zz/abc_123/T/work/proj', 'rm -rf /var/folders/zz/abc_123/T/other'],
      ['/var/folders/zz/abc_123/T/work/proj', 'rm -rf /private/var/folders/zz/abc_123/T/work/proj'],
      ['/private/var/folders/zz/abc_123/T/work/proj', 'rm -rf /var/folders/zz/abc_123/T/work/proj'],
      ['/private/var/folders/zz/abc_123/T/work/proj', 'rm -rf /tmp/x'],
      ['/var/folders/zz/abc_123/T', 'rm -rf /tmp/x'],
    ] as const)
      expect(asksIn(command, cwd), `${cwd}: ${command}`).toBe(true);
  });

  it('is off for a project made in the temp folder of this machine', () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-temp-project-'));
    try {
      mkdirSync(join(home, 'proj'), { recursive: true });
      const cwd = join(home, 'proj');
      for (const command of [
        `rm -rf ${cwd}`,
        `rm -rf ${home}`,
        `rm -rf ${home}/other`,
        `rm -rf ${home}/*`,
      ])
        expect(asksIn(command, cwd), command).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is off for a project reached through a link into the temp directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-temp-project-'));
    const outside = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), 'stroq-link-'));
    try {
      mkdirSync(join(home, 'proj'), { recursive: true });
      symlinkSync(join(home, 'proj'), join(outside, 'here'));
      expect(asksIn(`rm -rf ${join(home, 'proj')}`, join(outside, 'here'))).toBe(true);
      expect(asksIn(`rm -rf ${home}/other`, join(outside, 'here'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('is told by the judgement itself', () => {
    const system: TempScope = { roots: ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'] };
    const named = (target: string, cwd: string): boolean =>
      isNamedTempTarget(target, facts(true), cwd, system);
    expect(named('/tmp/x', '/workspace/project')).toBe(true);
    expect(named('/tmp/x', '/tmp/work/proj')).toBe(false);
    expect(named('/tmp/work', '/tmp/work/proj')).toBe(false);
    expect(named('/tmp/work/proj', '/tmp/work/proj')).toBe(false);
    expect(named('/tmp/work/other', '/tmp/work/proj')).toBe(false);
    expect(named('/var/tmp/x', '/tmp/work/proj')).toBe(false);
  });
});

/** A target that names a secret keeps the question, wherever it is. */
describe('a secret under the temp directory', () => {
  it.each([
    'rm -rf /tmp/.ssh',
    'rm -rf /tmp/.ssh/keys',
    'rm -rf /tmp/id_rsa',
    'rm -rf /tmp/id_ed25519',
    'rm -rf /tmp/.env',
    'rm -rf /tmp/.env.local',
    'rm -rf /tmp/server.pem',
    'rm -rf /tmp/server.key',
    'rm -rf /tmp/.aws',
    'rm -rf /tmp/a/.aws/credentials',
    'rm -rf /tmp/.gnupg',
    'rm -rf /tmp/credentials.json',
    'rm -rf /tmp/service-account-prod.json',
    'rm -rf /tmp/terraform.tfstate',
    'rm -rf /tmp/.npmrc',
    'rm -rf /tmp/.netrc',
    'rm -rf /tmp/.git-credentials',
    'rm -rf /var/tmp/.ssh',
    'rm -rf /var/folders/zz/abc_123/T/.ssh',
    'rm -rf /private/var/folders/zz/abc_123/T/id_rsa',
    'rm -rf "/tmp/.ssh"',
  ])('keeps the question: %s', (command) => {
    expect(asks(command), command).toBe(true);
  });
});

/**
 * A variable for the temp directory (`$TMPDIR`, `${TMPDIR:-/tmp}`, `$env:TEMP`) is the shell's to say, and the hook
 * cannot see the shell of the agent: some agents keep one shell across calls, and `export TMPDIR=$HOME` in one
 * makes `rm -rf "$TMPDIR/Documents"` in the next the home. A variable form keeps the question, whatever the
 * environment of the hook holds.
 */
describe('a variable for the temp directory', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'stroq-temp-delete-'));
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  const forms = [
    'rm -rf $TMPDIR/build',
    'rm -rf "$TMPDIR/build"',
    'rm -rf "${TMPDIR}/build"',
    'rm -rf "$TMPDIR"/build',
    'rm -rf ${TMPDIR:-/tmp}/build',
    'rm -rf "${TMPDIR:-/tmp}/build"',
    'rm -rf $TMPDIR/build && mkdir -p $TMPDIR/build',
    'rm -rf $TMP/build',
    'rm -rf $TEMP/build',
    'rm -rf "$TMPDIR"',
    'rm -rf $TMPDIR/',
    'rm -rf $TMPDIR/*',
    'rm -rf $TMPDIR/a/b',
    'rm -rf $TMPDIR/../x',
    'rm -rf $TMPDIR/$X',
    'rm -rf $TMPDIR_OTHER/x',
    'rm -rf ${TMPDIR:-/}/x',
    'Remove-Item -Recurse -Force $env:TEMP\\build',
    'Remove-Item -Recurse -Force $env:TMP\\build',
    'Remove-Item -Recurse -Force "$env:TEMP\\build"',
    'rd /s /q $env:TEMP\\build',
  ];

  it.each(forms)('keeps the question, whatever the hook holds: %s', (command) => {
    for (const value of [tempDir, '/tmp', '/var/folders/zz/abc_123/T', '/', '/home/user', '']) {
      vi.stubEnv('TMPDIR', value);
      expect(asks(command), `${value}: ${command}`).toBe(true);
    }
    vi.stubEnv('TMPDIR', undefined as unknown as string);
    expect(asks(command), `unset: ${command}`).toBe(true);
  });

  it('keeps the question when an earlier call changed it: two commands, classified apart', () => {
    vi.stubEnv('TMPDIR', tempDir);
    const first = classes('export TMPDIR=$HOME');
    expect(first).not.toContain('shell.destructive');
    expect(asks('rm -rf "$TMPDIR/Documents"')).toBe(true);
    expect(asks('rm -rf $TMPDIR/Documents')).toBe(true);
    expect(asks('rm -rf "${TMPDIR}/Documents"')).toBe(true);
    expect(asks('export TMPDIR=$HOME && rm -rf "$TMPDIR/Documents"')).toBe(true);
  });
});

/** What the rest of a line is, as `isNamedTempTarget` is told: all of it inert or not. */
const facts = (inert: boolean): LineFacts => ({
  inert: () => inert,
  probe: () => true,
  scope: () => ({ roots: [] }),
});

describe('a link that leaves the temp directory', () => {
  // The folder the tests make is the temp folder for them: a root that is given, and a literal path the hook knows
  // when it is under the system's own.
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
  const named = (target: string): boolean =>
    isNamedTempTarget(target, facts(true), CWD, { roots: [scope] });

  it.each([
    ['a link at the name, to somewhere else', 'out'],
    ['a link at the name, to the root', 'root'],
    ['a link above the name', 'out/child'],
    ['a link above the name, deeper', 'plain/inner/up/child'],
    ['a link at the end of a path', 'plain/inner/up'],
    ['a link to a place that is not there, outside', 'dangling'],
    ['the folder itself', ''],
    ['the folder with a slash', '/'],
    ['all of it', '/*'],
  ])('%s keeps the question', (_name, below) => {
    expect(named(`${scope}/${below}`.replace('//', '/')), below).toBe(false);
  });

  it.each([
    ['a plain folder', 'plain'],
    ['a folder in it', 'plain/inner'],
    ['a name that is not there', 'missing'],
    ['a name below one that is not there', 'missing/deeper'],
    ['a link to a folder inside it', 'in'],
    ['a link to a folder inside it, with a name below', 'in/inner'],
  ])('%s does not', (_name, below) => {
    expect(named(`${scope}/${below}`), below).toBe(true);
  });

  // Where the system's own folder is the one the tests made, the command is judged by the same rule.
  const known =
    /^\/(?:tmp|var\/tmp|private\/tmp|private\/var\/tmp)\//.test(scope) ||
    /^\/(?:private\/)?var\/folders\/[A-Za-z0-9_]{2}\/[A-Za-z0-9_]+\/T\//.test(scope);
  it.skipIf(!known)('is the same through a command', () => {
    for (const below of ['out', 'root', 'out/child', 'plain/inner/up/child', 'dangling'])
      expect(asks(`rm -rf ${scope}/${below}`), below).toBe(true);
    for (const below of ['plain', 'plain/inner', 'missing', 'in', 'in/inner'])
      expect(asks(`rm -rf ${scope}/${below}`), below).toBe(false);
  });
});

describe('isNamedTempTarget', () => {
  const system: TempScope = { roots: ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'] };
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

  it('takes no variable: the hook cannot see the shell that expands it', () => {
    for (const target of [
      '$TMPDIR/x',
      '${TMPDIR}/x',
      '${TMPDIR:-/tmp}/x',
      '$TMP/x',
      '$TEMP/x',
      '$env:TEMP\\x',
      '%TEMP%\\x',
      '%TMP%/x',
    ])
      expect(named(target), target).toBe(false);
  });

  it('takes the per-user temp folder of a Mac when it is spelled out', () => {
    for (const target of [
      '/var/folders/zz/abc_123/T/x',
      '/private/var/folders/zz/abc_123/T/x',
      '/var/folders/n6/cmcn057lg8_xqwf82jfnbr0000gn/T/x',
      '/var/folders/zz/abc_123/T/x/y',
    ])
      expect(named(target), target).toBe(true);
    expect(named('/var/folders/zz/abc_123/T/x/y', false)).toBe(false);
    for (const target of [
      '/var/folders',
      '/var/folders/zz',
      '/var/folders/zz/abc_123',
      '/var/folders/zz/abc_123/T',
      '/var/folders/zz/abc_123/T/',
      '/var/folders/zz/abc_123/T/*',
      '/var/folders/zz/abc_123/T/../C/x',
      '/var/folders/zz/abc_123/C/x',
      '/var/folders/zz/abc_123/0/x',
      '/var/folders/zz/abc_123/Tx/y',
      '/var/folders/zz/abc_123/t/x',
      '/var/folders/z/abc_123/T/x',
      '/var/folders/zzz/abc_123/T/x',
      '/var/folders/zz//T/x',
      '/var/folders/zz/ab c/T/x',
      '/var/folders/zz/abc_123/T//x',
      '/Var/folders/zz/abc_123/T/x',
      '/private/private/var/folders/zz/abc_123/T/x',
    ])
      expect(named(target), target).toBe(false);
  });

  it('is off where the project is in the per-user temp folder', () => {
    const cwd = '/var/folders/zz/abc_123/T/work/proj';
    expect(isNamedTempTarget('/tmp/x', facts(true), cwd, system)).toBe(false);
    expect(isNamedTempTarget('/var/folders/zz/abc_123/T/work', facts(true), cwd, system)).toBe(
      false,
    );
    expect(isNamedTempTarget('/var/folders/zz/abc_123/T/other', facts(true), cwd, system)).toBe(
      false,
    );
    expect(
      isNamedTempTarget(
        '/var/folders/zz/abc_123/T/x',
        facts(true),
        '/private/var/folders/zz/abc_123/T/w',
        system,
      ),
    ).toBe(false);
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
