# Cursor adapter — design spec (2026-09-05)

**Goal.** One install (`stroq init --agent cursor`) gives Cursor's agent the same protection Claude Code has: content scan + session taint, provenance, secret egress guard, ordered policy, hash-chained audit — through Cursor's native hooks, offline, fail-closed for high-impact actions.

**Source of truth for the hook contract.** Cursor docs (`cursor.com/docs/hooks`, fetched 2026-09-05) and the community schema guide. Where the two disagree, the official page wins; the adapter tolerates both field spellings.

## 1. What Cursor gives us

| Cursor event | Blocking? | Input we use | Output we can give | Stroq phase |
| --- | --- | --- | --- | --- |
| `beforeShellExecution` | yes | `command`, `cwd`, `sandbox` | `permission: allow\|ask\|deny`, `user_message`, `agent_message` | `pre` — tool `Bash` |
| `afterShellExecution` | no | `command`, `output` (full terminal output), `duration`; community: `stdout`/`stderr`/`exit_code` | none honoured | `post` — tool `Bash`, `toolResultText = output ?? stdout+stderr` |
| `beforeMCPExecution` | yes | `tool_name`, `tool_input` (JSON string or object), `mcp_server_name`, `url`/`command` | `permission`, `user_message`, `agent_message` (`updated_input` exists; unused) | `pre` — tool `mcp__<server>__<tool>` |
| `afterMCPExecution` | no | `tool_name`, `tool_input`, `mcp_server_name`, `result_json` (string); community: `tool_output` | `additional_context`, `updated_mcp_tool_output` | `post` — tool `mcp__<server>__<tool>`, `toolResultText = result_json` |
| `beforeReadFile` | yes (allow/deny only) | `file_path`, `content`, `attachments` | `permission: allow\|deny`, `user_message` | `post`-style scan of `content` **before** the agent sees it (tool `Read`), plus `pre` classification of the path (`fs.secrets`) |
| `afterFileEdit` | no | `file_path`, `edits[{old_string,new_string}]` | none | `pre`-style classification of the path for `config.self` audit only (cannot block — Cursor has no beforeFileEdit) |
| `beforeSubmitPrompt`, `stop`, `sessionStart/End`, `preToolUse/postToolUse` (generic) | — | — | — | not used in v1 (`preToolUse` generic event is newer and less documented; revisit) |

Common fields on every event: `conversation_id` (→ Stroq session id), `generation_id`, `hook_event_name`, `workspace_roots[0]` (→ cwd fallback).

Semantics that shape the design:

- Exit code `2` = block; any other non-zero exit = fail-open unless the hook is configured with `failClosed: true`. Stroq's `init` writes `failClosed: true` on every blocking hook and Stroq additionally prints an explicit `deny` JSON on internal errors for high-impact actions (same as Claude Code).
- Empty stdout = allow. Stroq prints nothing on allow (smallest surface, matches the Claude Code adapter), except when there is a warning to attach.
- `beforeReadFile` cannot `ask`; a suspect file is **allowed** (reading is not high-impact) with the taint set and a `user_message` warning; a `fs.secrets` path under a tainted session follows the policy (`deny-secrets-when-tainted` → `deny`).
- `afterShellExecution`/`afterMCPExecution` cannot inject a warning to the agent for shell output; MCP output can carry `additional_context` (use it, same text as Claude Code's warning). Shell-output taint is therefore silent to the agent but enforced on the next action.
- Hooks run with cwd = project root for project hooks; `workspace_roots[0]` is the reliable project path.

## 2. Adapter contract (mirrors `adapters/claude-code.ts`)

- `packages/cli/src/adapters/cursor.ts`
  - `CursorHookInputSchema` (zod `looseObject`): `conversation_id: string`, `hook_event_name: enum[...]`, `workspace_roots: string[]` (default `[]`), optional `command`, `cwd`, `output`, `stdout`, `stderr`, `exit_code`, `tool_name`, `tool_input: unknown`, `mcp_server_name`, `result_json`, `tool_output`, `file_path`, `content`, `edits`.
  - `handleCursorHook(engine, raw): Promise<HookOutput>` — `HookOutput` reused (`stdout`, `exitCode`).
  - Mapping to engine events: `sessionId = conversation_id`; `cwd = cwd ?? workspace_roots[0] ?? process.cwd()`; tool names: `Bash` for shell, `mcp__${server}__${tool}` for MCP (server name sanitised to `[A-Za-z0-9_-]`), `Read` for beforeReadFile, `Write` for afterFileEdit; `toolInput`: `{command}` / MCP args (parse `tool_input` string as JSON, fall back to `{raw}`) / `{file_path}`.
  - Decision rendering: `deny` → `{"permission":"deny","user_message":"Stroq blocked …","agent_message":"<same + evidence>"}`; `ask` → `{"permission":"ask", …}`; `allow` → empty stdout (exit 0).
  - Post rendering: `afterMCPExecution` suspect → `{"additional_context": warningFor(...)}`; `afterShellExecution` → empty; `beforeReadFile` suspect → `{"permission":"allow","user_message":"⚠ Stroq: this file contains instruction-like text … session is now restricted"}`; `beforeReadFile` with a `fs.secrets` deny → `{"permission":"deny",…}`.
  - Fail-closed: `failClosedOutput` equivalent for `beforeShellExecution`/`beforeMCPExecution` → `deny` JSON (exit 0) with the internal error; `beforeReadFile` errors → allow (reading is not high-impact; taint may be missed — documented).
- `packages/cli/src/commands/hook.ts`: `stroq hook cursor` routes to the adapter; unknown agent message lists both.
- `packages/cli/src/commands/init.ts`: `--agent claude-code|cursor` (default claude-code); for cursor, write `<project>/.cursor/hooks.json` (or `~/.cursor/hooks.json` with `--user`): `{"version":1,"hooks":{ "beforeShellExecution":[{command, failClosed:true, timeout:15}], "afterShellExecution":[{command, timeout:15}], "beforeMCPExecution":[{…failClosed:true}], "afterMCPExecution":[…], "beforeReadFile":[…], "afterFileEdit":[…] }}`, merging with existing entries and replacing older Stroq entries (identified by the `hook cursor` suffix), idempotent, `--dry-run`. Command string: `"<node>" "<entry>" hook cursor`.
- `stroq doctor`: a `cursor hooks` line: `project: installed (path)` / `missing`, mirroring the Claude Code line; overall `ok` requires at least one agent installed.
- README: "Supported today: Claude Code, Cursor"; Install section gains `--agent cursor`; a "Cursor" subsection listing what is and is not covered (no warning injection after shell output; `beforeReadFile` allow-only; edits cannot be blocked → `config.self` writes through Cursor's editor are audited, not blocked; Windows untested).
- SECURITY.md: Cursor adapter in scope.
- Demo: `examples/demo/cursor-events/` (poisoned `beforeReadFile` taints; `beforeShellExecution` `curl | sh` denied; a benign `ls` allowed; poisoned `afterMCPExecution` → `additional_context`; `beforeMCPExecution` carrying a `.env` value → denied) and `run-cursor-demo.sh`.

## 3. Deliberately out of scope (v1)

Cursor Tab hooks (`beforeTabFileRead`, `afterTabFileEdit`), `preToolUse`/`postToolUse` generic events, `updated_input` rewriting, `beforeSubmitPrompt`, enterprise/team hook locations, the Cursor CLI (`cursor-agent`) — documented as untested, expected to work if it honours `.cursor/hooks.json`.

## 4. Test strategy

- Adapter unit tests with recorded payloads (both official and community spellings) → engine decisions → JSON output; fail-closed for shell/MCP internal errors; allow-only for beforeReadFile.
- `init --agent cursor` merge/idempotency/dry-run tests like the Claude Code ones.
- e2e: spawn the CLI with `hook cursor` on stdin JSON across a taint → deny sequence (like `hook.e2e.test.ts`).
- `stroq attack` scenarios stay Claude-Code-shaped (the engine is shared); no Cursor scenarios in v1.

## 5. Assumptions

1. Default `init` stays Claude Code; Cursor via `--agent cursor` (not auto-detect).
2. `beforeReadFile` denies only `fs.secrets` paths under taint; never blocks ordinary reads.
3. The hook wrapper approach (plugin) is Claude-Code-only; Cursor has no plugin system, so `init` is the only install path.
