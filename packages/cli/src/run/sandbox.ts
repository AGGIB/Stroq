import { join, resolve } from 'node:path';
import { canaryFilesFileIn, installRecordFileIn, secretsFileIn, trustFileIn } from '../paths.js';

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
   * sandbox. Returned rather than silently dropped: a caller that asked for one
   * has to be told it did not get it.
   */
  readonly refused: readonly string[];
}

const dedupe = (paths: readonly string[]): readonly string[] => [
  ...new Set(paths.filter((p) => p !== '').map((p) => resolve(p))),
];

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
 * there. That also leaves the agent able to rewrite the files the NEXT call is judged
 * by: the policy, the secret index, the trust and canary records, the install record.
 * Those go into `denyWrite`, and so do the places features still to come keep their
 * own state (keys, live, harden, backups, store, passports, tasks, bindings). A name
 * that does not exist yet is listed anyway, so that the feature creating it is
 * covered from its first file and not from the release that remembers to add it.
 *
 * The order is the order they are written in, and it is pinned by a test.
 *
 * NOT VERIFIED: srt's README says a `denyWrite` entry takes precedence over an
 * `allowWrite` root that contains it (0.0.77), but nothing in this repository has run
 * srt to see that hold for a path inside the Stroq home. The tests check the file
 * this generates, not what srt does with it; a live test against the real srt has to
 * show enforcement before anything describes it as enforced. Also unmeasured: on Linux
 * srt denies a path by mounting over it, and for one that does not exist yet it makes
 * an empty read-only placeholder in the home while a sandbox is alive (its README,
 * "Write denies on paths that do not exist yet"), so a name listed ahead of its
 * feature shows up on the host as a file for as long as the run lasts.
 */
const protectedState = (home: string): readonly string[] => [
  // `paths.ts` has no helper that takes a home for the policy, only `policyFile()`
  // for the real one, and a sandbox config is built for the home it is given.
  join(home, 'policy.yaml'),
  secretsFileIn(home),
  trustFileIn(home),
  canaryFilesFileIn(home),
  installRecordFileIn(home),
  // No trailing separator: srt's README says it rejects a deny entry that ends in one.
  join(home, 'keys'),
  join(home, 'live'),
  join(home, 'harden'),
  join(home, 'backups'),
  join(home, 'store'),
  join(home, 'passports.json'),
  join(home, 'tasks'),
  join(home, 'bindings.yaml'),
];

export function generateSandbox(inputs: SandboxInputs): GeneratedSandbox {
  const wanted = dedupe([inputs.workspace, ...inputs.tmp, inputs.stroqHome, ...inputs.agentState]);
  const refused = wanted.filter((p) => tooBroadToSandbox(p, inputs.userHome));
  const secrets = dedupe(inputs.secretPaths);
  // An empty home names no state: `join('', 'policy.yaml')` would be a path relative to
  // wherever the launcher happens to run.
  const state = inputs.stroqHome === '' ? [] : protectedState(resolve(inputs.stroqHome));
  return {
    refused,
    settings: {
      filesystem: {
        denyRead: secrets,
        // The same files again. A credential file the agent cannot read but can
        // truncate is still one it can destroy, and the project's `.env` sits inside
        // the workspace, which has to stay writable for the agent to work at all.
        // srt applies `denyWrite` over `allowWrite`, so the narrower entry wins.
        // After them, Stroq's own state inside the writable home (see `protectedState`).
        denyWrite: dedupe([...secrets, ...state]),
        allowWrite: wanted.filter((p) => !refused.includes(p)),
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
