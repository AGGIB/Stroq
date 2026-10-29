import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OTHER_VERSION_KEPT_MS,
  enableCompileCache,
  makeCompileCacheRoot,
  type CompileCacheHost,
} from '../src/compile-cache.js';
import { stroqVersion } from '../src/version.js';
import { CLI_ENTRY } from './helpers/cli-entry.js';

/**
 * Node's compile cache holds V8's compiled code, which Node runs as the module. A CRC32 of the
 * source keeps a stale entry out, but it is no signature, so whoever can write the cache can put
 * code into the firewall. These pin that it is used only where it is as protected as `policy.yaml`
 * (the default home, real folders, this user's, written by no one else) and that anything else, or
 * a cache that cannot be made, runs uncached without an error.
 */
const POSIX = process.platform !== 'win32';
const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const UID = process.getuid?.() ?? 0;
const version = (): string => '0.28.0';

/** The default Stroq home of a user home of its own, made the way a hook makes it. */
let home: string;
/** Where the running code is: a folder this user can write. */
let code: string;

beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), 'stroq-compile-cache-'))), '.stroq');
  mkdirSync(home, { mode: 0o700 });
  code = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-compile-cache-code-')));
});

/**
 * A host whose `enableCompileCache` records the folder it was given and makes Node's own folder in
 * it, as Node does, with whatever umask is in force; `home` is the default home.
 */
function recorder(over: Partial<CompileCacheHost> = {}): CompileCacheHost & {
  readonly enabled: string[];
} {
  const enabled: string[] = [];
  return {
    enabled,
    enable: (dir: string) => {
      enabled.push(dir);
      mkdirSync(join(dir, NODE_FOLDER), { recursive: true });
      return { status: 1, directory: dir };
    },
    uid: UID,
    defaultHome: home,
    codeDir: code,
    env: {},
    now: () => NOW,
    ...over,
  };
}

const NODE_FOLDER = 'v26.7.0-arm64-0-501';

const cacheDir = (): string => join(home, 'compile-cache', '0.28.0');
const scratch = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const aged = (path: string, ms: number): void => {
  const when = new Date(NOW - ms);
  utimesSync(path, when, when);
};

describe.skipIf(!POSIX)('the compile cache', () => {
  it('is turned on in a folder of this version under the default home', () => {
    const host = recorder();
    expect(enableCompileCache(home, version, host)).toBe(cacheDir());
    expect(host.enabled).toEqual([cacheDir()]);
  });

  it('makes its two folders readable by their owner alone', () => {
    enableCompileCache(home, version, recorder());
    expect(statSync(join(home, 'compile-cache')).mode & 0o777).toBe(0o700);
    expect(statSync(cacheDir()).mode & 0o777).toBe(0o700);
  });

  it('has Node make its own folder 0700, whatever the umask', () => {
    const before = process.umask(0o002);
    try {
      enableCompileCache(home, version, recorder());
    } finally {
      process.umask(before);
    }
    expect(statSync(join(cacheDir(), NODE_FOLDER)).mode & 0o777).toBe(0o700);
    expect(process.umask()).toBe(before);
  });

  it('is turned on again in the folder it made, with the folder Node made inside it', () => {
    enableCompileCache(home, version, recorder());
    chmodSync(join(cacheDir(), NODE_FOLDER), 0o755);
    expect(enableCompileCache(home, version, recorder())).toBe(cacheDir());
  });

  it('pays no mind to a plain file in the version folder, which Node never reads', () => {
    enableCompileCache(home, version, recorder());
    writeFileSync(join(cacheDir(), '.DS_Store'), '');
    expect(enableCompileCache(home, version, recorder())).toBe(cacheDir());
  });

  describe('is off, and the call runs uncached', () => {
    const off = (host: CompileCacheHost & { readonly enabled: string[] }, at = home): void => {
      expect(enableCompileCache(at, version, host)).toBeNull();
      expect(host.enabled).toEqual([]);
    };

    it('for a STROQ_HOME that is not the default one, a path the gate does not match', () => {
      const elsewhere = scratch('stroq-elsewhere-');
      off(recorder(), elsewhere);
      expect(existsSync(join(elsewhere, 'compile-cache'))).toBe(false);
    });

    it('when the cache folder is a link, even to a private folder of ours', () => {
      const real = scratch('stroq-compile-cache-real-');
      chmodSync(real, 0o700);
      symlinkSync(real, join(home, 'compile-cache'));
      off(recorder());
      expect(readdirSync(real)).toEqual([]);
    });

    it('when the version folder is a link', () => {
      mkdirSync(join(home, 'compile-cache'), { mode: 0o700 });
      const real = scratch('stroq-compile-cache-real-');
      chmodSync(real, 0o700);
      symlinkSync(real, cacheDir());
      off(recorder());
    });

    it('when what stands inside the version folder is a link', () => {
      enableCompileCache(home, version, recorder({ enable: () => ({ status: 1 }) }));
      symlinkSync(scratch('stroq-compile-cache-real-'), join(cacheDir(), NODE_FOLDER));
      off(recorder());
    });

    it('when the home itself is a link', () => {
      const link = join(scratch('stroq-compile-cache-link-'), '.stroq');
      symlinkSync(home, link);
      off(recorder({ defaultHome: link }), link);
    });

    it('when the cache folder can be written by the group, and it is not repaired', () => {
      mkdirSync(join(home, 'compile-cache'));
      chmodSync(join(home, 'compile-cache'), 0o770);
      off(recorder());
      expect(statSync(join(home, 'compile-cache')).mode & 0o777).toBe(0o770);
      expect(existsSync(cacheDir())).toBe(false);
    });

    it('when the cache folder can be read by others: Stroq makes it 0700', () => {
      mkdirSync(join(home, 'compile-cache'));
      chmodSync(join(home, 'compile-cache'), 0o755);
      off(recorder());
    });

    it('when the version folder can be written by others', () => {
      enableCompileCache(home, version, recorder());
      chmodSync(cacheDir(), 0o707);
      off(recorder());
    });

    it('when what Node made inside it can be written by the group', () => {
      enableCompileCache(home, version, recorder());
      chmodSync(join(cacheDir(), NODE_FOLDER), 0o775);
      off(recorder());
    });

    it('when this user cannot write the code it would cache (a root-owned install)', () => {
      chmodSync(code, 0o500);
      try {
        off(recorder());
      } finally {
        chmodSync(code, 0o700);
      }
      expect(existsSync(join(home, 'compile-cache'))).toBe(false);
    });

    it('when the environment turned it off, and nothing is made', () => {
      off(recorder({ env: { NODE_DISABLE_COMPILE_CACHE: '1' } }));
      expect(existsSync(join(home, 'compile-cache'))).toBe(false);
    });

    it('when the environment named a folder of its own, which Node already uses', () => {
      off(recorder({ env: { NODE_COMPILE_CACHE: '/somewhere/else' } }));
      expect(existsSync(join(home, 'compile-cache'))).toBe(false);
    });

    it('when the version is not a version, which could name a folder elsewhere', () => {
      for (const bad of ['../escape', '0.28.0/..', '', 'latest']) {
        const host = recorder();
        expect(
          enableCompileCache(home, () => bad, host),
          bad,
        ).toBeNull();
        expect(host.enabled).toEqual([]);
      }
      expect(existsSync(join(home, 'escape'))).toBe(false);
    });

    it('when Node answers that it did not turn it on in this folder', () => {
      for (const status of [0, 2, 3]) off(recorder({ enable: () => ({ status }) }));
    });

    it('when the home can be written by the group', () => {
      chmodSync(home, 0o770);
      off(recorder());
    });

    it('when the folders belong to another user', () => {
      off(recorder({ uid: UID + 1 }));
    });

    it('where there is no user id to compare (Windows)', () => {
      off(recorder({ uid: undefined }));
    });

    it('on a Node without one (22.0)', () => {
      off(recorder({ enable: undefined }));
      expect(existsSync(join(home, 'compile-cache'))).toBe(false);
    });

    it('where there is no home yet: the cache is never the reason one exists', () => {
      const none = join(scratch('stroq-compile-cache-none-'), '.stroq');
      off(recorder({ defaultHome: none }), none);
      expect(existsSync(none)).toBe(false);
    });

    it('when the home is a file', () => {
      const file = join(scratch('stroq-compile-cache-file-'), '.stroq');
      writeFileSync(file, '');
      off(recorder({ defaultHome: file }), file);
    });

    it('when the version cannot be read', () => {
      const host = recorder();
      const unreadable = (): string => {
        throw new Error('no package.json');
      };
      expect(enableCompileCache(home, unreadable, host)).toBeNull();
      expect(host.enabled).toEqual([]);
    });

    it('when Node throws', () => {
      const refusing = recorder({
        enable: () => {
          throw new Error('ENOSPC');
        },
      });
      expect(enableCompileCache(home, version, refusing)).toBeNull();
    });
  });

  describe('the folders of other versions', () => {
    const root = (): string => join(home, 'compile-cache');
    const other = (name: string, ageMs: number): string => {
      const dir = join(root(), name);
      mkdirSync(join(dir, 'v26.7.0-arm64-0-501'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'v26.7.0-arm64-0-501', 'entry'), 'x');
      aged(join(dir, 'v26.7.0-arm64-0-501'), ageMs);
      aged(dir, ageMs);
      return dir;
    };
    beforeEach(() => {
      mkdirSync(root(), { mode: 0o700 });
    });

    it('removes one nothing has added to for longer than a week, when a new version first runs', () => {
      other('0.27.0', OTHER_VERSION_KEPT_MS + 60_000);
      enableCompileCache(home, version, recorder());
      expect(readdirSync(root())).toEqual(['0.28.0']);
    });

    it('keeps one in use this week: two versions can run side by side', () => {
      other('0.27.0', OTHER_VERSION_KEPT_MS - 60_000);
      enableCompileCache(home, version, recorder());
      expect(readdirSync(root()).sort()).toEqual(['0.27.0', '0.28.0']);
    });

    it('reads when one was last used from what Node wrote into it, not from when it was made', () => {
      const dir = other('0.27.0', OTHER_VERSION_KEPT_MS * 10);
      aged(join(dir, 'v26.7.0-arm64-0-501'), 60_000);
      enableCompileCache(home, version, recorder());
      expect(readdirSync(root()).sort()).toEqual(['0.27.0', '0.28.0']);
    });

    it('looks at them only when this version is new, not on every call', () => {
      mkdirSync(cacheDir(), { mode: 0o700 });
      other('0.27.0', OTHER_VERSION_KEPT_MS * 10);
      enableCompileCache(home, version, recorder());
      expect(readdirSync(root()).sort()).toEqual(['0.27.0', '0.28.0']);
    });

    it('touches nothing that is not named like a version, and no link', () => {
      const notOurs = join(root(), 'notes');
      mkdirSync(notOurs);
      aged(notOurs, OTHER_VERSION_KEPT_MS * 10);
      const target = scratch('stroq-compile-cache-target-');
      writeFileSync(join(target, 'keep'), 'x');
      symlinkSync(target, join(root(), '0.1.0'));
      enableCompileCache(home, version, recorder());
      expect(readdirSync(root()).sort()).toEqual(['0.1.0', '0.28.0', 'notes']);
      expect(readdirSync(target)).toEqual(['keep']);
    });
  });

  describe('the folder a sandboxed launch makes first', () => {
    it('is made 0700, with the home when there is none', () => {
      const fresh = join(scratch('stroq-compile-cache-fresh-'), '.stroq');
      makeCompileCacheRoot(fresh);
      expect(statSync(join(fresh, 'compile-cache')).mode & 0o777).toBe(0o700);
    });

    it('leaves one that is there as it is, to be refused rather than trusted', () => {
      mkdirSync(join(home, 'compile-cache'));
      chmodSync(join(home, 'compile-cache'), 0o775);
      makeCompileCacheRoot(home);
      expect(statSync(join(home, 'compile-cache')).mode & 0o777).toBe(0o775);
      expect(enableCompileCache(home, version, recorder())).toBeNull();
    });
  });
});

describe.skipIf(!POSIX)('the built CLI', () => {
  /** Starts it with `HOME` set so that `home` is the default Stroq home, and without the tests' cache. */
  const start = (args: readonly string[], input = '', stroqHome?: string): void => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(home, '..') };
    delete env['STROQ_HOME'];
    if (stroqHome !== undefined) env['STROQ_HOME'] = stroqHome;
    delete env['NODE_COMPILE_CACHE'];
    delete env['NODE_DISABLE_COMPILE_CACHE'];
    execFileSync(process.execPath, [CLI_ENTRY, ...args], { env, input, stdio: 'pipe' });
  };
  const event = JSON.stringify({
    session_id: 'compile-cache',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  const supported =
    typeof (module as { enableCompileCache?: unknown }).enableCompileCache === 'function';

  it.skipIf(!supported)('keeps the compiled code of a hook call under the default home', () => {
    start(['hook', 'claude-code'], event);
    const ours = join(home, 'compile-cache', stroqVersion());
    // Node's own folder inside it (`v<node>-<arch>-<flags>-<uid>`), with entries in it.
    const [node] = readdirSync(ours);
    expect(node).toMatch(/^v\d+/);
    expect(readdirSync(join(ours, node as string)).length).toBeGreaterThan(0);
  });

  it('keeps none under a STROQ_HOME elsewhere', () => {
    const elsewhere = scratch('stroq-compile-cache-elsewhere-');
    start(['hook', 'claude-code'], event, elsewhere);
    expect(existsSync(join(elsewhere, 'compile-cache'))).toBe(false);
  });

  it('leaves nothing behind for a command a person runs', () => {
    start(['--version']);
    expect(existsSync(join(home, 'compile-cache'))).toBe(false);
  });
});
