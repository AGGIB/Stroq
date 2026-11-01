// `pnpm dev:coverage -- <flags>`: what `stroq coverage` was, before it left the CLI in 0.30. It prints
// the control mapping against MITRE ATLAS and OWASP ASI, as a table, JSON or an ATT&CK Navigator layer.
import { runCoverageCommand } from '../../packages/cli/src/commands/coverage.js';
import { runDevTool } from '../../packages/cli/src/dev-help.js';

process.exitCode = await runDevTool('coverage', process.argv.slice(2), runCoverageCommand);
