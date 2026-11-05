import { describe, expect, it } from 'vitest';
import { gitExecSignals, isGitExecKey } from '../../src/actions/git-exec.js';
import { cpuNow } from '../cpu-time.js';

/**
 * The git-lfs keys that name a program to run: a custom transfer agent's `path`, a standalone
 * transfer agent (global or for one URL), an extension's `clean` and `smudge`. Section and variable
 * names are case-insensitive in git, and a subsection is any text of any length, a quoted one with
 * dots, slashes and `=` in it. A key is read whole, and a command on its words, so no length of
 * subsection puts one out of reach.
 */
const long = (n: number): string => 'a'.repeat(n);

describe('git-lfs keys that run a program, as the keys of a config', () => {
  it.each([
    'lfs.customtransfer.x.path',
    'LFS.CustomTransfer.My.Agent.PATH',
    'lfs.customtransfer.https://a.b/c.path',
    'lfs.customtransfer.https://a.b/c?x=1&y=2.path',
    'lfs.customtransfer..path',
    'lfs.standalonetransferagent',
    'lfs.StandaloneTransferAgent',
    'lfs.https://example.invalid/repo.standalonetransferagent',
    'lfs.https://example.invalid/r?x=1.standalonetransferagent',
    'lfs.extension.x.clean',
    'lfs.extension.x.smudge',
    'LFS.Extension.Y.Smudge',
  ])('%s is an exec key', (key) => {
    expect(isGitExecKey(key)).toBe(true);
  });

  it.each([100, 101, 255, 5_000, 100_000])(
    'a subsection of %i characters is no way past it',
    (size) => {
      const sub = long(size);
      for (const key of [
        `lfs.customtransfer.${sub}.path`,
        `lfs.extension.${sub}.clean`,
        `lfs.extension.${sub}.smudge`,
        `lfs.${sub}.standalonetransferagent`,
        `lfs.customtransfer.${sub}.a.b.c.path`,
        `lfs.customtransfer.${sub}\n${sub}.path`,
        `lfs.customtransfer.${sub}.${sub}.path`,
      ])
        expect(isGitExecKey(key), key.slice(0, 40)).toBe(true);
    },
  );

  it.each([
    'lfs.url',
    'lfs.pushurl',
    'lfs.concurrenttransfers',
    'lfs.customtransfer.x.args',
    'lfs.customtransfer.x.concurrent',
    'lfs.customtransfer.x.path.y',
    'lfs.customtransfer.path',
    'lfs.extension.x.priority',
    'lfs.extension.x.clean.more',
    'lfs.standalonetransferagentx',
    'lfs.standalonetransferagent.x',
    'xlfs.standalonetransferagent',
    'lfs',
    '',
  ])('%j is not', (key) => {
    expect(isGitExecKey(key)).toBe(false);
  });
});

const sets = (command: string): boolean => gitExecSignals([command]).includes('git-exec-key');

describe('git-lfs keys that run a program, in a command', () => {
  it.each([
    'git config lfs.customtransfer.x.path "sh -c evil"',
    'git config --local lfs.extension.x.smudge "evil %f"',
    "git config --global 'lfs.https://example.invalid/r.standalonetransferagent' x",
    'git config lfs.standalonetransferagent x',
    'git -c lfs.standalonetransferagent=x lfs pull',
    'git -clfs.customtransfer.x.path=evil lfs pull',
    "git -c 'lfs.https://a.b/c?x=1.standalonetransferagent=agent' lfs pull",
    "git -c 'lfs.extension.x.clean=evil %f' add .",
    'git --config-env=lfs.customtransfer.x.path=EVIL lfs pull',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=lfs.customtransfer.x.path GIT_CONFIG_VALUE_0=evil git lfs pull',
    `GIT_CONFIG_PARAMETERS="'lfs.extension.x.smudge=evil'" git lfs pull`,
    'git config LFS.CUSTOMTRANSFER.X.PATH evil',
  ])('%s', (command) => {
    expect(sets(command)).toBe(true);
  });

  it.each([101, 5_000])('with a subsection of %i characters', (size) => {
    const sub = long(size);
    for (const command of [
      `git config lfs.customtransfer.${sub}.path evil`,
      `git -c lfs.extension.${sub}.clean=evil add .`,
      `git -c 'lfs.${sub}.standalonetransferagent=x' lfs pull`,
      `git config "lfs.${sub.slice(0, 50)}.${sub}.standalonetransferagent" x`,
      `GIT_CONFIG_KEY_0=lfs.extension.${sub}.smudge git lfs pull`,
    ])
      expect(sets(command), command.slice(0, 60)).toBe(true);
  });

  it.each([
    'git config lfs.url https://example.invalid/lfs',
    'git config --get lfs.customtransfer.x.path',
    'git config --get-regexp "lfs.*"',
    'git -c lfs.concurrenttransfers=4 lfs pull',
    'git lfs install',
    'git lfs pull',
    'git log --grep="lfs.customtransfer.x.path"',
    'echo lfs.extension.x.clean',
    'git config lfs.extension.x.priority 1',
  ])('not %s', (command) => {
    expect(sets(command)).toBe(false);
  });

  // Four times the text may cost four times as long; sixteen times is quadratic.
  it.each([
    ['lfs.customtransfer.', (u: string) => `git config ${u}`],
    ['lfs.', (u: string) => `git config ${u}`],
    ['lfs.extension.x.clean.', (u: string) => `git -c ${u}`],
    ['a.', (u: string) => `git config lfs.customtransfer.${u}`],
    ['a.', (u: string) => `git config lfs.${u}`],
    ['lfs.x.standalonetransferagent.', (u: string) => `git config ${u}`],
    ['lfs.x.standalonetransferagenx.', (u: string) => `git config ${u}`],
    ['=', (u: string) => `git -c lfs.customtransfer.x${u}`],
    ['.path=', (u: string) => `git -c lfs.customtransfer.x${u}`],
    ['lfs.', (u: string) => `GIT_CONFIG_KEY_0=${u}`],
  ])('stays linear on %j repeated', (unit, build) => {
    const times = [1 << 14, 1 << 16, 1 << 18].map((size) => {
      const text = build(unit.repeat(Math.ceil(size / unit.length)).slice(0, size));
      const started = cpuNow();
      sets(text);
      isGitExecKey(text.replace(/^git (?:-c |config )/, ''));
      return cpuNow() - started;
    });
    const [a, b, c] = times as [number, number, number];
    expect(b < 300 || b < 11 * a, times.join(', ')).toBe(true);
    expect(c < 300 || c < 11 * b, times.join(', ')).toBe(true);
  });
});
