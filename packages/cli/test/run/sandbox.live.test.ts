import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cliDirIn,
  keysDirIn,
  openclawPluginDirIn,
  pluginCliDirIn,
  policyFileIn,
  secretsFileIn,
  storeDirIn,
} from '../../src/paths.js';
import { SRT_BIN, generateSandbox, srtArgv } from '../../src/run/sandbox.js';
import { binOnPath } from '../../src/run/which.js';

/**
 * The generated config against the real `srt`, to see it enforced and not only written.
 *
 * Opt in with `STROQ_LIVE_SRT=1` and `srt` on `PATH` (`npm install -g @anthropic-ai/sandbox-runtime`);
 * otherwise this file is skipped, as it is in CI, which has no `srt` to run and would not be
 * allowed to start a sandbox inside its own. The one command that runs it:
 *
 *     STROQ_LIVE_SRT=1 PATH="$(dirname "$(command -v srt)"):$PATH" pnpm vitest run packages/cli/test/run/sandbox.live.test.ts
 *
 * What it reproduces is what `protectedState` in `run/sandbox.ts` rests on, measured on macOS
 * (Seatbelt, an APFS volume that does not tell upper case from lower) with srt 0.0.77 on 2026-10-10:
 * with `allowWrite` naming a directory and `denyWrite` naming paths inside it, `denyWrite` wins; a
 * write to a denied file that does not exist yet fails with "Operation not permitted" and leaves
 * nothing behind, however its name is cased (`POLICY.YAML`, `Policy.yaml`); a file cannot be made
 * inside a denied directory that exists; `mkdir` of a denied directory that does not exist yet fails,
 * however it is cased (`STORE`), and so does `mkdir -p` below it; a hard link to a denied file that
 * exists fails; moving a fresh file onto the name of a denied path that does not exist yet fails;
 * a symbolic link to such a name can be made, and a write through it fails; the denied file that exists
 * stays as it was; the rest of the allowed directory stays writable.
 *
 * The config is made by `generateSandbox` itself, for a Stroq home in a directory under
 * `os.tmpdir()` that is NOT resolved first: on a Mac that is `/var/folders/…`, a link to
 * `/private/var/folders/…`, and a denied path that does not exist yet is matched there by its real
 * path only. The generator resolves the home, and this is the test that it has to.
 *
 * Only inert marker text is written, to files made for it under a directory made for it. Nothing
 * here deletes anything outside that directory, runs a payload, or touches the network.
 *
 * Linux (bubblewrap) is not measured: its behaviour for a denied path that does not exist is only
 * what srt's README says, and the config is different there (see `protectedState`).
 */

const srt = process.env['STROQ_LIVE_SRT'] === '1' ? binOnPath(SRT_BIN) : null;
const measurable = srt !== null && process.platform === 'darwin';

/**
 * The version of the package `srt` belongs to. Not `srt --version`: outside of npm that prints a
 * fixed `1.0.0` whatever is installed (`.version(process.env.npm_package_version || '1.0.0')`).
 */
function srtVersion(): string {
  try {
    let dir = dirname(realpathSync(srt as string));
    for (let up = 0; up < 4; up += 1, dir = dirname(dir)) {
      const file = join(dir, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === '@anthropic-ai/sandbox-runtime' && typeof pkg.version === 'string')
        return pkg.version;
    }
  } catch {
    // An install that cannot be read is a version that is not known.
  }
  return 'of a version that is not known';
}

describe.skipIf(!measurable)(
  `the generated config, enforced by srt ${measurable ? srtVersion() : ''}`,
  () => {
    // Made in `beforeAll`: a skipped suite is still read, and must not leave a directory behind.
    let root = '';
    let work = '';
    let home = '';
    let settingsFile = '';

    /** One command in the sandbox: `sh -c script sh args…`, so that paths are arguments and not text. */
    function inSandbox(script: string, ...args: string[]) {
      const result = spawnSync(
        srt as string,
        srtArgv(settingsFile, 'sh', ['-c', script, 'sh', ...args]),
        {
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    }

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'stroq-live-srt-'));
      work = join(root, 'work');
      home = join(root, 'user', '.stroq');
      settingsFile = join(root, 'srt-settings.json');
      mkdirSync(work, { recursive: true });
      mkdirSync(join(home, 'sessions'), { recursive: true });
      // Two of the protected names exist, as they do in a used home; the rest do not yet.
      writeFileSync(secretsFileIn(home), 'seed');
      mkdirSync(cliDirIn(home));
      const { settings } = generateSandbox({
        workspace: work,
        stroqHome: home,
        userHome: join(root, 'user'),
        tmp: [],
        agentState: [],
        secretPaths: [],
        allowedDomains: [],
      });
      writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    });

    afterAll(() => {
      if (root !== '') rmSync(root, { recursive: true, force: true });
    });

    it('lets a write in the allowed area through: the workspace, and the state the hooks write', () => {
      for (const target of [join(work, 'ok.txt'), join(home, 'sessions', 'ok.txt')]) {
        const run = inSandbox('printf marker > "$1"', target);
        expect(run.status, `${target}: ${run.stderr}`).toBe(0);
        expect(readFileSync(target, 'utf8')).toBe('marker');
      }
    });

    it('denies a write to a protected file that does not exist yet, and makes no placeholder', () => {
      for (const target of [policyFileIn(home), join(home, 'bindings.yaml')]) {
        const run = inSandbox('printf marker > "$1"', target);
        expect(run.status, target).not.toBe(0);
        expect(run.stderr, target).toContain('Operation not permitted');
        expect(existsSync(target), `a placeholder at ${target}`).toBe(false);
      }
    });

    it('denies a write to a protected file that exists, and leaves what is in it', () => {
      const run = inSandbox('printf marker > "$1"', secretsFileIn(home));
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('Operation not permitted');
      expect(readFileSync(secretsFileIn(home), 'utf8')).toBe('seed');
    });

    it('denies a file made inside a protected directory that exists', () => {
      const target = join(cliDirIn(home), 'injected.js');
      const run = inSandbox('printf marker > "$1"', target);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('Operation not permitted');
      expect(existsSync(target)).toBe(false);
    });

    it('denies making a protected directory that does not exist yet, and one below it', () => {
      for (const target of [keysDirIn(home), pluginCliDirIn(home), openclawPluginDirIn(home)]) {
        const plain = inSandbox('mkdir "$1"', target);
        expect(plain.status, target).not.toBe(0);
        expect(plain.stderr, target).toContain('Operation not permitted');
        const deep = inSandbox('mkdir -p "$1/0.0.0/node_modules"', target);
        expect(deep.status, `${target}/…`).not.toBe(0);
        expect(existsSync(target), `a placeholder at ${target}`).toBe(false);
      }
    });

    // The volume this was measured on does not tell `POLICY.YAML` from `policy.yaml`; on one that does, they
    // are two names and only the second is denied, so there is nothing to measure.
    function caseInsensitive(): boolean {
      const probe = join(work, 'Case-Probe.txt');
      writeFileSync(probe, 'probe');
      return existsSync(join(work, 'case-probe.txt'));
    }

    it('denies a write to a protected file that does not exist yet under another case, and makes none', (ctx) => {
      if (!caseInsensitive()) ctx.skip();
      for (const name of ['POLICY.YAML', 'Policy.yaml']) {
        const target = join(home, name);
        const run = inSandbox('printf marker > "$1"', target);
        expect(run.status, name).not.toBe(0);
        expect(run.stderr, name).toContain('Operation not permitted');
        expect(readdirSync(home), name).not.toContain(name);
        expect(existsSync(policyFileIn(home)), 'policy.yaml appeared').toBe(false);
      }
    });

    it('denies making a protected directory that does not exist yet under another case', (ctx) => {
      if (!caseInsensitive()) ctx.skip();
      const target = join(home, 'STORE');
      const run = inSandbox('mkdir "$1"', target);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('Operation not permitted');
      expect(existsSync(storeDirIn(home)), 'store appeared').toBe(false);
      expect(readdirSync(home)).not.toContain('STORE');
    });

    it('denies a hard link to a protected file that exists, and leaves what is in it', () => {
      const alias = join(work, 'alias-of-secrets');
      const run = inSandbox('ln "$1" "$2"', secretsFileIn(home), alias);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('Operation not permitted');
      expect(existsSync(alias), 'a link to the file').toBe(false);
      expect(readFileSync(secretsFileIn(home), 'utf8')).toBe('seed');
    });

    it('denies moving a fresh file onto the name of a protected file that does not exist yet', () => {
      const fresh = join(work, 'fresh-policy.yaml');
      writeFileSync(fresh, 'marker');
      const run = inSandbox('mv "$1" "$2"', fresh, policyFileIn(home));
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('Operation not permitted');
      expect(existsSync(policyFileIn(home)), 'policy.yaml appeared').toBe(false);
      expect(readFileSync(fresh, 'utf8'), 'the fresh file stays where it was').toBe('marker');
    });

    // A link to a name that is denied but not there is made in the workspace, which is writable: the
    // link is not the file. Writing through it is, and it fails.
    it('lets a symbolic link to a protected name that does not exist yet be made, and denies writing through it', () => {
      const link = join(work, 'link-to-bindings');
      const made = inSandbox('ln -s "$1" "$2"', join(home, 'bindings.yaml'), link);
      expect(made.status, made.stderr).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      const run = inSandbox('printf marker > "$1"', link);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('Operation not permitted');
      expect(existsSync(join(home, 'bindings.yaml')), 'bindings.yaml appeared').toBe(false);
    });

    it('leaves the protected file that exists as it was after all of that', () => {
      expect(readFileSync(secretsFileIn(home), 'utf8')).toBe('seed');
      expect(readdirSync(cliDirIn(home))).toEqual([]);
    });

    // Why a home with `[` in its path is refused as a write root (`hasGlobSyntax`): srt reads the characters
    // `* ? [ ]` in `denyRead` and `denyWrite` as a pattern, so a deny for `[x]/f` is one for `x/f`, and the file
    // at the path as written is neither unreadable nor unwritable. If a later srt reads the path as written, this
    // fails, and the refusal can go.
    it('reads a bracket in a denied path as a pattern: the file at the path as written is not denied', () => {
      const bracket = join(work, '[x]');
      const matched = join(work, 'x');
      for (const dir of [bracket, matched]) {
        mkdirSync(dir);
        writeFileSync(join(dir, 'secret.txt'), 'seed');
      }
      const settings = join(root, 'srt-pattern.json');
      writeFileSync(
        settings,
        JSON.stringify({
          filesystem: {
            denyRead: [join(bracket, 'secret.txt')],
            denyWrite: [join(bracket, 'secret.txt')],
            allowWrite: [work],
          },
          network: { allowedDomains: [], deniedDomains: [] },
        }),
      );
      const asInSandbox = (script: string, target: string) =>
        spawnSync(srt as string, srtArgv(settings, 'sh', ['-c', script, 'sh', target]), {
          encoding: 'utf8',
          timeout: 30_000,
        });
      // The path the pattern matches is denied, for reading and for writing.
      expect(asInSandbox('cat "$1"', join(matched, 'secret.txt')).status).not.toBe(0);
      const wrote = asInSandbox('printf marker > "$1"', join(matched, 'secret.txt'));
      expect(wrote.status).not.toBe(0);
      expect(wrote.stderr).toContain('Operation not permitted');
      expect(readFileSync(join(matched, 'secret.txt'), 'utf8')).toBe('seed');
      // The path as written is not.
      expect(asInSandbox('cat "$1"', join(bracket, 'secret.txt')).stdout).toBe('seed');
      expect(asInSandbox('printf marker > "$1"', join(bracket, 'secret.txt')).status).toBe(0);
      expect(readFileSync(join(bracket, 'secret.txt'), 'utf8')).toBe('marker');
    });

    it('leaves the rest of the allowed area writable after all of that', () => {
      const target = join(home, 'sessions', 'after.txt');
      const run = inSandbox(
        'mkdir -p "$1" && printf marker > "$1/f"',
        join(home, 'sessions', 'new'),
      );
      expect(run.status, run.stderr).toBe(0);
      expect(inSandbox('printf marker > "$1"', target).status).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe('marker');
    });
  },
);

// The platform it was measured on is the only one it is run on; saying so keeps a green run on
// Linux from reading as a measurement.
describe.skipIf(srt === null || process.platform === 'darwin')(
  'on a platform that is not macOS',
  () => {
    it.todo(
      'is not measured here: srt on Linux is bubblewrap, and what it does for a denied path that is absent is its README’s word',
    );
  },
);
