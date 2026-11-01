import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { isDangerousRmTarget } from '../../src/actions/dangerous-target.js';
import { cpuNow } from '../cpu-time.js';

/**
 * A delete is aimed outside the project when the path it names, read word by word from the directory
 * the hook gives, climbs out of it. `rm -rf tmp/../../x` is the directory above the project, and was
 * not asked about: only a path that began with `..` was. The same holds for an absolute path that goes
 * through the project (`/work/project/../x`), which began with the project and so was taken for inside.
 *
 * A `..` that stays inside (`build/../dist`) is the delete it was. A name the shell expands beside a
 * `..` (`a/$X/../..`) cannot be read word by word: it is a question.
 */

const CWD = '/home/dev/project';
const dangerous = (target: string, cwd = CWD): boolean => isDangerousRmTarget(target, cwd);
const asks = (command: string): boolean =>
  classifyCommand(command, '/workspace/project').classes.includes('shell.destructive');

describe('a relative path that climbs out of the project', () => {
  it.each([
    'tmp/../../x',
    './../x',
    'a/b/../../../x',
    'a/./../../x',
    'a//..//..//x',
    './build/../../x',
    'build/../..',
    'a/../..',
    '*/../../x',
    'a/*/../../..',
    '.\\..\\x',
    'a\\..\\..\\x',
    'a/b\\..\\..\\..\\x',
  ])('%s', (target) => expect(dangerous(target)).toBe(true));

  it.each(['a/..', 'a/../', './a/..', 'a/b/../..', 'x/./..', '*/..', 'a//..'])(
    'ends where it started: %s',
    (target) => expect(dangerous(target)).toBe(true),
  );
});

describe('a relative path that stays inside the project', () => {
  it.each([
    'build/../dist',
    'build/./../dist',
    'a/b/../c',
    'a/b/../../c',
    'build/../dist/*',
    'dist/../build/',
    './a/../b',
    'a/../a',
    'a/*/../b',
    'node_modules/.cache/../x',
    'a\\b\\..\\c',
    'a/~/../b',
    'a/.hidden/../b',
    // Unchanged: no `..`.
    'node_modules',
    'dist/',
    'tmp.txt',
    'build/$X',
    'dist/*',
    'a/b/c',
  ])('%s', (target) => expect(dangerous(target)).toBe(false));
});

describe('a name the shell expands, beside a ..', () => {
  it.each([
    'a/$X/../..',
    'a/${X}/../x',
    'a/$(pwd)/../x',
    'a/`pwd`/../x',
    'a/.*/../x',
    'a/.?/../x',
    'a/.[.]/../x',
    'a/..*/x/..',
    'a/{b,c}/../../..',
    'a/{b,../..}/x',
    '$X/../..',
    'x/$((1))/..',
  ])('%s is asked about', (target) => expect(dangerous(target)).toBe(true));

  it.each(['build/$X', 'build/${X}/out', 'dist/*', 'src/**/*.pyc'])(
    'with no .., %s is what it was',
    (target) => expect(dangerous(target)).toBe(false),
  );

  it('reads a glob as one name: it matches nothing with a slash in it', () => {
    expect(dangerous('a/*/../b')).toBe(false);
    expect(dangerous('a/b?/../c')).toBe(false);
    expect(dangerous('*/../../b')).toBe(true);
    expect(dangerous('a/*/../../..')).toBe(true);
  });
});

describe('~-relative forms', () => {
  it.each(['~/x/../y', '~/..', '~root/../x', '~+/../x', '~-/../x', '~/a/b/../../..'])(
    '%s',
    (target) => expect(dangerous(target)).toBe(true),
  );
});

describe('an absolute path through the project', () => {
  it.each([
    `${CWD}/../x`,
    `${CWD}/build/../../x`,
    `${CWD}/build/..`,
    `${CWD}/a/../..`,
    `${CWD}/./../x`,
    `${CWD}/$X/../x`,
    `${CWD}/build/../`,
    `${CWD}//../x`,
    '/tmp/../home/user',
    '/tmp/x/../../home',
  ])('%s leaves it', (target) => expect(dangerous(target)).toBe(true));

  it.each([
    `${CWD}/build/../dist`,
    `${CWD}/build/./../dist`,
    `${CWD}/a/b/../../c`,
    `${CWD}/../project/x`,
    `${CWD}/dist/../build/`,
    '/home/dev/other/../project/x',
  ])('%s stays', (target) => expect(dangerous(target)).toBe(false));

  it('is judged against the directory it is told, with or without a trailing slash', () => {
    expect(dangerous(`${CWD}/build/../dist`, `${CWD}/`)).toBe(false);
    expect(dangerous(`${CWD}/../x`, `${CWD}/`)).toBe(true);
    expect(dangerous('/etc/../etc/x', '/')).toBe(true);
  });

  it('is judged on a Windows path as well', () => {
    const root = 'C:\\work\\proj';
    expect(dangerous('C:\\work\\proj\\build\\..\\dist', root)).toBe(false);
    expect(dangerous('C:\\work\\proj\\build\\..\\..\\x', root)).toBe(true);
    expect(dangerous('c:/work/proj/../x', root)).toBe(true);
    expect(dangerous('C:\\work\\proj\\..', root)).toBe(true);
    expect(dangerous('C:\\..\\x', root)).toBe(true);
  });
});

describe('the shell command', () => {
  it.each([
    'rm -rf tmp/../../x',
    'rm -rf ./../x',
    'rm -rf a/b/../../../x',
    'rm -rf a/..',
    'rm -rf a/../..',
    'rm -rf ~/x/../y',
    'rm -rf a/$X/../..',
    'rm -rf a/$(pwd)/../x',
    'rm -rf a/`pwd`/../x',
    'rm -rf */../../x',
    'rm -rf a/{b,../..}/x',
    'rm -rf /workspace/project/../x',
    'rm -rf /workspace/project/build/../../x',
    'rm -r a/../../x',
    'rm -fr a/../../x',
    'rm --recursive --force a/../../x',
    'rm -rf -- a/../../x',
    'rm -rf build ./../x',
    'rm -rf "a/../../x"',
    "rm -rf 'a/../../x'",
    // Quoted and escaped blanks: the shell passes one word, and the words are cut at the blank.
    'rm -rf "a b/../../x"',
    "rm -rf 'a b/../..'",
    'rm -rf a\\ b/../../x',
    'rm -rf "x/a b/../../.."',
    'rm -rf "x/y/a b/../../../../.."',
    'rm -rf "a b" "c d/../../x"',
  ])('%s is asked about', (command) => expect(asks(command), command).toBe(true));

  it.each([
    'rm -rf build/../dist',
    'rm -rf build/../dist/*',
    'rm -rf a/b/../c',
    'rm -rf "a b/../c"',
    'rm -rf a\\ b/../c',
    "rm -rf 'a b/c/../d'",
    'rm -rf node_modules dist build/../out',
    'rm -rf /workspace/project/build/../dist',
    'rm -rf build/$X',
    'rm -rf dist/*',
    'rm -f a/../../x',
  ])('%s is not', (command) => expect(asks(command), command).toBe(false));

  it('keeps what it said about a path that begins with ..', () => {
    for (const command of ['rm -rf ..', 'rm -rf ../x', 'rm -rf ../*', 'rm -rf ~', 'rm -rf $X/a'])
      expect(asks(command), command).toBe(true);
  });
});

describe('the other readers of the same judgement', () => {
  it.each([
    'find a/../../x -delete',
    'find ../x -delete',
    'find build/../.. -exec rm -rf {} +',
    'find /workspace/project/../x -delete',
    'echo a/../../x | xargs rm -rf',
    'echo ../x | xargs rm -rf',
    'echo /workspace/project/../x | xargs rm -rf',
    'ssh host rm -rf a/../../x',
    'Remove-Item -Recurse -Force a\\..\\..\\x',
    'Remove-Item -Recurse -Force ..\\x',
    'rd /s /q a\\..\\..\\x',
  ])('%s is asked about', (command) => expect(asks(command), command).toBe(true));

  it.each([
    'find build/../dist -delete',
    "find . -name '*.pyc' -delete",
    'ls build/../dist | xargs rm -rf',
    'echo build/../dist | xargs rm -rf',
    'ssh host rm -rf build/../dist',
    'Remove-Item -Recurse -Force build\\..\\dist',
  ])('%s is not', (command) => expect(asks(command), command).toBe(false));
});

describe('reading time', () => {
  it.each([
    ['climbs', (n: number) => `a/${'../'.repeat(n)}x`],
    ['descents and climbs', (n: number) => `${'a/../'.repeat(n)}x`],
    ['descents', (n: number) => `${'a/'.repeat(n)}../x`],
    ['separators', (n: number) => `a${'/'.repeat(n)}..${'/'.repeat(n)}x`],
    ['mixed separators', (n: number) => `a${'\\/'.repeat(n)}..${'/\\'.repeat(n)}x`],
    ['dots', (n: number) => `${'./'.repeat(n)}..`],
    ['glob names', (n: number) => `${'*/'.repeat(n)}../x`],
    ['absolute climbs', (n: number) => `${CWD}/${'../'.repeat(n)}x`],
  ])('stays linear in %s', (_name, build) => {
    const time = (n: number): number => {
      const target = build(n);
      const started = cpuNow();
      dangerous(target);
      return cpuNow() - started;
    };
    const small = time(16_000);
    const large = time(64_000);
    expect(large).toBeLessThan(500);
    expect(large).toBeLessThan(Math.max(small * 12, 40));
  });
});
