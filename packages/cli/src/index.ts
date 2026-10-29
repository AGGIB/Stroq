import { neutralizeControls, withSafeOutput } from './terminal-safe.js';
import { handleStdoutError } from './stdout-errors.js';
import { stroqVersion } from './version.js';
import {
  commandHelp,
  commandHint,
  parseArgsProblem,
  suggestCommand,
  unknownOption,
  usage,
  usageAll,
  usageError,
  wantsHelp,
} from './help.js';

type Runner = (args: readonly string[]) => number | Promise<number>;

/**
 * Every command that prints for a person, by name, each loaded only when it is the one run.
 *
 * A hook call is a new process for every tool call an agent makes, and it runs none of these:
 * loaded up front, their code was read, compiled and run on every one of those calls before the
 * hook could start. Each entry imports its own module, so `stroq hook` loads the hook and what the
 * hook needs, and nothing else.
 */
const COMMANDS: Readonly<Record<string, () => Promise<Runner>>> = {
  console: async () => (await import('./commands/console.js')).runConsole,
  inspect: async () => (await import('./commands/inspect.js')).runInspect,
  init: async () => (await import('./commands/init-agent.js')).runInitCommand,
  uninstall: async () => (await import('./commands/uninstall.js')).runUninstall,
  run: async () => (await import('./commands/run.js')).runRun,
  task: async () => (await import('./commands/task.js')).runTask,
  permit: async () => (await import('./commands/permit.js')).runPermit,
  doctor: async () => (await import('./commands/doctor.js')).runDoctor,
  prove: async () => (await import('./commands/prove.js')).runProve,
  log: async () => (await import('./commands/log.js')).runLog,
  verify: async () => {
    const { runVerify } = await import('./commands/verify.js');
    return () => runVerify();
  },
  trust: async () => (await import('./commands/trust.js')).runTrust,
  untaint: async () => (await import('./commands/untaint.js')).runUntaint,
  replay: async () => (await import('./commands/replay.js')).runReplay,
  why: async () => (await import('./commands/why.js')).runWhy,
  sent: async () => (await import('./commands/sent.js')).runSent,
  canary: async () => (await import('./commands/canary.js')).runCanary,
  attack: async () => (await import('./commands/attack.js')).runAttackCommand,
  policy: async () => (await import('./commands/policy.js')).runPolicy,
  exposure: async () => (await import('./commands/exposure.js')).runExposure,
  bench: async () => (await import('./commands/bench.js')).runBenchCommand,
  coverage: async () => (await import('./commands/coverage.js')).runCoverageCommand,
  harden: async () => (await import('./commands/harden.js')).runHarden,
  vet: async () => (await import('./commands/vet.js')).runVet,
  add: async () => (await import('./commands/add.js')).runAdd,
  remove: async () => (await import('./commands/remove.js')).runRemove,
};

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'task-hook': {
      const { runTaskHookCommand } = await import('./task/broker.js');
      const out = await runTaskHookCommand();
      process.stdout.write(out.stdout);
      return out.exitCode;
    }
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
      const { runHookCommand } = await import('./commands/hook.js');
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
      return (await import('./commands/mcp.js')).runMcp(rest);
    default:
      // Everything else prints for a person, and much of what it prints — recorded
      // commands, audit summaries, file names from a cloned repository — was written
      // by whoever wrote what the agent read. See `terminal-safe.ts`.
      return withSafeOutput(() => report(command, rest));
  }
}

async function report(command: string | undefined, rest: readonly string[]): Promise<number> {
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(rest[0] === '--all' ? usageAll() : usage());
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${stroqVersion()}\n`);
    return 0;
  }
  if (command === 'help') {
    const help =
      rest[0] === undefined ? usage() : rest[0] === '--all' ? usageAll() : commandHelp(rest[0]);
    if (help === null) return unknownCommand(rest[0] ?? '');
    process.stdout.write(help);
    return 0;
  }
  const load = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (load === undefined) return unknownCommand(command);
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
  const runner = await load();
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
  const hint = commandHint(typed);
  if (hint !== null) {
    process.stderr.write(`${hint}\n`);
    return 1;
  }
  const suggestion = suggestCommand(typed);
  process.stderr.write(
    `stroq: unknown command "${typed}".${suggestion === null ? '' : ` Did you mean "${suggestion}"?`}\n` +
      'Run "stroq help --all" for the list of commands.\n',
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

process.stdout.on('error', (err: NodeJS.ErrnoException) => handleStdoutError(err));

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${neutralizeControls(String(err))}\n`);
    process.exitCode = 1;
  },
);
