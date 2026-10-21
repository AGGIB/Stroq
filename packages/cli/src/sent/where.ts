// Where one recorded call put a key it carried, and whether the call ran at all.
//
// The call's tool decides how it is read: a shell command by its stages (`shell-route.ts`),
// a WebFetch by its URL, an MCP call by its server (`mcp-config.ts`), a write by the file.
// Everything else the AI wrote was seen by the AI, which is all a log shows of it.
import { commandUrls, isShellTool } from '@stroq/core';
import type { TranscriptPost } from '../replay/transcript.js';
import { inputText } from './input-text.js';
import type { Key } from './keys.js';
import type { McpServers } from './mcp-config.js';
import { keyForms } from './needles.js';
import { stringsOf } from './js-strings.js';
import { farther, hostPlace, isLoopback, type Place } from './place.js';
import { scriptPlace, shellPlace, writtenPlace, type ShellContext } from './shell-place.js';
import { toolRequestPlace } from './tool-request.js';

export interface WhereContext extends ShellContext {
  readonly mcp: McpServers;
}

/** Tools that write a file the call names. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Files of one Codex patch read, at most. */
const MAX_PATCH_FILES = 64;
const PATCH_MARKERS: readonly string[] = ['*** Add File: ', '*** Update File: ', '*** Move to: '];

/**
 * Every file a write names: a path field, or each file a Codex patch adds, updates or moves to, to
 * the bound; and whether the patch names more, which are not followed.
 */
function patchFiles(input: Readonly<Record<string, unknown>>): {
  readonly files: string[];
  readonly cut: boolean;
} {
  const path = str(input['file_path']) || str(input['notebook_path']) || str(input['path']);
  if (path !== '') return { files: [path], cut: false };
  const files: string[] = [];
  for (const line of str(input['input']).split('\n')) {
    const marker = PATCH_MARKERS.find((m) => line.startsWith(m));
    const file = marker === undefined ? '' : line.slice(marker.length).trim();
    if (file === '') continue;
    if (files.length >= MAX_PATCH_FILES) return { files, cut: true };
    files.push(file);
  }
  return { files, cut: false };
}

/** Every file a write names: a path field, or each file a Codex patch adds, updates or moves to. */
export const writtenFiles = (input: Readonly<Record<string, unknown>>): string[] =>
  patchFiles(input).files;

/** Whether a patch names more files than are followed: the rest may be sent unseen. */
export const writtenFilesCut = (input: Readonly<Record<string, unknown>>): boolean =>
  patchFiles(input).cut;

/** The file a write names: a path field, or the first file of a Codex patch. */
export const writtenFile = (input: Readonly<Record<string, unknown>>): string | null =>
  writtenFiles(input)[0] ?? null;

/**
 * The text a write puts in its file: a Write's content, an Edit's new text (each of a MultiEdit's
 * too), a notebook cell, or the added lines of a Codex patch.
 */
export function writtenText(input: Readonly<Record<string, unknown>>): string {
  const edits = Array.isArray(input['edits']) ? input['edits'] : [];
  const patch = str(input['input'])
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  return [
    str(input['content']),
    str(input['new_string']),
    str(input['new_source']),
    ...edits.map((edit) => str((edit as Record<string, unknown> | null)?.['new_string'])),
    patch,
  ]
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * An MCP call: to its server, and to every address it was handed with the key, in the key's field
 * or another (`tool-request.ts`). A server on this machine, started as a command or reached at a
 * loopback address, may send what it is given on: maybe sent. One reached at any other address is
 * another company unless that address is an exact host of the key's own service.
 */
function mcpPlace(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  key: Key,
  ctx: WhereContext,
): Place | null {
  const found = ctx.mcp.lookup(tool);
  if (found === null) return null;
  const base = { route: 'mcp', tool, detail: found.name } as const;
  const server = serverPlace(found, key, base);
  const request = toolRequestPlace(input, key, base);
  return request === null ? server : farther(server, request);
}

/** Where an MCP call's server put the key. */
function serverPlace(
  found: NonNullable<ReturnType<McpServers['lookup']>>,
  key: Key,
  base: Omit<Place, 'tier'>,
): Place {
  const server = found.server;
  if (server === null) return { ...base, tier: 'maybe' };
  if (!server.remote) return { ...base, tier: 'maybe', local: true };
  // A claude.ai connector is named by the call itself: it runs at Anthropic for another service.
  if (found.connector) return { ...base, connector: true, tier: 'third_party' };
  // Any other server's address is read from today's settings, which may not be where it pointed
  // when the session ran, and its arguments are no auth header: maybe sent, with the host named.
  if (server.host === null) return { ...base, tier: 'maybe' };
  return {
    ...base,
    tier: 'maybe',
    host: server.host,
    ...(isLoopback(server.host) ? { local: true as const } : {}),
  };
}

/**
 * Tools whose arguments say what the AI wants done here, not a request: a key and a URL in one of
 * them is not sent. Any other tool that is not a shell, a write or an MCP call (`web__run`, `js`,
 * a browser tool, one Stroq does not know) is read as a request to the addresses its arguments
 * hold (`tool-request.ts`). A skill or a slash command is no local tool: it runs what it holds.
 */
const LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'Agent',
  'Task',
  'TodoWrite',
  'TodoRead',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'BashOutput',
  'KillShell',
  'KillBash',
  'update_plan',
]);

/**
 * Tools that run what they are given, where the arguments do not say what it sends: code (`js`),
 * text typed into a running program (`write_stdin`), a skill and a slash command, which can run
 * commands and scripts of their own.
 */
export const TOOL_RUNNERS: ReadonlySet<string> = new Set([
  'js',
  'write_stdin',
  'Skill',
  'SlashCommand',
]);

/** URLs read from one text. */
const MAX_URLS = 64;

/** The hosts of the URLs in some texts, and whether any URL could not be read or was past the cap. */
function urlHostsIn(texts: readonly string[]): { hosts: string[]; unread: boolean } {
  const hosts: string[] = [];
  let unread = false;
  for (const text of texts) {
    const read = commandUrls(text, MAX_URLS);
    if (read.capped) unread = true;
    for (const url of read.urls) {
      if (url.host === '') unread = true;
      else hosts.push(url.host.toLowerCase());
    }
  }
  return { hosts, unread };
}

/** The texts of `texts` that hold the key. */
const holding = (texts: readonly string[], key: Key): string[] => {
  const forms = keyForms(key.value);
  return texts.filter((text) => forms.some((f) => text.includes(f)));
};

/**
 * Where a tool that is not a shell, a write or an MCP call put a key: an address in its input, in
 * the key's field or another, is a request to its host; a tool that runs what it is given may have
 * sent it, wherever else it went; a tool that only says what the AI wants done here was seen by the
 * AI, as far as a log shows.
 */
function otherToolPlace(tool: string, input: Readonly<Record<string, unknown>>, key: Key): Place {
  const runs: Place | null = TOOL_RUNNERS.has(tool)
    ? { tier: 'maybe', route: 'command-ran', tool }
    : null;
  const request = LOCAL_TOOLS.has(tool)
    ? null
    : toolRequestPlace(input, key, { route: 'web-fetch', tool });
  if (request !== null) return runs === null ? request : farther(request, runs);
  return runs ?? { tier: 'seen', route: 'arguments', tool };
}

/** Literals of one script that hold the key, each read as a command: past it, none is read. */
const MAX_PLACED_LITERALS = 256;

/**
 * Where the part of a Codex script no tool call explains put the key (`scriptRest`): the script
 * ran with the key in it, so it may have gone with any call it made, and each string literal that
 * holds it is read as a command, and as a request to the URLs in it.
 */
function scriptRestPlace(rest: string, key: Key, ctx: WhereContext): Place {
  const floor: Place = { tier: 'maybe', route: 'command-unread', tool: 'exec', detail: 'exec' };
  const literals = holding(stringsOf(rest), key);
  // Past the literals placed one by one, one not placed may send it anywhere.
  if (literals.length > MAX_PLACED_LITERALS) return { ...floor, tier: 'third_party' };
  return literals
    .map((text) => {
      const { hosts, unread } = urlHostsIn([text]);
      const asShell = shellPlace(text, key, ctx);
      return hosts.length === 0 && !unread
        ? asShell
        : farther(asShell, hostPlace(hosts, key, { route: 'command', tool: 'exec' }, { unread }));
    })
    .reduce(farther, floor);
}

/**
 * Where the arguments of one call put `key`. `scriptRest` is the part of a Codex script that no
 * tool call read explains: set by the reader of the rollout, never read from the record.
 */
export function placeOfArgument(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  key: Key,
  ctx: WhereContext,
  scriptRest = '',
): Place {
  const own = placeOfFields(tool, input, key, ctx);
  if (!keyForms(key.value).some((f) => scriptRest.includes(f))) return own;
  return farther(own, scriptRestPlace(scriptRest, key, ctx));
}

/** Fields of a shell call that are words for the user, not what the command is given. */
const SHELL_NOTES: ReadonlySet<string> = new Set(['description', 'justification', 'explanation']);

/**
 * Where a shell call put a key: by its command, and, for a key in another of its fields (a working
 * folder, a field Stroq does not know), "maybe": what the command is given may hold it.
 */
function shellCallPlace(
  input: Readonly<Record<string, unknown>>,
  key: Key,
  ctx: WhereContext,
): Place {
  const command = str(input['command']);
  const place = shellPlace(command, key, ctx);
  const elsewhere = Object.entries(input).some(
    ([field, value]) =>
      field !== 'command' &&
      field !== 'cmd' &&
      !SHELL_NOTES.has(field) &&
      holding([`${field}\n${inputText(value)}`], key).length > 0,
  );
  return elsewhere ? farther(place, { tier: 'maybe', route: 'arguments', tool: 'Bash' }) : place;
}

/** Where the arguments of one call put `key`, by the call's own fields. */
function placeOfFields(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  key: Key,
  ctx: WhereContext,
): Place {
  if (isShellTool(tool)) return { ...shellCallPlace(input, key, ctx), tool };
  if (tool === 'WebFetch') {
    // Its URL is read as a tool's request: its own use only by the strict proof (the key only in
    // the query parameter its service documents). The prompt goes to the model, not the host.
    const url = str(input['url']);
    if (!keyForms(key.value).some((f) => url.includes(f)))
      return { tier: 'seen', route: 'arguments', tool };
    return (
      toolRequestPlace({ url }, key, { route: 'web-fetch', tool }) ?? {
        tier: 'third_party',
        route: 'web-fetch',
        tool,
      }
    );
  }
  if (tool === 'WebSearch') return { tier: 'third_party', route: 'web-search', tool };
  const mcp = mcpPlace(tool, input, key, ctx);
  if (mcp !== null) return mcp;
  if (WRITE_TOOLS.has(tool)) {
    const file = writtenFile(input);
    const write: Place = {
      tier: 'seen',
      route: 'write',
      tool,
      ...(file === null ? {} : { detail: file }),
    };
    // What it wrote may be a script that sends the key: it went there if the file is run.
    return writtenPlace(write, scriptPlace(writtenText(input), key, ctx), null, '');
  }
  return otherToolPlace(tool, input, key);
}

/**
 * Stroq's reason for a stopped call, as every adapter words it: `Stroq blocked this action
 * (<rule>): …`, or `Stroq would ask before this action (<rule>): …`.
 */
const STROQ_REASON =
  /^Stroq (?:blocked this action|would ask before this action) \([\w.:-]{1,100}\): /;
/** What some hosts put before a hook's reason: `PreToolUse:Bash hook error: [<hook>]: `. */
const HOOK_PREFIX =
  /^PreToolUse(?::[\w.-]{1,128})? hook(?: error| blocked)?:(?: \[[^\]\n]{0,512}\]:)? /;
const USER_REFUSAL = "The user doesn't want to proceed with this tool use.";
/** A hook's reason is a sentence or two; a longer result is a command's own output. */
const MAX_STROQ_REASON = 4096;
/** A refusal can carry what you typed to the agent with it. */
const MAX_REFUSAL = 16_384;

/**
 * Tools whose result another party writes: an MCP server's reply (a server Stroq knows of or
 * not, a claude.ai connector), a fetched page, a web search. Such a result can say anything, the
 * words of a stop included, and the call it answers did run.
 */
const remoteResult = (tool: string): boolean => tool.startsWith('mcp__') || /^web/i.test(tool);

/**
 * Whether a result has the whole shape of a stop, and whose. A failed command's result is the
 * command's own output, and a command can print anything, so only a result with the whole shape
 * counts: short, not holding a saved output, and starting with Stroq's reason and its rule, or
 * (marked as an error) with Claude Code's words for a refusal. A result another party writes
 * (`remoteResult`) never counts: a call refused or blocked there is reported where it would have
 * gone.
 */
function stopShape(post: TranscriptPost): 'stroq' | 'user' | null {
  if (post.spilled === true || remoteResult(post.tool)) return null;
  const text = post.resultText.trimStart();
  if (text.length > MAX_REFUSAL) return null;
  if (post.isError === true && text.startsWith(USER_REFUSAL)) return 'user';
  if (text.length > MAX_STROQ_REASON) return null;
  const reason = text.replace(HOOK_PREFIX, '');
  return STROQ_REASON.test(reason) ? 'stroq' : null;
}

/**
 * Whether a call was stopped before it ran, and by whom: only Claude Code's own shape proves it,
 * a result it marks `is_error` that has the whole shape of a stop. Even so, what a stopped call
 * would have reached is kept (`wouldBe`), and `--fail-if third-party` still counts one bound for
 * another company.
 */
export function blockedBy(post: TranscriptPost, agent: string): 'stroq' | 'user' | null {
  if (agent !== 'claude-code' || post.isError !== true) return null;
  return stopShape(post);
}

/**
 * Whether the log says a call was stopped without proving it: a Codex or Cursor result that starts
 * with Stroq's reason. Such a result is the call's own output there, which a command can print, so
 * the call keeps the place it would have reached and the report only notes what the log says.
 */
export function saidStopped(post: TranscriptPost, agent: string): boolean {
  return agent !== 'claude-code' && stopShape(post) === 'stroq';
}
