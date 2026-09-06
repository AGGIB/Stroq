import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { toolResultToText } from './claude-code.js';
import { mcpToolName } from './cursor-mcp-name.js';
import { kindToolInput, type ToolKind } from './kind-input.js';
import { toolInputRecord } from './tool-input.js';
import { streamResultText } from './tool-result.js';

/**
 * Reading a Windsurf Cascade Hook payload: which event arrived, which Stroq tool that
 * event maps to, and where in `tool_info` the command, the path or the MCP call is.
 *
 * Windsurf is the first agent whose events name themselves AND whose tools are named
 * by the event rather than by a `tool_name` field, so there is no tool-name table
 * here — the event IS the tool. Everything past that is the shared reading:
 * `kind-input.ts` turns a kind plus raw arguments into the record the engine sees,
 * and `codex-input.ts` (through it) reads the command spellings. None of it is
 * copied: a divergence between two readers of one shape is a bypass that reproduces
 * on one agent only.
 */

/**
 * The six events Stroq installs on, in the order `init` writes them. The other six
 * Windsurf documents are deliberately absent: `post_write_code` (Cascade wrote the
 * content, so there is nothing untrusted to scan), `post_run_command` (its payload
 * carries the command line and cwd only — no output — so a hook there is a Node
 * start per command that can scan nothing), `pre_user_prompt` (the user's own words
 * are not Stroq's to police), `post_cascade_response` and
 * `post_cascade_response_with_transcript` (the model's own text, delivered
 * asynchronously) and `post_setup_worktree`.
 */
export const WINDSURF_EVENTS = [
  'pre_read_code',
  'post_read_code',
  'pre_write_code',
  'pre_run_command',
  'pre_mcp_tool_use',
  'post_mcp_tool_use',
] as const;
export type WindsurfEvent = (typeof WINDSURF_EVENTS)[number];

/**
 * Any other `agent_action_name` — an event Stroq did not install on, and any future
 * one — is answered with silence: Stroq does not block what it does not understand,
 * and blocking `pre_user_prompt` by accident would block the user.
 */
export const isWindsurfEvent = (value: string): value is WindsurfEvent =>
  (WINDSURF_EVENTS as readonly string[]).includes(value);

/**
 * The server name Stroq falls back to when a payload carries no `mcp_server_name`.
 * Windsurf normally DOES report the server — unlike Copilot and OpenClaw — so a
 * policy rule keyed on a real MCP server works here; this synthetic one exists only
 * so that a payload missing the field still composes a name core's
 * `parseMcpToolName` accepts, which is what puts the arguments in front of the
 * secret-egress guard.
 */
export const WINDSURF_MCP_SERVER = 'windsurf';

/** What each event does, which decides both its Stroq name and its input shape. */
const KINDS: Readonly<Record<WindsurfEvent, ToolKind>> = {
  pre_read_code: 'read',
  post_read_code: 'read',
  pre_write_code: 'write',
  pre_run_command: 'shell',
  pre_mcp_tool_use: 'mcp',
  post_mcp_tool_use: 'mcp',
};

export const windsurfToolKind = (event: WindsurfEvent): ToolKind => KINDS[event];

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

/**
 * `mcp__<server>__<tool>` from the two fields Windsurf reports. The server is always
 * composed from `mcp_server_name`, never parsed out of the tool name, so a tool that
 * calls itself `mcp__trusted__send` cannot override the server the payload actually
 * named — the shared sanitiser's rule, applied here by never passing an empty server.
 */
function windsurfMcpName(toolInfo: unknown): string {
  const record = toolInputRecord(toolInfo);
  const server = stringField(record, 'mcp_server_name');
  return mcpToolName(
    server === '' ? WINDSURF_MCP_SERVER : server,
    stringField(record, 'mcp_tool_name'),
  );
}

/** True when `pre_write_code` carried at least one edit, i.e. it is an edit and not a create. */
function hasEdits(toolInfo: unknown): boolean {
  const edits = toolInputRecord(toolInfo)['edits'];
  return Array.isArray(edits) && edits.length > 0;
}

/**
 * The Stroq tool name for one event. `Write` and `Edit` classify identically (both
 * are in core's `WRITE_TOOLS`), so the split is for the audit's readability, not for
 * the decision.
 */
export function windsurfToolName(event: WindsurfEvent, toolInfo: unknown): string {
  const kind = windsurfToolKind(event);
  if (kind === 'mcp') return windsurfMcpName(toolInfo);
  if (kind === 'shell') return 'Bash';
  if (kind === 'read') return 'Read';
  return hasEdits(toolInfo) ? 'Edit' : 'Write';
}

/**
 * The raw arguments the shared reader is given. For an MCP call that is
 * `mcp_tool_arguments` and nothing else: the whole record reaches the engine, so the
 * secret-egress guard scans every field of it, and the server and tool names — which
 * are the call's identity, not its arguments — stay out. Every other event hands over
 * `tool_info` itself.
 */
export function windsurfToolArgs(event: WindsurfEvent, toolInfo: unknown): unknown {
  if (windsurfToolKind(event) !== 'mcp') return toolInfo;
  return toolInputRecord(toolInfo)['mcp_tool_arguments'];
}

/**
 * Dropped from the record a file tool hands the engine: `path` has just been rewritten
 * as the `file_path` every rule, summary and audit line reads, and two keys meaning
 * the same thing is how they drift apart. Windsurf's own spelling IS `file_path`, so
 * this only fires on the defensive alternative.
 */
const DROPPED_FILE_FIELDS: readonly string[] = ['path'];

/**
 * The record the engine sees. The reading is `kind-input.ts`'s, shared with the
 * Copilot and OpenClaw adapters. One consequence worth naming: a shell call is
 * reduced to `{ command }`, so `tool_info.cwd` is not carried into the action — where
 * a command runs is not part of what it does, and that field is model-chosen and is
 * never read for policy anywhere (see `handleWindsurfHook`, which uses the hook
 * process's own `process.cwd()`).
 */
export const windsurfToolInput = (event: WindsurfEvent, args: unknown): Record<string, unknown> =>
  kindToolInput(windsurfToolKind(event), args, DROPPED_FILE_FIELDS);

/**
 * The most of a file Stroq reads for a `post_read_code` scan. Windsurf's payload
 * carries the path and not the content, so Stroq opens the file itself — and a hook
 * with no documented timeout must not be the thing that reads a planted gigabyte.
 * One MiB is far more than any prompt-injection payload needs and is bounded work.
 */
export const WINDSURF_MAX_READ_BYTES = 1_048_576;

/** At most `WINDSURF_MAX_READ_BYTES` of an already-stat'ed regular file. */
function readCapped(path: string, size: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, WINDSURF_MAX_READ_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * What Cascade just read, read again by Stroq. `post_read_code` carries only a path,
 * so this is the whole content scan for a Windsurf file read. A relative path is
 * resolved against the policy cwd (the workspace root). A directory — Cascade reads
 * recursively — a missing or unreadable file, an empty path and an empty file all
 * return `''`, which the adapter turns into exit 0 and silence: a read that gave
 * Cascade nothing gave the model nothing either, so there is nothing to scan and
 * nothing to report. Every failure is swallowed for the same reason: this function
 * cannot be the thing that fails a hook.
 */
export function windsurfReadText(filePath: string, cwd: string): string {
  if (filePath === '') return '';
  try {
    const path = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0) return '';
    return readCapped(path, stats.size);
  } catch {
    // Missing, unreadable, a broken symlink, a permissions error: nothing to scan.
    return '';
  }
}

/**
 * The text of a completed MCP call. Windsurf documents `mcp_result` as a string; the
 * shapes below it are what a future build or a proxy might send, read by the same
 * helpers every other adapter uses. An empty string is not the field being in play —
 * an agent can send `mcp_result: ''` — so it must not shadow anything else.
 */
export function windsurfResultText(toolInfo: unknown): string {
  const result = toolInputRecord(toolInfo)['mcp_result'];
  if (typeof result === 'string' && result !== '') return toolResultToText(result);
  return streamResultText(result);
}

/**
 * The events where a Stroq internal error answers with exit 2 rather than silence.
 * `pre_read_code` is deliberately absent, and that is a trade-off rather than a claim
 * that nothing there is ever denied: a read of `.env` in a tainted session IS denied
 * (`deny-secrets-when-tainted`), so an internal error on that call fails open on a
 * real deny. It is the same call Claude Code, Codex, Copilot and OpenClaw make for
 * their own read tools — the fail-closed path exists for the actions that change
 * something, and stalling the agent on every failed read buys less than it costs.
 * Every `post_*` event has already happened, and an unknown event is not Stroq's to
 * block.
 */
const FAIL_CLOSED_EVENTS: ReadonlySet<string> = new Set([
  'pre_run_command',
  'pre_write_code',
  'pre_mcp_tool_use',
]);

export const isWindsurfHighImpact = (event: string): boolean => FAIL_CLOSED_EVENTS.has(event);
