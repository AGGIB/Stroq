import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  backupsDirIn,
  bindingsFileIn,
  canaryFilesFileIn,
  cliDirIn,
  hardenDirIn,
  installRecordFileIn,
  keysDirIn,
  liveDirIn,
  openclawPluginDirIn,
  passportsFileIn,
  pluginCliDirIn,
  policyFileIn,
  secretsFileIn,
  storeDirIn,
  tasksDirIn,
  trustFileIn,
} from '../paths.js';

/**
 * The srt configuration `stroq run --sandbox` generates, and why it is generated
 * rather than left to srt's defaults.
 *
 * Anthropic's `@anthropic-ai/sandbox-runtime` is the sandbox: `sandbox-exec` on
 * macOS, bubblewrap on Linux, a dedicated account plus WFP filters on Windows. Stroq
 * shells out to its `srt` binary and does not link the library — the programmatic API
 * exists, but the package carries four runtime dependencies, and a sandbox that is
 * genuinely optional must not be able to become a required install.
 *
 * Its built-in defaults are not the config a coding agent wants, measured against
 * 0.0.77: network is denied, writes are denied EVERYWHERE — the working directory
 * included, so an agent cannot edit the code it was started on — and reads are
 * allowed everywhere, with an empty `denyRead`. The widely repeated claim that "the
 * sandbox blocks `~/.ssh` and `.env`" describes Claude Code's configuration of it,
 * not srt's defaults. So this file writes a config, and every entry below is a choice
 * with a reason.
 *
 * The read-deny list is the part neither tool could produce alone. srt's own docs
 * name its limitation — "domain filtering operates at the allowlist level without
 * inspecting traffic contents", so a broad allowlist such as `github.com` can carry
 * an exfiltration out — because a sandbox has no notion of intent. Stroq's secret
 * index does: it already knows which files on THIS machine actually hold
 * credentials, because it reads them to hash their values. Feeding those paths into
 * `denyRead` makes the deny list the machine's real credential files rather than a
 * guessed list of well-known ones. The index stores hashes and paths; paths are all
 * this needs, so nothing new is stored and no value leaves it.
 */

export interface SrtSettings {
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly denyWrite: readonly string[];
    readonly allowWrite: readonly string[];
  };
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
  };
}

export interface SandboxInputs {
  /** The directory the agent is started in; the code it is there to edit. */
  readonly workspace: string;
  /** `~/.stroq`: the audit chain, sessions and secret index the hooks write. */
  readonly stroqHome: string;
  /** The user's home, which is never itself a write root. */
  readonly userHome: string;
  /** Scratch space. Build tools that cannot write a temp file do not run. */
  readonly tmp: readonly string[];
  /** The agent's own state directory (`~/.claude`, `~/.codex`, …). */
  readonly agentState: readonly string[];
  /** The credential files `FileSecretIndex` indexes on this machine. */
  readonly secretPaths: readonly string[];
  /** Domains from `--allow-domain`. Empty is srt's deny-all, which is the default. */
  readonly allowedDomains: readonly string[];
}

export interface GeneratedSandbox {
  readonly settings: SrtSettings;
  /**
   * Write roots refused for being wide enough that granting them would not be a
   * sandbox, or, for the Stroq home, for a path that srt would read as a pattern (see
   * `hasGlobSyntax`). Returned rather than silently dropped: a caller that asked for one
   * has to be told it did not get it.
   */
  readonly refused: readonly string[];
  /**
   * The names of Stroq's own state that the agent can write although they are protected
   * names: those that are not in `denyWrite`, under a root it may write. On any platform but macOS
   * these are the names that do not exist when the config is made (srt would have to make a
   * placeholder for each), so a `policy.yaml` that is not there can be created during the run and
   * replaces the policy. Empty on macOS, where every name is listed. See `protectedState`.
   */
  readonly unprotected: readonly string[];
}

/**
 * What the config is made for: the platform it will be enforced on, a way to ask whether a path
 * exists and a way to resolve the symlinks of one that does. All default to the real ones, and a
 * test names them to cover the platforms it is not on.
 */
export interface SandboxHost {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  /** The path with its symlinks resolved; throws for a path that is not there. */
  readonly realpath?: (path: string) => string;
}

/**
 * Whether anything is at `path`, a link that points nowhere included: it is there, whatever it points
 * to, which `existsSync` would not say.
 */
export function somethingAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `path` with the symlinks of the part that exists resolved: the longest prefix `real` can resolve,
 * and the rest as written. A path that is not there cannot be resolved whole.
 */
function withLinksResolved(path: string, real: (path: string) => string): string {
  let head = path;
  let rest = '';
  for (;;) {
    try {
      const found = real(head);
      return rest === '' ? found : join(found, rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      rest = rest === '' ? basename(head) : join(basename(head), rest);
      head = parent;
    }
  }
}

const dedupe = (paths: readonly string[]): readonly string[] => [
  ...new Set(paths.filter((p) => p !== '').map((p) => resolve(p))),
];

/**
 * Whether srt would read `path` as a pattern: it reads `*`, `?`, `[` and `]` in `allowWrite`, `denyWrite`
 * and `denyRead` entries as glob syntax. Measured against srt 0.0.77 on macOS (2026-10-10): a `denyWrite`
 * and a `denyRead` entry for `w/[x]/secret.txt` protected `w/x/secret.txt`, the path the pattern matches,
 * and the file at the path as written could be read and overwritten; a backslash before each bracket made
 * no difference (`sandbox.live.test.ts` repeats it, opt-in). So an entry for such a path is not a deny,
 * whatever the config says.
 */
export const hasGlobSyntax = (path: string): boolean => /[*?[\]]/.test(path);

/** Whether a write root in `roots` is `path` or a directory above it. */
const writableUnder = (roots: readonly string[], path: string): boolean =>
  roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));

/**
 * A write root that would defeat the sandbox. `/` is the obvious one; the user's
 * home is the one that actually turns up, because every credential file this config
 * denies reading lives under it and an `allowWrite` there would hand back the
 * ability to overwrite them. `~/.stroq` and `~/.claude` are under home too and are
 * fine — the test is the root itself, not what is beneath it.
 */
const tooBroadToSandbox = (path: string, userHome: string): boolean =>
  path === resolve('/') || path === resolve(userHome);

/**
 * What under the Stroq home the agent must not rewrite, although the home is writable.
 *
 * The home is a write root because the hooks run INSIDE the sandbox and write the
 * sessions, the audit chain, the last-hook stamps, the log and the cloak dictionary
 * there. That also leaves the agent able to rewrite what the NEXT call is judged by (the
 * policy, the secret index, the trust and canary records, the install record) and the code
 * the hooks run (the copy of the CLI that `init` makes, the Claude Code plugin's pinned copy,
 * the OpenClaw plugin): a hook that points at a file the agent replaced runs the agent's code
 * as the firewall. Those go into `denyWrite`, and so do the places that features still to
 * come keep their own state (keys, live, harden, backups, store, passports, tasks, bindings),
 * so that the feature creating one is covered from its first file and not from the release
 * that remembers to add it. Every name comes from `paths.ts`, as the code that writes it gets
 * it, so that a rename there cannot leave one unprotected. The order is the order they are
 * written in, and it is pinned by a test.
 *
 * What stays writable, because the hooks write it: the session files (the taint and the
 * provenance), the audit chain and the last-hook stamps. `stroq untaint` is a plain removal of the
 * session files, so a program that none of the gate on Stroq's commands reads can do the same
 * from inside the sandbox; only that gate guards them.
 *
 * Measured against srt 0.0.77 on macOS (Seatbelt, an APFS volume that does not tell upper case from
 * lower), 2026-10-10, with `allowWrite` naming a directory and `denyWrite` naming paths inside it
 * (`sandbox.live.test.ts` repeats it, opt-in): `denyWrite` wins over `allowWrite`; a write to a denied
 * file that does not exist yet fails with "Operation not permitted" and creates nothing, whatever the
 * case of its name (`POLICY.YAML`, `Policy.yaml`); a file cannot be created inside a denied directory
 * that exists; `mkdir` of a denied directory that does not exist yet fails, whatever its case (`STORE`),
 * and so does `mkdir -p` below it; a hard link to a denied file that exists fails (`ln`); moving a fresh
 * file onto the name of a denied path that does not exist yet fails (`mv`); a symbolic link to such a name
 * can be made, but writing through it fails; the denied file that exists stays as it was; every other
 * path in the allowed directory stays writable. So on macOS every name is listed, whether or not it
 * exists.
 *
 * A name listed ahead of its feature costs nothing only while nothing makes it. The hook wrapper of the
 * Claude Code plugin makes `plugin-cli/<version>` itself (`plugins/stroq/hooks/stroq-hook.sh`: `mkdir -p`,
 * then `mv`), and `mkdir` of a denied directory fails, so under this config the wrapper cannot install
 * its pinned copy: a sandboxed run of Claude Code with the plugin, before the wrapper has ever run, has no
 * hook. `stroq run` says so on macOS at launch when `plugin-cli/<version>` is missing (run once without
 * the sandbox, and the copy is there for every run after).
 *
 * Also measured: a denied path that exists is matched however it is written, but one that does not
 * exist yet is matched only by its real path. Written through a symlink (`/tmp/…` for
 * `/private/tmp/…`, as a `STROQ_HOME` under `/tmp` or `/var` is) it was not denied, and the write
 * created the file. So the home is resolved through its links first, as far as it exists, and
 * every name is built from that.
 *
 * Not measured, only read from srt's README ("Write denies on paths that do not exist yet
 * (Linux)"): bubblewrap can only deny a path by mounting over it, so for a `denyWrite` path that is
 * absent under a writable directory srt first makes an empty read-only file there (or an empty
 * directory for a missing intermediate one), visible on the host while the sandbox lives. Stroq
 * reads the existence of `policy.yaml` as "a custom policy", and an empty file is not a policy, so
 * on any platform but macOS a name is listed only if it exists when the config is made. The cost
 * is stated and not hidden: a name that is absent then can be created by the agent during the run
 * (the self-tamper gate still refuses a write that names it, which is a check of spelling and not a
 * boundary), and `GeneratedSandbox.unprotected` names them, so that `stroq run` can say so. The Windows
 * model (ACLs, an alpha) was not looked at either.
 *
 * And none of them is a deny that holds when the path of the home holds `* ? [ ]`: see `hasGlobSyntax`.
 */
const protectedState = (home: string): readonly string[] => [
  policyFileIn(home),
  secretsFileIn(home),
  trustFileIn(home),
  canaryFilesFileIn(home),
  installRecordFileIn(home),
  // The code the hooks run. No trailing separator on any of these: srt's README says it rejects a
  // deny entry that ends in one.
  cliDirIn(home),
  pluginCliDirIn(home),
  openclawPluginDirIn(home),
  keysDirIn(home),
  liveDirIn(home),
  hardenDirIn(home),
  backupsDirIn(home),
  storeDirIn(home),
  passportsFileIn(home),
  tasksDirIn(home),
  bindingsFileIn(home),
];

export function generateSandbox(inputs: SandboxInputs, host: SandboxHost = {}): GeneratedSandbox {
  const wanted = dedupe([inputs.workspace, ...inputs.tmp, inputs.stroqHome, ...inputs.agentState]);
  const secrets = dedupe(inputs.secretPaths);
  const real = host.realpath ?? realpathSync;
  // An empty home names no state: a path joined to '' would be relative to wherever the launcher
  // happens to run.
  const home = inputs.stroqHome === '' ? null : resolve(inputs.stroqHome);
  const named = home === null ? [] : protectedState(withLinksResolved(home, real));
  // A home that srt would read as a pattern, as written or once its links are resolved, cannot be denied
  // (see `hasGlobSyntax`): it is not given as a root, so that the agent cannot write the state in it.
  const patterned = home !== null && (hasGlobSyntax(home) || named.some(hasGlobSyntax));
  const refused = wanted.filter(
    (p) => tooBroadToSandbox(p, inputs.userHome) || (patterned && p === home),
  );
  const allowWrite = wanted.filter((p) => !refused.includes(p));
  // See `protectedState`: macOS lists every name; elsewhere srt would make a placeholder for the
  // ones that are absent, so only those that are there are listed. For a home it reads as a pattern,
  // none can be.
  const exists = host.exists ?? somethingAt;
  const darwin = (host.platform ?? process.platform) === 'darwin';
  const state = patterned ? [] : darwin ? named : named.filter(exists);
  // The names that no deny covers, and of those the ones that a write root lets the agent write. The names
  // are those of the home with its links resolved, so a root is compared by the path it has once its own are:
  // asked only when there is a name to ask about, which on macOS there is not.
  const undenied = named.filter((p) => !state.includes(p));
  const roots =
    undenied.length === 0 ? [] : allowWrite.map((root) => withLinksResolved(root, real));
  return {
    refused,
    unprotected: undenied.filter((p) => writableUnder(roots, p)),
    settings: {
      filesystem: {
        denyRead: secrets,
        // The same files again. A credential file the agent cannot read but can
        // truncate is still one it can destroy, and the project's `.env` sits inside
        // the workspace, which has to stay writable for the agent to work at all.
        // srt gives `denyWrite` precedence over `allowWrite` (measured, for paths inside the
        // allowed one: see `protectedState`), so the narrower entry is not needed to win.
        // After them, Stroq's own state and code inside the writable home.
        denyWrite: dedupe([...secrets, ...state]),
        allowWrite,
      },
      network: {
        allowedDomains: [...inputs.allowedDomains],
        // Never Stroq's own: srt denies everything not allowed, so a deny list here
        // could only ever narrow an allowance the user asked for by name.
        deniedDomains: [],
      },
    },
  };
}

/**
 * How `srt` is invoked. The separator matters: everything after it is the agent's
 * own command line, so an agent flag that collides with one of srt's is never read
 * as srt's.
 */
export const srtArgv = (
  settingsFile: string,
  command: string,
  args: readonly string[],
): readonly string[] => ['--settings', settingsFile, '--', command, ...args];

/** The program `--sandbox` looks for on `PATH`. */
export const SRT_BIN = 'srt';

/**
 * Said when the agent about to start has a terminal and the sandbox is macOS
 * Seatbelt.
 *
 * Measured against srt 0.0.77: inside its profile a child's `tcsetattr` fails with
 * `EPERM`, so `process.stdin.setRawMode` throws and `stty` cannot read the line
 * discipline. A permissive `sandbox-exec` profile allows both, so this is srt's
 * profile rather than Seatbelt in general — and it is not something Stroq can widen
 * from outside. Every full-screen agent UI needs raw mode, so this is the difference
 * between "the sandbox works" and "the sandbox works for the headless invocation".
 *
 * Said rather than refused: a headless run in the same shell is legitimate and
 * `isTTY` is a good but not perfect proxy for what the agent will try to do. An
 * unexplained crash a second after launch is the outcome this exists to prevent.
 */
export const SRT_NO_RAW_MODE = [
  'stroq run: --sandbox on macOS uses srt’s Seatbelt profile, which denies raw mode (tcsetattr).',
  '  An interactive, full-screen agent UI will not work inside it. Measured against srt 0.0.77.',
  '  Use the agent’s non-interactive mode under --sandbox, or drop --sandbox for an interactive session.',
].join('\n');

/** Said when `--sandbox` was asked for and `srt` is not installed. */
export const SRT_MISSING = [
  'stroq run: --sandbox asked for a sandbox and "srt" is not on PATH, so THERE IS NO SANDBOX on this run.',
  '  The git hardening and the hook checks above still apply; the filesystem and network confinement does not.',
  '  Install it with: npm install -g @anthropic-ai/sandbox-runtime',
].join('\n');
