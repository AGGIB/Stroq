import { runAttackCommand } from './commands/attack.js';
import { runBenchCommand } from './commands/bench.js';
import { runCanary } from './commands/canary.js';
import { runCoverageCommand } from './commands/coverage.js';
import { runDoctor } from './commands/doctor.js';
import { runExposure } from './commands/exposure.js';
import { runHookCommand } from './commands/hook.js';
import { runInitCommand } from './commands/init-agent.js';
import { runInspect } from './commands/inspect.js';
import { runLog } from './commands/log.js';
import { runMcp } from './commands/mcp.js';
import { neutralizeControls, withSafeOutput } from './terminal-safe.js';
import { runReplay } from './commands/replay.js';
import { runRun } from './commands/run.js';
import { runSent } from './commands/sent.js';
import { runTrust } from './commands/trust.js';
import { runUninstall } from './commands/uninstall.js';
import { runUntaint } from './commands/untaint.js';
import { runVerify } from './commands/verify.js';
import { runWhy } from './commands/why.js';
import { stroqVersion } from './version.js';
import {
  commandHelp,
  parseArgsProblem,
  suggestCommand,
  unknownOption,
  usage,
  usageError,
  wantsHelp,
} from './help.js';

type Runner = (args: readonly string[]) => number | Promise<number>;

/** Every command that prints for a person, by name. */
const COMMANDS: Readonly<Record<string, Runner>> = {
  inspect: runInspect,
  init: runInitCommand,
  uninstall: runUninstall,
  run: runRun,
  doctor: runDoctor,
  log: runLog,
  verify: () => runVerify(),
  trust: runTrust,
  untaint: runUntaint,
  replay: runReplay,
  why: runWhy,
  sent: runSent,
  canary: runCanary,
  attack: runAttackCommand,
  exposure: runExposure,
  bench: runBenchCommand,
  coverage: runCoverageCommand,
};

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'hook': {
      // Asked for help, or run with no agent at all: no agent invokes it that way, so
      // it is a person, and a person should not be left waiting on stdin.
      if (rest[0] === undefined || wantsHelp('hook', rest)) {
        process.stdout.write(commandHelp('hook') ?? '');
        return rest[0] === undefined ? 2 : 0;
      }
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
    case 'mcp':
      if (wantsHelp('mcp', rest)) {
        process.stdout.write(commandHelp('mcp') ?? '');
        return 0;
      }
      // A protocol stream: what the proxy does not judge it forwards byte for byte.
      return runMcp(rest);
    default:
      // Everything else prints for a person, and much of what it prints — recorded
      // commands, audit summaries, file names from a cloned repository — was written
      // by whoever wrote what the agent read. See `terminal-safe.ts`.
      return withSafeOutput(() => report(command, rest));
  }
}

async function report(command: string | undefined, rest: readonly string[]): Promise<number> {
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${stroqVersion()}\n`);
    return 0;
  }
  if (command === 'help') {
    const help = rest[0] === undefined ? usage() : commandHelp(rest[0]);
    if (help === null) return unknownCommand(rest[0] ?? '');
    process.stdout.write(help);
    return 0;
  }
  const runner = COMMANDS[command];
  if (runner === undefined) return unknownCommand(command);
  // `sent` writes its own, longer help.
  if (command !== 'sent' && wantsHelp(command, rest)) {
    process.stdout.write(commandHelp(command) ?? '');
    return 0;
  }
  const unknown = unknownOption(command, rest);
  if (unknown !== null) {
    process.stderr.write(usageError(command, `unknown option ${unknown}`));
    return 2;
  }
  try {
    return await runner(rest);
  } catch (err) {
    const problem = parseArgsProblem(err);
    if (problem === null) throw err;
    process.stderr.write(usageError(command, problem));
    return 2;
  }
}

function unknownCommand(typed: string): number {
  const suggestion = suggestCommand(typed);
  process.stderr.write(
    `stroq: unknown command "${typed}".${suggestion === null ? '' : ` Did you mean "${suggestion}"?`}\n` +
      'Run "stroq --help" for the list of commands.\n',
  );
  return 1;
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

// `stroq log --json | head -1` closes the pipe after one line. That is the reader
// being done, not a failure, and must not end in a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw err;
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${neutralizeControls(String(err))}\n`);
    process.exitCode = 1;
  },
);
