// What a person reads before typing the digest of an MCP server, in the order that they read it.
import { confirmationScreen } from '../commands/vet-render.js';
import { entryRunsStrict } from '../commands/mcp-config.js';
import { reconfirmCommand } from '../mcp/pin-argument.js';
import { outsideLine } from '../ui/layout.js';
import type { Terminal } from '../ui/terminal.js';
import type { PreparedMcp } from './mcp-prepare.js';
import { updateDiffLines } from './update-diff.js';

const SELF_CONTAINED =
  'Self-contained: no dependency is listed and no import by name was found. That is a best-effort reading of the text, not a proof that nothing outside the tree is loaded; the pin is tamper-evident, not tamper-proof.';

/**
 * Writes the screen of an install or an update. The passport screen is built first, so that an artifact whose
 * sensitive lines do not all fit is refused before a word has been written.
 */
export function showMcpScreen(terminal: Pick<Terminal, 'write'>, prepared: PreparedMcp): void {
  const { name, previous, oldTree, made, entrypoint, passEnv, written, selected, current } =
    prepared;
  const screen = confirmationScreen(made.passport, prepared.source);
  terminal.write(
    `${previous === undefined ? 'Install' : 'Update'} MCP server ${name} in ${outsideLine(JSON.stringify(selected.file))}\n`,
  );
  if (previous !== undefined) terminal.write(`Previous sha256:${previous.digest}\n`);
  if (oldTree !== undefined)
    for (const line of updateDiffLines(oldTree, made.tree)) terminal.write(`${line}\n`);
  if (entryRunsStrict(written))
    terminal.write(
      'Strict filtering: ON (--strict). Messages the proxy cannot fully scan are withheld; this does not sandbox the server.\n',
    );
  else if (entryRunsStrict(current))
    terminal.write(
      `Note: the current entry runs with --strict, but that flag is not confirmed in the lock; the replacement below does not. To enable it with confirmation: ${reconfirmCommand(name, { strict: true })}\n`,
    );
  terminal.write(
    `Starts node ${outsideLine(JSON.stringify(entrypoint))} from a verified private copy; environment passed: ${passEnv.length === 0 ? 'none' : passEnv.join(', ')}\n`,
  );
  terminal.write(`${SELF_CONTAINED}\n`);
  terminal.write(screen);
  terminal.write(`Client entry: ${outsideLine(JSON.stringify(written))}\n`);
}
