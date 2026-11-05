// `pnpm dev:bench -- <flags>`: what `stroq bench` was, before it left the CLI in 0.30. It measures how
// much benign developer text the rule set flags (`--corpus`), how much ordinary agent work the policy
// interrupts (`--actions`), and what a hook call costs (`--latency`). Maintainers use it for gates.
// The flags, the output and the exit codes are the command's; `--help` lists them.
import { runBenchCommand } from '../../packages/cli/src/commands/bench.js';
import { runDevTool } from '../../packages/cli/src/dev-help.js';

process.exitCode = await runDevTool('bench', process.argv.slice(2), runBenchCommand);
