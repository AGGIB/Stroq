<!--
  GENERATED FILE. Do not hand-edit.
  Produced by `pnpm generate:reports` from `host channel visibility definitions`'s own output.
  Refresh it with `pnpm generate:reports`; `pnpm check:reports` fails CI if
  this file and the command's live output disagree.
-->

# Host channel visibility

Which event channels each host hook interface observes, and which steps of recorded attacks each host can actually see.

Stroq runs against multiple agent hosts and hook architectures. Each host exposes a different subset of tool invocations and results: some hosts observe shell execution and file edits but never native file reads; some observe MCP tool calls but have no hook for web fetching; others observe only proxy traffic.

When evaluating attack scenarios with `stroq attack --host <id>`, Stroq identifies steps that occur on channels not observed by that host. If any step of an attack scenario occurs on an unobserved channel, that step is flagged as unsupported, and the attack run exits 1 — ensuring that an attack is never reported as defended when the host could not have observed the attack's precursor actions.

## Channels

- `shell command`: PreToolUse hook on terminal and shell commands (`Bash`, `PowerShell`, `exec`, etc.).
- `file write`: PreToolUse hook on file modification tools (`Write`, `Edit`, `apply_patch`, etc.).
- `file read`: PreToolUse hook on file reading tools (`Read`, `str_replace_editor view`, etc.).
- `MCP call`: PreToolUse hook on Model Context Protocol tool execution (`mcp__*`, etc.).
- `tool result`: PostToolUse observation hook scanning command output, file bodies, or tool responses.
- `web fetch`: PreToolUse / PostToolUse hook on URL requests and web fetching tools (`WebFetch`, `WebSearch`, `web_fetch`, etc.).

## Channel visibility matrix

| Host | shell command | file write | file read | MCP call | tool result | web fetch |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-code` | seen | seen | seen | seen | seen | seen |
| `cursor` | seen | partial | partial | seen | seen | not seen |
| `codex` | seen | seen | not seen | seen | partial | not seen |
| `copilot` | seen | seen | seen | seen | seen | seen |
| `openclaw` | seen | seen | seen | seen | seen | seen |
| `windsurf` | seen | seen | seen | seen | partial | not seen |
| `antigravity` | seen | seen | seen | seen | partial | seen |
| `mcp` | not seen | not seen | not seen | seen | seen | not seen |

## Host details

| Host | Channel | Status | Evidence / Reference |
| --- | --- | --- | --- |
| `claude-code` | shell command | seen | PreToolUse on Bash and command execution tools (docs/AGENTS.md) |
| `claude-code` | file write | seen | PreToolUse on Write and Edit tools (docs/AGENTS.md) |
| `claude-code` | file read | seen | PreToolUse on Read tool (docs/AGENTS.md) |
| `claude-code` | MCP call | seen | PreToolUse on mcp__* tools (docs/AGENTS.md) |
| `claude-code` | tool result | seen | PostToolUse on terminal, file, fetch, and MCP outputs (docs/AGENTS.md) |
| `claude-code` | web fetch | seen | PreToolUse and PostToolUse on WebFetch and WebSearch (docs/AGENTS.md) |
| `cursor` | shell command | seen | beforeShellExecution hook (docs/AGENTS.md#cursor) |
| `cursor` | file write | partial | preToolUse matched to Write and Delete; untargeted editor edits not intercepted (docs/AGENTS.md#cursor) |
| `cursor` | file read | partial | beforeReadFile can allow or deny, but cannot prompt an ask (docs/AGENTS.md#cursor) |
| `cursor` | MCP call | seen | beforeMCPExecution hook (docs/AGENTS.md#cursor) |
| `cursor` | tool result | seen | afterShellExecution, afterMCPExecution, and afterFileEdit (docs/AGENTS.md#cursor) |
| `cursor` | web fetch | not seen | Cursor has no hook for web content fetched by agent (docs/AGENTS.md#cursor) |
| `codex` | shell command | seen | PreToolUse on Bash and shell execution aliases (docs/AGENTS.md#codex) |
| `codex` | file write | seen | PreToolUse on apply_patch headers (docs/AGENTS.md#codex) |
| `codex` | file read | not seen | Codex has no pre-read hook; files are read directly without a tool hook (docs/AGENTS.md#codex) |
| `codex` | MCP call | seen | PreToolUse on mcp__.* tools (docs/AGENTS.md#codex) |
| `codex` | tool result | partial | PostToolUse on shell and MCP results; web reads never reach hooks (docs/AGENTS.md#codex) |
| `codex` | web fetch | not seen | Hosted tools such as WebSearch never reach hooks (docs/AGENTS.md#codex) |
| `copilot` | shell command | seen | preToolUse on bash and shell command tools (docs/AGENTS.md#copilot-cli) |
| `copilot` | file write | seen | preToolUse on file tools and apply_patch (docs/AGENTS.md#copilot-cli) |
| `copilot` | file read | seen | preToolUse on file tools including str_replace_editor view (docs/AGENTS.md#copilot-cli) |
| `copilot` | MCP call | seen | preToolUse treating unlisted tools as MCP calls (docs/AGENTS.md#copilot-cli) |
| `copilot` | tool result | seen | postToolUse scanning output, files, web pages, and MCP (docs/AGENTS.md#copilot-cli) |
| `copilot` | web fetch | seen | preToolUse on web_fetch URLs (docs/AGENTS.md#copilot-cli) |
| `openclaw` | shell command | seen | before_tool_call on exec and terminal shell tools (docs/AGENTS.md#openclaw) |
| `openclaw` | file write | seen | before_tool_call on write, edit, and apply_patch (docs/AGENTS.md#openclaw) |
| `openclaw` | file read | seen | before_tool_call on read (docs/AGENTS.md#openclaw) |
| `openclaw` | MCP call | seen | before_tool_call treating unrecognised tools as mcp__openclaw__* (docs/AGENTS.md#openclaw) |
| `openclaw` | tool result | seen | after_tool_call observe hook scanning output, files, web, and tools (docs/AGENTS.md#openclaw) |
| `openclaw` | web fetch | seen | before_tool_call on web_fetch and web_search (docs/AGENTS.md#openclaw) |
| `windsurf` | shell command | seen | pre_run_command hook (docs/AGENTS.md#windsurf) |
| `windsurf` | file write | seen | pre_write_code hook (docs/AGENTS.md#windsurf) |
| `windsurf` | file read | seen | pre_read_code hook (docs/AGENTS.md#windsurf) |
| `windsurf` | MCP call | seen | pre_mcp_tool_use hook (docs/AGENTS.md#windsurf) |
| `windsurf` | tool result | partial | post_read_code and post_mcp_tool_use; command output and web pages invisible (docs/AGENTS.md#windsurf) |
| `windsurf` | web fetch | not seen | Web pages Cascade fetches have no hook event at all (docs/AGENTS.md#windsurf) |
| `antigravity` | shell command | seen | PreToolUse on CommandLine (docs/AGENTS.md#google-antigravity) |
| `antigravity` | file write | seen | PreToolUse on create_file and edit_file (docs/AGENTS.md#google-antigravity) |
| `antigravity` | file read | seen | PreToolUse on file read tools (docs/AGENTS.md#google-antigravity) |
| `antigravity` | MCP call | seen | PreToolUse on mcp__antigravity__* tools (docs/AGENTS.md#google-antigravity) |
| `antigravity` | tool result | partial | PostToolUse opens read path up to 1 MiB and scans errors only; no result field (docs/AGENTS.md#google-antigravity) |
| `antigravity` | web fetch | seen | PreToolUse on Url and fetch tools (docs/AGENTS.md#google-antigravity) |
| `mcp` | shell command | not seen | stdio proxy intercepts MCP JSON-RPC, has no shell execution channel (docs/AGENTS.md#mcp-proxy-any-mcp-client) |
| `mcp` | file write | not seen | proxy intercepts MCP tools/call, has no native file write channel (docs/AGENTS.md#mcp-proxy-any-mcp-client) |
| `mcp` | file read | not seen | proxy intercepts MCP tools/call and resources/read, no native file read (docs/AGENTS.md#mcp-proxy-any-mcp-client) |
| `mcp` | MCP call | seen | tools/call request interception (docs/AGENTS.md#mcp-proxy-any-mcp-client) |
| `mcp` | tool result | seen | tools/call, tools/list, and resources/read result scanning (docs/AGENTS.md#mcp-proxy-any-mcp-client) |
| `mcp` | web fetch | not seen | proxy has no web fetch interception channel (docs/AGENTS.md#mcp-proxy-any-mcp-client) |
