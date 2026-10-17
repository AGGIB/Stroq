import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { reconfirmCommand } from '../mcp/pin-argument.js';
import { outsideLine } from '../ui/layout.js';
import { MAX_LINE_CHARS } from '../mcp/framing.js';
import { DEFAULT_STRICT_MAX_WITHHELD, STRICT_MAX_BENIGN_WITHHELD } from '../mcp/strict-limits.js';
import { writeJsonObject } from './config-file.js';
import {
  MCP_CLIENTS,
  hasValidMcpServers,
  isMcpClient,
  mcpConfigPath,
  readMcpConfig,
  unwrapMcpConfig,
  wrapMcpConfig,
  wrapperPinArgs,
  type McpEntryOutcome,
} from './mcp-config.js';

/**
 * Six things an MCP proxy user has to know that no hook agent needs: the client
 * launches its servers once, at startup; the directory `init` ran in is what the
 * proxy records as the project, because Claude Desktop launches servers from `/`;
 * there is no way to prompt from inside a proxy, so an `ask` arrives as a block; HTTP
 * servers have no subprocess to wrap; each server now starts with only the variables
 * its own entry declares, which is a behaviour change worth stating rather than
 * discovering; and removing Stroq needs `--unwrap`, since the wrapper records an
 * absolute entry path that changes on upgrade.
 */
const MCP_NOTE =
  'Restart the MCP client before this takes effect: it launches its servers once, when it starts.\n' +
  'This directory is recorded as the project for every wrapped server: it is what feeds the secret index and the path rules.\n' +
  'An MCP proxy cannot prompt, so a policy "ask" arrives as a blocked tool result naming the rule to relax.\n' +
  'HTTP servers (url/serverUrl) have no subprocess to wrap and are listed as skipped.\n' +
  'Each wrapped server starts with the variables its own "env" block declares plus the ones any process needs; nothing else in your environment reaches it. Add a variable to that block and re-run this command if a server needs one.\n' +
  '"stroq init --agent mcp --unwrap" restores every wrapped entry to its original command.\n';

interface McpTarget {
  readonly file: string;
  /** What `--client` records and what the output names: a client, or a file basename. */
  readonly label: string;
}

/** The file `--client`/`--config` names, or null when the client name is not one Stroq knows. */
function mcpTarget(
  client: string | undefined,
  configPath: string | undefined,
  scope: 'project' | 'user',
): McpTarget | null {
  if (client === undefined) {
    const file = resolve(configPath ?? '');
    return { file, label: basename(file) };
  }
  if (!isMcpClient(client)) return null;
  return { file: mcpConfigPath(client, scope), label: client };
}

/**
 * True when `path` names a regular file. `existsSync` alone also accepts a
 * directory — `--config <dir>` or a `--config ""` that collapses to `process.cwd()`
 * would otherwise reach `readFileSync` and throw an uncaught EISDIR instead of the
 * friendly "no MCP config" message below.
 */
const isExistingFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/**
 * `skipped (http)` reads as "skipped remote (http)" once the name is spliced back in
 * between the verb and its parenthetical reason, which is the order the spec's own
 * examples use.
 */
function formatOutcome({ action, name }: McpEntryOutcome): string {
  const qualified = /^(.+) \((.+)\)$/.exec(action);
  return qualified ? `${qualified[1]} ${name} (${qualified[2]})` : `${action} ${name}`;
}

export interface McpOptions {
  readonly client?: string;
  readonly config?: string;
  readonly unwrap: boolean;
  /** `--cloak`: see `MCP_CLOAK_NOTE`. Off unless this run asked for it. */
  readonly cloak: boolean;
  /** Strict filtering for wrappers this run may rewrite; confirmed entries stay unchanged. */
  readonly strict?: boolean;
}

/**
 * Printed only when `--cloak` was asked for, because everything it says is a
 * consequence nobody should discover afterwards: values leave the server's results
 * before the model reads them, the dictionary that can put them back is on disk, and
 * the byte-for-byte forwarding the proxy otherwise guarantees no longer holds for the
 * two message kinds it rewrites.
 */
const MCP_CLOAK_NOTE =
  '--cloak is ON for the entries above: detected values in a tools/call result are replaced with placeholders before the model reads them, and restored on the way back to that server.\n' +
  'This writes a REVERSIBLE dictionary under ~/.stroq/cloak (mode 0600, one file per server, entries forgotten after 12 idle hours) — the only place Stroq keeps a value it can restore. See the "Cloak dictionary" section of SECURITY.md.\n' +
  'A cloaked result and a restored call are re-serialised, so those two message kinds are no longer forwarded byte for byte; everything else still is.\n' +
  'Re-run this command WITHOUT --cloak to switch it back off.\n';

/**
 * The servers of this config file that `add` confirmed. The lock reader is loaded here, when it is needed, and not
 * with the rest of `init`, which the hooks load on every call and which must not pull in Safe Install.
 */
async function confirmedNames(file: string): Promise<ReadonlySet<string>> {
  const { confirmedEntries } = await import('../mcp/confirmed-entries.js');
  return new Set(confirmedEntries(file).keys());
}

/** Why a wrapper that `add` confirmed was not rewritten, and the one command that applies what this run would have changed. */
export const keptNote = (name: string, cloak: boolean, strict = false): string =>
  `  ${outsideLine(name)} is pinned by stroq add and the pin holds its wrapper exactly as add wrote it, so this run left it alone` +
  `${cloak ? ' (the cloak is not on for it)' : ''}` +
  `${strict ? ' (--strict was not changed by this run)' : ''}. To rewrite it for this directory, node and flags, confirm it again: ${reconfirmCommand(name, { strict })}`;

/**
 * Printed only when `--strict` was asked for, because what it costs is as much a part of
 * the choice as what it buys: servers lose messages they send today, and the mode filters
 * in the proxy rather than isolating the server.
 */
export const MCP_STRICT_NOTE =
  `--strict is ON for entries rewritten by this run; entries kept as confirmed are unchanged: a server message Stroq could not fully read and scan is withheld, and the request it answers gets a fixed error instead. That covers a result above ${MAX_LINE_CHARS / (1024 * 1024)} MiB, one that is not valid JSON, one with a field Stroq does not read, a response nobody asked for, and server-initiated requests and log messages (sampling, elicitation, roots).\n` +
  `It is also counted: a server with more than ${DEFAULT_STRICT_MAX_WITHHELD} malformed or hostile messages withheld (${STRICT_MAX_BENIGN_WITHHELD} for log lines and progress messages) is ended. Messages that are delivered are re-written as the JSON Stroq parsed, so they are no longer forwarded byte for byte.\n` +
  'Strict mode filters what the client receives. It is not a sandbox for the server, and withholding a message cannot undo what the server already did. Re-running this command without --strict keeps it on; "stroq init --agent mcp --unwrap" and then a plain init turns it off.\n';

export async function initMcp(
  scope: 'project' | 'user',
  argv: readonly string[],
  dryRun: boolean,
  options: McpOptions,
): Promise<number> {
  if ((options.client === undefined) === (options.config === undefined)) {
    process.stdout.write(
      'stroq init --agent mcp needs exactly one of --client <name> or --config <path>\n',
    );
    return 1;
  }
  const target = mcpTarget(options.client, options.config, scope);
  if (target === null) {
    process.stdout.write(
      `unknown client "${options.client ?? ''}" (supported: ${MCP_CLIENTS.join(', ')})\n`,
    );
    return 1;
  }
  // A missing file — or a directory, which `existsSync` alone would call "there" —
  // is nothing to wrap; creating one would look like success while the client still
  // has no servers and no proxy.
  if (!isExistingFile(target.file)) {
    process.stdout.write(
      `no MCP config at ${target.file}; add your servers there first, then re-run this command\n`,
    );
    return 1;
  }
  const [node, ...entryArgv] = argv;
  if (node === undefined) {
    process.stderr.write('stroq init --agent mcp: no node executable available to wrap with\n');
    return 1;
  }
  const config = readMcpConfig(target.file);
  // A present-but-wrong-shaped `mcpServers` (an array from a hand edit, say) is not
  // ours to guess at: rewriting it to `{}` would destroy every server in the file.
  if (!hasValidMcpServers(config)) {
    process.stderr.write(`cannot rewrite ${target.file}: mcpServers is not an object\n`);
    return 1;
  }
  const rewrite = options.unwrap
    ? unwrapMcpConfig(config)
    : wrapMcpConfig(config, {
        node,
        entryArgv,
        client: target.label,
        cwd: process.cwd(),
        cloak: options.cloak,
        strict: options.strict === true,
        confirmed: await confirmedNames(target.file),
      });
  // Under --dry-run stdout carries only the JSON preview, so a `--dry-run | jq`
  // pipeline still works; the per-entry lines still print, just on stderr instead of
  // vanishing (the Copilot installer's replacement notice follows the same split).
  const outcomeStream = dryRun ? process.stderr : process.stdout;
  for (const outcome of rewrite.outcomes) {
    outcomeStream.write(`${formatOutcome(outcome)}\n`);
    if (outcome.action === 'kept (confirmed by stroq add)')
      outcomeStream.write(`${keptNote(outcome.name, options.cloak, options.strict === true)}\n`);
    const entry = (config.mcpServers as Record<string, unknown>)[outcome.name];
    if (
      options.unwrap &&
      outcome.action === 'unwrapped' &&
      typeof entry === 'object' &&
      entry !== null &&
      'args' in entry &&
      Array.isArray(entry.args) &&
      wrapperPinArgs(entry.args).length > 0
    )
      outcomeStream.write(
        'Unwrapping this entry removes the runtime pin and its startup verification.\n',
      );
  }
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(rewrite.config, null, 2)}\n`);
    return 0;
  }
  writeJsonObject(target.file, rewrite.config);
  const headline = options.unwrap ? 'Stroq proxy removed from' : 'Stroq proxy installed in';
  const cloakNote = options.cloak && !options.unwrap ? MCP_CLOAK_NOTE : '';
  const strictNote = options.strict === true && !options.unwrap ? MCP_STRICT_NOTE : '';
  process.stdout.write(
    `${headline} ${target.file}\n${MCP_NOTE}${cloakNote}${strictNote}Run "stroq doctor" to verify.\n`,
  );
  return 0;
}
