// `pnpm dev:prove -- <flags>`: what `stroq prove` was, before it left the CLI in 0.30. It drives Claude
// Code or Codex CLI on three harmless commands with the hook in the loop, on the owner's own login, and
// says whether a denied action really did not happen. It asks before it makes a request. The local
// console runs the same check from its own screen.
import { runProve } from '../../packages/cli/src/commands/prove.js';
import { runDevTool } from '../../packages/cli/src/dev-help.js';

process.exitCode = await runDevTool('prove', process.argv.slice(2), (args) => runProve(args));
