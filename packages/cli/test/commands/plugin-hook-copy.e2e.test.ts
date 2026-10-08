import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PIN,
  cliDir,
  runWrapper,
  preBash,
  postRead,
  fakeNpx,
  logLines,
  calls,
  ETARGET_STDERR,
  fakeNpm,
  runWithCopy,
  stroqShim,
  BARE_PATH,
} from '../helpers/plugin-wrapper.js';

describe.skipIf(process.platform === 'win32')('the plugin wrapper, with a copy of its own', () => {
  const copyOf = (home: string): string => join(home, 'plugin-cli', PIN);
  const entryOf = (home: string): string =>
    join(copyOf(home), 'node_modules', '@stroq', 'cli', 'dist', 'index.js');
  const ALLOWED = '{"hookSpecificOutput":{"permissionDecision":"allow","from":"copy"}}';
  const newHome = (): string => mkdtempSync(join(tmpdir(), 'stroq-plugin-e2e-'));

  // Each tool call runs the wrapper three times (before, after, after a failure). Through npx
  // every one of them cost 0.72 s against 0.13 s for node on the same bundle, and a request to
  // the registry, which a slow or absent network turned into a blocked call.
  it('installs the pinned version once, and runs it with node from then on', async () => {
    const npm = fakeNpm();
    const npx = fakeNpx('exit 1');
    const home = newHome();
    const first = await runWithCopy(preBash('ls'), npm, npx, home);
    expect(first.code).toBe(0);
    // What npm prints on success is not the hook's answer.
    expect(first.stdout).toBe(ALLOWED);
    expect(existsSync(entryOf(home))).toBe(true);
    const second = await runWithCopy(postRead, npm, npx, home);
    expect(second).toMatchObject({ code: 0, stdout: ALLOWED });
    expect(calls(npm.log)).toHaveLength(1);
    expect(calls(npx.log)).toHaveLength(0);
    expect(logLines(npm.stubLog)).toHaveLength(2);
  }, 60_000);

  it('hands the event to the copy as `hook claude-code`', async () => {
    const npm = fakeNpm();
    const home = newHome();
    const input = preBash('ls -la');
    await runWithCopy(input, npm, fakeNpx('exit 1'), home);
    expect(logLines(npm.stubLog)).toEqual([`ran: hook claude-code | ${input}`]);
  }, 60_000);

  it('installs with scripts off, from a scratch directory under Stroq’s home', async () => {
    const npm = fakeNpm();
    const home = newHome();
    await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), home);
    const [call] = calls(npm.log);
    expect(call).toContain('install');
    expect(call).toContain('--ignore-scripts');
    expect(call).toContain(`@stroq/cli@${PIN}`);
    // A folder above that lists the scratch directory as a workspace would supply its own code.
    expect(call).toContain('--no-workspaces');
    // Into a directory of its own, which has a package.json: npm reads the project's `.npmrc` from
    // there, and not from a folder above it that names another registry.
    const prefix = /--prefix (\S+)/.exec(call ?? '')?.[1] ?? '';
    expect(prefix.startsWith(join(home, 'plugin-tmp'))).toBe(true);
    const where =
      logLines(npm.log)
        .find((line) => line.startsWith('pwd: '))
        ?.slice(5) ?? '';
    expect(where.startsWith(realpathSync(join(home, 'plugin-tmp')))).toBe(true);
    // The same fetch limits as npx, so that one install fits inside the hook timeout.
    const settings = logLines(npm.log).find((line) => line.startsWith('settings: ')) ?? '';
    expect(settings).toContain('retries=0');
    expect(Number(/timeout=(\d+)/.exec(settings)?.[1])).toBeLessThanOrEqual(6_000);
  }, 60_000);

  // npm reads the `.npmrc` of the project it finds from where it runs, and the install is given a
  // staging directory with a package.json of its own as its prefix. This asks the real npm which
  // registry it would use, with the prefix the wrapper passed, from inside a folder whose
  // ancestor names another one.
  it('does not let a .npmrc above the scratch directory choose the registry', async () => {
    const ancestor = mkdtempSync(join(tmpdir(), 'stroq-npmrc-ancestor-'));
    writeFileSync(join(ancestor, 'package.json'), '{"name":"hostile"}');
    writeFileSync(join(ancestor, '.npmrc'), 'registry=http://evil.example:9/\n');
    const realNpm = join(process.execPath, '..', 'npm');
    const npm = fakeNpm({
      before: `p=""; n=""
for a in "$@"; do
  if [ "$n" = yes ]; then p="$a"; n=""; fi
  if [ "$a" = --prefix ]; then n=yes; fi
done
"${realNpm}" config get registry --prefix "$p" >> "$(dirname "$0")/registry.log" 2>&1`,
    });
    const under = mkdtempSync(join(tmpdir(), 'stroq-fake-mktemp-'));
    writeFileSync(
      join(under, 'mktemp'),
      `#!/bin/sh\nd="${ancestor}/work.$$"\nmkdir -p "$d" && echo "$d"\n`,
    );
    chmodSync(join(under, 'mktemp'), 0o755);
    const r = await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), newHome(), {}, `${under}:`);
    expect(r.code).toBe(0);
    const registry = readFileSync(join(npm.dir, 'registry.log'), 'utf8');
    expect(registry).toContain('registry.npmjs.org');
    expect(registry).not.toContain('evil.example');
  }, 60_000);

  it('leaves no scratch directory behind', async () => {
    const home = newHome();
    await runWithCopy(preBash('ls'), fakeNpm(), fakeNpx('exit 1'), home);
    expect(readdirSync(join(home, 'plugin-tmp'))).toEqual([]);
  }, 60_000);

  // A registry that answers with another package, or another version, is not what the pin says.
  it('does not use a copy that is not the version it pinned', async () => {
    const npm = fakeNpm({ version: '99.0.0' });
    const npx = fakeNpx('printf "%s" "{}"; exit 0');
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, npx, home);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('99.0.0');
    expect(existsSync(copyOf(home))).toBe(false);
    expect(logLines(npm.stubLog)).toEqual([]);
    expect(calls(npx.log)).toHaveLength(1);
  }, 60_000);

  it('goes on to npx when the install fails', async () => {
    const npm = fakeNpm({ before: "echo 'npm error code E503' >&2; exit 1" });
    const npx = fakeNpx('printf "%s" "{}"; exit 0');
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, npx, home);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('E503');
    expect(existsSync(copyOf(home))).toBe(false);
    expect(calls(npx.log)).toHaveLength(1);
    expect(calls(npx.log)[0]).toContain(`@stroq/cli@${PIN}`);
  }, 60_000);

  // The pin means something: a stroq that fails is not a reason to run another one.
  it('does not go on to npx because stroq itself failed on the copy', async () => {
    const npm = fakeNpm();
    const npx = fakeNpx('printf "%s" "{}"; exit 0');
    const home = newHome();
    const pre = await runWithCopy(preBash('ls'), npm, npx, home, { STUB_EXIT: '3' });
    expect(pre.code).toBe(2);
    expect(pre.stderr).toContain('exit 3');
    const post = await runWithCopy(postRead, npm, npx, home, { STUB_EXIT: '3' });
    expect(post.code).toBe(0);
    expect(calls(npx.log)).toHaveLength(0);
    expect(calls(npm.log)).toHaveLength(1);
  }, 60_000);

  it('blocks a PreToolUse and lets a PostToolUse through when nothing can be installed or run', async () => {
    const npm = fakeNpm({ before: 'exit 1' });
    const npx = fakeNpx(ETARGET_STDERR);
    const home = newHome();
    expect((await runWithCopy(preBash('ls'), npm, npx, home)).code).toBe(2);
    expect((await runWithCopy(postRead, npm, npx, home)).code).toBe(0);
  }, 60_000);

  it('leaves one complete copy when two hooks start together', async () => {
    const npm = fakeNpm({ before: 'sleep 1' });
    const npx = fakeNpx('exit 1');
    const home = newHome();
    const [a, b] = await Promise.all([
      runWithCopy(preBash('ls'), npm, npx, home),
      runWithCopy(postRead, npm, npx, home),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect([a.stdout, b.stdout]).toEqual([ALLOWED, ALLOWED]);
    expect(readdirSync(join(home, 'plugin-cli'))).toEqual([PIN]);
    expect(existsSync(entryOf(home))).toBe(true);
    // The one that finished second did not leave its tree inside the first one's.
    expect(readdirSync(copyOf(home))).not.toContain('stage');
    expect(readdirSync(join(home, 'plugin-tmp'))).toEqual([]);
  }, 60_000);

  it('prefers a global stroq to the copy, and runs neither npm nor npx', async () => {
    const npm = fakeNpm();
    const npx = fakeNpx('exit 1');
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, npx, home, {}, `${stroqShim()}:`);
    expect(r.code).toBe(0);
    expect(calls(npm.log)).toHaveLength(0);
    expect(calls(npx.log)).toHaveLength(0);
    expect(existsSync(join(home, 'plugin-cli'))).toBe(false);
  }, 60_000);

  it('keeps to npx when STROQ_PLUGIN_NO_LOCAL_COPY is set', async () => {
    const npm = fakeNpm();
    const npx = fakeNpx('printf "%s" "{}"; exit 0');
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, npx, home, { STROQ_PLUGIN_NO_LOCAL_COPY: '1' });
    expect(r.code).toBe(0);
    expect(calls(npm.log)).toHaveLength(0);
    expect(calls(npx.log)).toHaveLength(1);
    expect(existsSync(join(home, 'plugin-cli'))).toBe(false);
  }, 60_000);

  // A plugin update moves the pin. The copies of earlier versions go when the new one is
  // installed, once they are more than a day old (the age of the directory is its install
  // time), so that a hook that started before the update does not lose its own.
  it('removes the copies of older versions that are more than a day old, and keeps newer ones', async () => {
    const home = newHome();
    const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3600 * 1000);
    for (const [version, hours] of [
      ['0.0.1', 72],
      ['0.0.2', 30],
      ['0.0.3', 12],
    ] as const) {
      const dir = join(home, 'plugin-cli', version);
      mkdirSync(dir, { recursive: true });
      utimesSync(dir, hoursAgo(hours), hoursAgo(hours));
    }
    await runWithCopy(preBash('ls'), fakeNpm(), fakeNpx('exit 1'), home);
    expect(readdirSync(join(home, 'plugin-cli')).sort()).toEqual(['0.0.3', PIN].sort());
  }, 60_000);

  // A stroq that hangs (the FIFO a script is named after, in the published 0.22.0) used to be
  // ended with the npx that started it. Run by node on the copy it ran into the host's own hook
  // timeout instead, and a host that times a hook out lets the call through.
  describe('when stroq itself hangs', () => {
    it('ends a copy that hangs at the deadline and blocks a PreToolUse', async () => {
      const npm = fakeNpm();
      const npx = fakeNpx('exit 1');
      const home = newHome();
      await runWithCopy(preBash('ls'), npm, npx, home);
      const started = Date.now();
      const r = await runWithCopy(preBash('ls'), npm, npx, home, {
        STROQ_PLUGIN_NPX_DEADLINE: '2',
        STUB_HANG: '1',
      });
      expect(r.code).toBe(2);
      expect(Date.now() - started).toBeLessThan(9_000);
      expect(calls(npx.log)).toHaveLength(0);
    }, 30_000);

    it('lets a PostToolUse through when the copy hangs', async () => {
      const npm = fakeNpm();
      const npx = fakeNpx('exit 1');
      const home = newHome();
      await runWithCopy(preBash('ls'), npm, npx, home);
      const started = Date.now();
      const r = await runWithCopy(postRead, npm, npx, home, {
        STROQ_PLUGIN_NPX_DEADLINE: '2',
        STUB_HANG: '1',
      });
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(9_000);
    }, 30_000);

    it('ends a global stroq that hangs, and what it started', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'stroq-hang-shim-'));
      writeFileSync(
        join(dir, 'stroq'),
        `#!/bin/sh\ncat > /dev/null\nsleep 30 &\necho $! > "${join(dir, 'sleeper.pid')}"\nwait\n`,
      );
      chmodSync(join(dir, 'stroq'), 0o755);
      const started = Date.now();
      const r = await runWrapper(preBash('ls'), `${dir}:${BARE_PATH}`, newHome(), {
        STROQ_PLUGIN_NPX_DEADLINE: '2',
      });
      expect(r.code).toBe(2);
      expect(Date.now() - started).toBeLessThan(9_000);
      const pid = Number(readFileSync(join(dir, 'sleeper.pid'), 'utf8').trim());
      await new Promise((done) => setTimeout(done, 1_500));
      expect(() => process.kill(pid, 0)).toThrow();
    }, 30_000);

    // The run has what is left of its deadline, counted from the start: an install that took four
    // seconds of a six-second way to stroq leaves a stroq that hangs four more, not eight.
    it('counts the run deadline from the start, not from the end of the install', async () => {
      const npm = fakeNpm({ before: 'sleep 4' });
      const started = Date.now();
      const r = await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), newHome(), {
        STROQ_PLUGIN_NPX_DEADLINE: '6',
        STUB_HANG: '1',
      });
      expect(r.code).toBe(2);
      expect(Date.now() - started).toBeLessThan(10_500);
    }, 30_000);

    // Killed by the deadline, a copy is not a broken one: deleting it would be wrong advice.
    it('does not tell anyone to delete a copy that was only too slow', async () => {
      const npm = fakeNpm();
      const home = newHome();
      await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), home);
      const r = await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), home, {
        STROQ_PLUGIN_NPX_DEADLINE: '2',
        STUB_HANG: '1',
      });
      expect(r.code).toBe(2);
      expect(r.stderr).not.toContain('delete it');
    }, 30_000);
  });

  // Something at the copy's place that is not a copy (a directory with nothing in it, a link
  // that goes nowhere) kept the pinned version from ever being used: the check "is there
  // something" skipped the move, and every call went through npx instead.
  describe('when something that is not a copy stands where the copy goes', () => {
    it('replaces an empty directory', async () => {
      const npm = fakeNpm();
      const npx = fakeNpx('exit 1');
      const home = newHome();
      mkdirSync(copyOf(home), { recursive: true });
      const r = await runWithCopy(preBash('ls'), npm, npx, home);
      expect(r).toMatchObject({ code: 0, stdout: ALLOWED });
      expect(existsSync(entryOf(home))).toBe(true);
      expect(calls(npx.log)).toHaveLength(0);
    }, 60_000);

    it('replaces a link to a directory that has no copy in it, without touching that directory', async () => {
      const npm = fakeNpm();
      const npx = fakeNpx('exit 1');
      const home = newHome();
      const victim = mkdtempSync(join(tmpdir(), 'stroq-victim-'));
      mkdirSync(join(victim, 'stage'));
      writeFileSync(join(victim, 'stage', 'important.txt'), 'keep');
      mkdirSync(join(home, 'plugin-cli'), { recursive: true });
      symlinkSync(victim, copyOf(home));
      const r = await runWithCopy(preBash('ls'), npm, npx, home);
      expect(r).toMatchObject({ code: 0, stdout: ALLOWED });
      expect(readFileSync(join(victim, 'stage', 'important.txt'), 'utf8')).toBe('keep');
      expect(existsSync(entryOf(home))).toBe(true);
      expect(calls(npx.log)).toHaveLength(0);
    }, 60_000);

    it('replaces a link that points at nothing', async () => {
      const npm = fakeNpm();
      const npx = fakeNpx('exit 1');
      const home = newHome();
      mkdirSync(join(home, 'plugin-cli'), { recursive: true });
      symlinkSync(join(home, 'nowhere'), copyOf(home));
      const r = await runWithCopy(preBash('ls'), npm, npx, home);
      expect(r).toMatchObject({ code: 0, stdout: ALLOWED });
      expect(existsSync(entryOf(home))).toBe(true);
      expect(calls(npx.log)).toHaveLength(0);
    }, 60_000);

    it('does not install through a link where the copies are kept, and goes on to npx', async () => {
      const npm = fakeNpm();
      const npx = fakeNpx('printf "%s" "{}"; exit 0');
      const home = newHome();
      const elsewhere = mkdtempSync(join(tmpdir(), 'stroq-elsewhere-'));
      chmodSync(elsewhere, 0o755);
      symlinkSync(elsewhere, join(home, 'plugin-cli'));
      const r = await runWithCopy(preBash('ls'), npm, npx, home);
      expect(r.code).toBe(0);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
      expect(calls(npx.log)).toHaveLength(1);
    }, 60_000);
  });

  it('makes the home it does not find readable by its owner only', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'stroq-fresh-parent-'));
    const home = join(parent, 'fresh');
    await runWithCopy(preBash('ls'), fakeNpm(), fakeNpx('exit 1'), home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'plugin-cli')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'plugin-tmp')).mode & 0o777).toBe(0o700);
  }, 60_000);

  it('narrows the directories it keeps things in when they are already there and open', async () => {
    const home = newHome();
    for (const name of ['plugin-cli', 'plugin-tmp']) {
      mkdirSync(join(home, name));
      chmodSync(join(home, name), 0o755);
    }
    await runWithCopy(preBash('ls'), fakeNpm(), fakeNpx('exit 1'), home);
    expect(statSync(join(home, 'plugin-cli')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'plugin-tmp')).mode & 0o777).toBe(0o700);
  }, 60_000);

  it('points at the copy when stroq on it fails', async () => {
    const npm = fakeNpm();
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), home, { STUB_EXIT: '3' });
    expect(r.stderr).toContain(copyOf(home));
    expect(r.stderr).toContain('delete');
  }, 60_000);

  it('goes straight to the newest release when npm says the pin is not there yet', async () => {
    const npm = fakeNpm({
      before:
        "echo 'npm error code ETARGET' >&2; echo 'npm error notarget No matching version found' >&2; exit 1",
    });
    const npx = fakeNpx(`case "$*" in
  *'@stroq/cli@latest'*) printf '%s' '{}'; exit 0 ;;
  *) ${ETARGET_STDERR} ;;
esac`);
    const r = await runWithCopy(preBash('ls'), npm, npx, newHome());
    expect(r.code).toBe(0);
    const seen = calls(npx.log);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('@stroq/cli@latest');
  }, 60_000);

  it('takes a deadline that is not a plain number for the default one', async () => {
    for (const deadline of ['08', 'abc', '3.5', '-1', '', '99999999999999999999']) {
      const r = await runWithCopy(preBash('ls'), fakeNpm(), fakeNpx('exit 1'), newHome(), {
        STROQ_PLUGIN_NPX_DEADLINE: deadline,
      });
      expect(r, deadline).toMatchObject({ code: 0, stdout: ALLOWED });
    }
  }, 120_000);

  it('does not print what an untrusted package.json says about its version as it is', async () => {
    const npm = fakeNpm({ version: '9.9.9\\u001b[31mHACKED' });
    const r = await runWithCopy(preBash('ls'), npm, fakeNpx('printf "%s" "{}"; exit 0'), newHome());
    expect(r.stderr).not.toContain('\u001b');
    expect(r.stderr).toContain('9.9.9');
  }, 60_000);

  // npm answers ETARGET from a packument it cached before the pin was published when it is told
  // to prefer what it has, without asking the registry, and the wrapper took that for "the pin is
  // not there" and ran the newest release, which is not the pin.
  it('does not ask npm to trust a cached idea of what the registry has', async () => {
    const npm = fakeNpm({
      before: 'case "$*" in *--prefer-offline*) echo "npm error code ETARGET" >&2; exit 1 ;; esac',
    });
    const npx = fakeNpx('exit 1');
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, npx, home);
    expect(r).toMatchObject({ code: 0, stdout: ALLOWED });
    expect(existsSync(entryOf(home))).toBe(true);
    expect(calls(npx.log)).toHaveLength(0);
  }, 60_000);

  // The pinned attempt gets what the install left of the deadline, not a deadline of its own:
  // after an install that used three seconds of five, an npx that hangs is ended at five.
  it('gives npx what the install left of the deadline', async () => {
    const npm = fakeNpm({ before: 'sleep 3; echo "npm error code E503" >&2; exit 1' });
    const npx = fakeNpx('sleep 30 & echo $! > "$(dirname "$0")/sleeper.pid"; wait');
    const started = Date.now();
    const r = await runWithCopy(preBash('ls'), npm, npx, newHome(), {
      STROQ_PLUGIN_NPX_DEADLINE: '5',
    });
    expect(r.code).toBe(2);
    expect(Date.now() - started).toBeLessThan(7_000);
  }, 30_000);

  it('does not use a tree that has no way to start stroq in it', async () => {
    const npm = fakeNpm({ entry: false });
    const npx = fakeNpx('printf "%s" "{}"; exit 0');
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, npx, home);
    expect(r.code).toBe(0);
    expect(existsSync(copyOf(home))).toBe(false);
    expect(calls(npx.log)).toHaveLength(1);
  }, 60_000);

  // Another hook can put a copy there between the check and the move; `mv` then puts the tree
  // inside it. A `mv` that does exactly that, so that the race is not left to chance.
  it('drops its own tree when another hook put a copy where it was about to', async () => {
    const npm = fakeNpm();
    const shim = mkdtempSync(join(tmpdir(), 'stroq-mv-shim-'));
    writeFileSync(
      join(shim, 'mv'),
      `#!/bin/sh
case "$2" in
  */plugin-cli/*)
    mkdir -p "$2/node_modules/@stroq/cli/dist"
    cp "${join(npm.dir, 'stub-cli.js')}" "$2/node_modules/@stroq/cli/dist/index.js"
    printf '{"name":"@stroq/cli","version":"${PIN}"}' > "$2/node_modules/@stroq/cli/package.json" ;;
esac
exec /bin/mv "$@"
`,
    );
    chmodSync(join(shim, 'mv'), 0o755);
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), home, {}, `${shim}:`);
    expect(r).toMatchObject({ code: 0, stdout: ALLOWED });
    expect(existsSync(entryOf(home))).toBe(true);
    expect(readdirSync(copyOf(home))).not.toContain('stage');
  }, 60_000);

  it('says so, and goes on to npx, when it cannot move the copy into place', async () => {
    const shim = mkdtempSync(join(tmpdir(), 'stroq-mv-shim-'));
    writeFileSync(join(shim, 'mv'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(shim, 'mv'), 0o755);
    const npx = fakeNpx('printf "%s" "{}"; exit 0');
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), fakeNpm(), npx, home, {}, `${shim}:`);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('could not move');
    expect(existsSync(copyOf(home))).toBe(false);
    expect(calls(npx.log)).toHaveLength(1);
  }, 60_000);

  // With no time at all there is nothing to install with and nothing to start npx with.
  it('runs neither npm nor npx when the deadline is nought', async () => {
    const npm = fakeNpm();
    const npx = fakeNpx('exit 0');
    const home = newHome();
    const pre = await runWithCopy(preBash('ls'), npm, npx, home, {
      STROQ_PLUGIN_NPX_DEADLINE: '0',
    });
    expect(pre.code).toBe(2);
    const post = await runWithCopy(postRead, npm, npx, home, { STROQ_PLUGIN_NPX_DEADLINE: '0' });
    expect(post.code).toBe(0);
    expect(calls(npm.log)).toHaveLength(0);
    expect(calls(npx.log)).toHaveLength(0);
  }, 60_000);

  // The default home, which is what every real run uses: the tests above name STROQ_HOME.
  it('keeps the copy under ~/.stroq when only HOME is set', async () => {
    const home = newHome();
    const r = await runWithCopy(preBash('ls'), fakeNpm(), fakeNpx('exit 1'), '', {
      STROQ_HOME: '',
      HOME: home,
    });
    expect(r).toMatchObject({ code: 0, stdout: ALLOWED });
    expect(existsSync(join(home, '.stroq', 'plugin-cli', PIN))).toBe(true);
  }, 60_000);

  // Stroq takes the project's directory from the event, so where it runs matters to nothing but
  // the node that starts it: a version manager that picks the node by directory (asdf, nodenv,
  // volta) must not pick it by the project's.
  it('runs the copy from its own directory, not from the project', async () => {
    const npm = fakeNpm();
    const home = newHome();
    await runWithCopy(preBash('ls'), npm, fakeNpx('exit 1'), home);
    const where = readFileSync(`${npm.stubLog}.cwd`, 'utf8').trim();
    expect(where.startsWith(realpathSync(copyOf(home)))).toBe(true);
    expect(where).not.toBe(realpathSync(cliDir));
  }, 60_000);

  it('turns the copy off for 1 and for nothing else', async () => {
    const npm = fakeNpm();
    const npx = fakeNpx('exit 1');
    const r = await runWithCopy(preBash('ls'), npm, npx, newHome(), {
      STROQ_PLUGIN_NO_LOCAL_COPY: '0',
    });
    expect(r).toMatchObject({ code: 0, stdout: ALLOWED });
    expect(calls(npm.log)).toHaveLength(1);
  }, 60_000);

  // npx has no deadline of its own, and neither has npm: the install shares the one that
  // bounds the whole path, and ends everything it started.
  describe('when the registry does not answer', () => {
    const SLOW = 'sleep 30 & echo $! > "$(dirname "$0")/sleeper.pid"; wait';

    it('ends a hung install at the deadline and blocks a PreToolUse', async () => {
      const npm = fakeNpm({ before: SLOW });
      const npx = fakeNpx('exit 1');
      const home = newHome();
      const started = Date.now();
      const r = await runWithCopy(preBash('ls'), npm, npx, home, {
        STROQ_PLUGIN_NPX_DEADLINE: '2',
      });
      expect(r.code).toBe(2);
      expect(Date.now() - started).toBeLessThan(9_000);
      // The deadline was used up: there was no time left to start npx.
      expect(calls(npx.log)).toHaveLength(0);
      const pid = Number(readFileSync(join(npm.dir, 'sleeper.pid'), 'utf8').trim());
      await new Promise((done) => setTimeout(done, 1_500));
      expect(() => process.kill(pid, 0)).toThrow();
    }, 30_000);

    it('lets a PostToolUse through when the install hangs', async () => {
      const npm = fakeNpm({ before: SLOW });
      const home = newHome();
      const started = Date.now();
      const r = await runWithCopy(postRead, npm, fakeNpx('exit 1'), home, {
        STROQ_PLUGIN_NPX_DEADLINE: '2',
      });
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(9_000);
    }, 30_000);
  });
});
