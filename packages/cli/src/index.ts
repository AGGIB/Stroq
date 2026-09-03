import { runDoctor } from './commands/doctor.js';
import { readStdin, runHook } from './commands/hook.js';
import { runInit } from './commands/init.js';
import { runLog } from './commands/log.js';
import { runVerify } from './commands/verify.js';

const USAGE = `stroq <command>

Commands:
  init [--user] [--dry-run]   install Claude Code hooks (project .claude/settings.json by default)
  hook claude-code            hook entrypoint: reads the event JSON on stdin, prints a decision
  doctor                      check the installation
  log [--count 20]            show recent audit entries
  verify                      verify the audit hash chain
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'hook': {
      const out = await runHook(rest[0] ?? '', await readStdin());
      if (out.stdout) process.stdout.write(out.stdout);
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
