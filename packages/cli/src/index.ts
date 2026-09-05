import { runAttackCommand } from './commands/attack.js';
import { runCanary } from './commands/canary.js';
import { runDoctor } from './commands/doctor.js';
import { readStdin, runHook } from './commands/hook.js';
import { runInit } from './commands/init.js';
import { runLog } from './commands/log.js';
import { runUntaint } from './commands/untaint.js';
import { runVerify } from './commands/verify.js';
import { runWhy } from './commands/why.js';

const USAGE = `stroq <command>

Commands:
  init [--agent <name>] [--user] [--dry-run]
                                     install hooks (--agent claude-code | cursor | codex; project config by default)
  hook <claude-code|cursor|codex>    hook entrypoint: reads the event JSON on stdin, prints a decision
  doctor                             check the installation
  log [--count 20]                   show recent audit entries
  verify                             verify the audit hash chain
  untaint [--session <id>] [--all]   clear a false-positive session's taint, or every session's
  why [--seq <n>]                    explain the most recent denied/asked action: rule, provenance, taint
  canary [--name <NAME>]             print a canary secret to plant; its outbound use is denied and taints the session
  attack [--json] [--only <id>]      replay 12 recorded incidents against your policy; exit 1 if any gets through
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'hook': {
      const out = await runHook(rest[0] ?? '', await readStdin());
      if (out.stdout) process.stdout.write(out.stdout);
      // Codex reads the block reason from stderr when the hook exits 2; the other
      // adapters never set this field.
      if (out.stderr) process.stderr.write(out.stderr);
      return out.exitCode;
    }
    case 'init':
      return runInit(rest);
    case 'doctor':
      return runDoctor();
    case 'log':
      return runLog(rest);
    case 'verify':
      return runVerify();
    case 'untaint':
      return runUntaint(rest);
    case 'why':
      return runWhy(rest);
    case 'canary':
      return runCanary(rest);
    case 'attack':
      return runAttackCommand(rest);
    default:
      process.stdout.write(USAGE);
      return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }
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
