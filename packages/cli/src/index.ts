import { runAttackCommand } from './commands/attack.js';
import { runBenchCommand } from './commands/bench.js';
import { runCanary } from './commands/canary.js';
import { runCoverageCommand } from './commands/coverage.js';
import { runDoctor } from './commands/doctor.js';
import { runExposure } from './commands/exposure.js';
import { runHookCommand } from './commands/hook.js';
import { runInit } from './commands/init.js';
import { runInspect } from './commands/inspect.js';
import { runLog } from './commands/log.js';
import { runMcp } from './commands/mcp.js';
import { runReplay } from './commands/replay.js';
import { runRun } from './commands/run.js';
import { runSent } from './commands/sent.js';
import { runTrust } from './commands/trust.js';
import { runUntaint } from './commands/untaint.js';
import { runVerify } from './commands/verify.js';
import { runWhy } from './commands/why.js';
import { stroqVersion } from './version.js';

const USAGE = `stroq <command>

Commands:
  init [--agent <name>] [--user] [--dry-run]
                                     install hooks (--agent claude-code | cursor | codex | copilot | openclaw | windsurf | antigravity; project config by default)
                                     or wrap a client's MCP servers (--agent mcp --client <name>)
  hook <claude-code|cursor|codex>    hook entrypoint: reads the event JSON on stdin, prints a decision
  hook windsurf                      Windsurf entrypoint: its events name themselves, and a block is exit 2 with the reason on stderr
  hook copilot <pre|post>            Copilot entrypoint: its events carry no name, so the phase is an argument
  hook openclaw <pre|post>           OpenClaw plugin entrypoint: same, answered in Stroq's own JSON
  hook antigravity <pre|post|preinvocation>
                                     Antigravity entrypoint: same, plus PreInvocation, where a tainted
                                     session's status is stated to the model before it is called
  run [--sandbox] -- <agent> …       start an agent already confined: exports the git settings that
                                     stop a repository running a command during the startup
                                     "git status", refuses to launch into a repository that runs
                                     something before you could approve it, and checks that Stroq's
                                     hooks are installed for that agent. --sandbox additionally wraps
                                     the launch in Anthropic's srt, when srt is installed, with a
                                     read-deny list built from this machine's real credential files
  mcp --server <n> -- <cmd> …        stdio MCP proxy: judges every tools/call, scans every result
  doctor [--all]                     check the installation (--all lists every agent and scope)
  log [--count 20]                   show recent audit entries
  verify                             verify the audit hash chain
  untaint [--session <id>] [--all]   clear a false-positive session's taint, or every session's
  why [--seq <n>]                    explain the most recent denied/asked action: rule, provenance, taint
  replay [<session>] [--last] [--transcript <path>] [--json] [--list]
                                     rebuild a session's causal history: which content the agent read,
                                     and which actions came out of it. --last reads the agent's own
                                     transcript, so it works on sessions that ran before you installed
  sent [<session>] [--last] [--transcript <path>] [--json] [--fail-on-finding]
                                     which of your credentials already reached a model provider, in
                                     which past session, put there by which tool call. --last reads
                                     the agent's own transcript, so it covers sessions from before
                                     you installed and can see what tools RETURNED, not just what
                                     they sent. To match values it reads this machine's credential
                                     files (~/.aws/credentials, ~/.npmrc, ~/.netrc,
                                     ~/.docker/config.json, ./.env*); it reports names and sources
                                     only, never a value. Exits 0 even when it finds something —
                                     the past cannot be fixed by this build; use --fail-on-finding
                                     to gate on it anyway
  canary [--name <NAME>]             print a canary secret to plant; its outbound use is denied and taints the session
  attack [--json] [--only <id>] [--fuzz]
                                     replay recorded incidents against your policy; exit 1 if any gets
                                     through. --fuzz crosses every scenario with every mutation and
                                     prints the ones that escape
  exposure [--probe] [--share] [--json] [--verbose]
                                     map this machine's agent surface and report what reaches you;
                                     --probe starts your MCP servers to read their tool descriptions
  inspect [<dir>] [--json] [--env]   read what a repository runs before you open it with an agent;
                                     --env prints the git settings that neutralise it
  trust [<file>] [--list] [--remove <file>] [--json]
                                     waive a false positive on a file's exact content; without
                                     arguments, list what is trusted
  bench [--corpus <dir>] [--json] [--verbose]
                                     measure how much benign developer text the rule set flags
  coverage [--format table|navigator] [--json]
                                     control mapping against MITRE ATLAS and OWASP ASI
  --version                          print the CLI version
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'hook': {
      // Reading stdin happens inside the command so that a rejection there is
      // answered by the agent's own fail-closed path, not by the exit-1 handler at
      // the bottom of this file: Codex reads exit 1 as a hook failure and continues
      // past it, and Copilot denies on any non-zero exit from a `preToolUse` but
      // prints the reason only for exit 2 (on its other events, exit 1 fails open).
      // `rest[1]` is Copilot's and OpenClaw's phase argument; the other agents ignore it.
      const out = await runHookCommand(rest[0] ?? '', rest[1] ?? '');
      if (out.stdout) process.stdout.write(out.stdout);
      // Codex, Copilot, OpenClaw and Windsurf all read the block reason from stderr
      // when the hook exits 2; Claude Code and Cursor never set this field.
      // OpenClaw's plugin blocks on any non-zero exit and reads the reason from
      // stderr, so it needs the same two channels Copilot does.
      // Windsurf's Cascade reads ONLY exit 2 as a block, with the reason on stderr,
      // and treats every other non-zero exit — exit 1 included — as an allow.
      if (out.stderr) process.stderr.write(out.stderr);
      // The watchdog answered while the real work was still running, and that work
      // can hold the event loop open. Setting an exit code and returning would leave
      // the process alive past its own verdict, until the agent's timeout fired and
      // treated the whole call as an allow — the exact outcome the watchdog exists to
      // prevent. Flush both streams, then leave.
      if (out.timedOut) await exitNow(out.exitCode);
      return out.exitCode;
    }
    case 'inspect':
      return runInspect(rest);
    case 'init':
      return runInit(rest);
    case 'run':
      return runRun(rest);
    case 'mcp':
      return runMcp(rest);
    case 'doctor':
      return runDoctor(rest);
    case 'log':
      return runLog(rest);
    case 'verify':
      return runVerify();
    case 'trust':
      return runTrust(rest);
    case 'untaint':
      return runUntaint(rest);
    case 'replay':
      return runReplay(rest);
    case 'why':
      return runWhy(rest);
    case 'sent':
      return runSent(rest);
    case 'canary':
      return runCanary(rest);
    case 'attack':
      return runAttackCommand(rest);
    case 'exposure':
      return runExposure(rest);
    case 'bench':
      return runBenchCommand(rest);
    case 'coverage':
      return runCoverageCommand(rest);
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`${stroqVersion()}\n`);
      return 0;
    default:
      process.stdout.write(USAGE);
      return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }
}

/** Waits for stdout and stderr to drain, then exits. Never resolves. */
async function exitNow(code: number): Promise<never> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          // `write('')` resolves once everything queued before it has been flushed,
          // which a pipe does asynchronously — process.exit on its own can truncate.
          stream.write('', () => resolve());
        }),
    ),
  );
  process.exit(code);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  },
);
