import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
 * (Seatbelt) with srt 0.0.77 on 2026-10-10: with `allowWrite` naming a directory and `denyWrite`
 * naming paths inside it, `denyWrite` wins; a write to a denied file that does not exist yet fails
 * with "Operation not permitted" and leaves nothing behind; a file cannot be made inside a denied
 * directory that exists; `mkdir` of a denied directory that does not exist yet fails, and so does
 * `mkdir -p` below it; the rest of the allowed directory stays writable.
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
