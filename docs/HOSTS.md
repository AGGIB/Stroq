<!--
  GENERATED FILE. Do not hand-edit.
  Produced by `pnpm generate:reports` from `stroq attack --host <id>`'s channel table.
  Refresh it with `pnpm generate:reports`; `pnpm check:reports` fails CI if
  this file and the channel table in `packages/cli/src/hosts/channels.ts` disagree.
-->

# Host Channel Coverage

Which scenario step channels each host actually sends to Stroq, generated from [`packages/cli/src/hosts/channels.ts`](../packages/cli/src/hosts/channels.ts).

`stroq attack` replays the 36-scenario corpus in-process using Claude Code hook events. When you pass `--host <id>`, each step is checked against the target host’s row below before the engine runs it:

- **`seen`** — the host emits a hook event for this channel and enforces or records the step as documented.
- **`partial`** — only the documented subset of this channel is available. Replay checks the phase and tool as well: for example, Windsurf MCP output is supported but shell output is unsupported. Wire and decision limits remain as documented in [`docs/AGENTS.md`](./AGENTS.md); this replay does not measure host enforcement.
- **`not seen`** — the host never sends this channel to Stroq. Under `stroq attack --host <id>`, any step on this channel is reported as `unsupported`, counted apart from `blocked`, `asked` and `passed`, never counted as a protection, and fails the exit code (`1`).
- **`unknown`** — not yet checked against the host; treated as `unsupported` (`not seen`) so an untested channel is never counted as a protection.

## Channel matrix

| Host | `--host` | shell command | file write | file read | MCP call | tool result | web fetch | Supported steps | Unsupported scenarios |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: |
| [Claude Code](./AGENTS.md#claude-code) | `claude-code` | `seen` | `seen` | `seen` | `seen` | `seen` | `partial` | 59 / 59 | 0 / 36 |
| [Cursor](./AGENTS.md#cursor) | `cursor` | `seen` | `partial` | `partial` | `seen` | `partial` | `not seen` | 55 / 59 | 4 / 36 |
| [Codex](./AGENTS.md#codex) | `codex` | `partial` | `partial` | `not seen` | `partial` | `partial` | `not seen` | 48 / 59 | 11 / 36 |
| [Copilot CLI](./AGENTS.md#copilot-cli) | `copilot` | `seen` | `seen` | `seen` | `partial` | `partial` | `seen` | 59 / 59 | 0 / 36 |
| [OpenClaw](./AGENTS.md#openclaw) | `openclaw` | `seen` | `seen` | `seen` | `partial` | `partial` | `seen` | 59 / 59 | 0 / 36 |
| [Windsurf](./AGENTS.md#windsurf) | `windsurf` | `partial` | `partial` | `partial` | `partial` | `partial` | `not seen` | 50 / 59 | 9 / 36 |
| [Google Antigravity](./AGENTS.md#google-antigravity) | `antigravity` | `seen` | `seen` | `partial` | `partial` | `not seen` | `partial` | 46 / 59 | 13 / 36 |
| [MCP proxy (any MCP client)](./AGENTS.md#mcp-proxy-any-mcp-client) | `mcp` | `not seen` | `not seen` | `not seen` | `partial` | `partial` | `not seen` | 8 / 59 | 33 / 36 |

## Evidence by host

### Claude Code (`claude-code`)

Adapter reference: [`docs/AGENTS.md#claude-code`](./AGENTS.md#claude-code)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `seen` | packages/cli/test/fixtures/hosts/claude-code/2.1.271/deny.real.acceptEdits.jsonl — PreToolUse classifies Bash and PowerShell with allow, ask and deny. |
| file write | `seen` | docs/AGENTS.md#claude-code — PreToolUse classifies Write, Edit, MultiEdit and NotebookEdit before the write runs. |
| file read | `seen` | docs/AGENTS.md#claude-code — PreToolUse checks Read paths and PostToolUse scans the file body. |
| MCP call | `seen` | docs/AGENTS.md#claude-code — PreToolUse matches mcp__.* and classifies server, tool and arguments. |
| tool result | `seen` | docs/AGENTS.md#claude-code — PostToolUse and PostToolUseFailure scan Bash, PowerShell and mcp__.* output. |
| web fetch | `partial` | docs/AGENTS.md#claude-code — PreToolUse classifies WebFetch URLs; PostToolUse scans WebFetch and WebSearch results. WebSearch has no installed pre-hook. |

Unsupported steps in `stroq attack --host claude-code`: none (59 / 59 steps supported across 36 scenarios).

### Cursor (`cursor`)

Adapter reference: [`docs/AGENTS.md#cursor`](./AGENTS.md#cursor)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `seen` | docs/AGENTS.md#cursor — beforeShellExecution classifies commands with deny and ask; the recorded Windows capture measured editor writes only. |
| file write | `partial` | packages/cli/test/fixtures/hosts/cursor/3.24.18-win32/hooks.jsonl — preToolUse (Write\|Delete) classifies target paths with ask mapped to deny; Tab edits are outside hooks. |
| file read | `partial` | docs/AGENTS.md#cursor — beforeReadFile scans file content and denies credential reads under taint, without an ask decision. |
| MCP call | `seen` | docs/AGENTS.md#cursor — beforeMCPExecution classifies MCP calls and arguments with deny and ask. |
| tool result | `partial` | docs/AGENTS.md#cursor — afterShellExecution and afterMCPExecution scan output and taint the session; afterShellExecution honours no warning output. |
| web fetch | `not seen` | docs/AGENTS.md#cursor — Cursor emits no hook event for content its agent fetches from the web. |

Unsupported steps in `stroq attack --host cursor` (4 of 59 steps across 4 of 36 scenarios): `05-roguepilot-schema-url` step 1 (`pre WebFetch`, web fetch), `07-settings-hook-removal` step 1 (`post WebFetch`, web fetch), `11-fetched-page-ssh-key-upload` step 1 (`post WebFetch`, web fetch), `28-kiro-mcp-json-shell-server` step 1 (`post WebFetch`, web fetch).

### Codex (`codex`)

Adapter reference: [`docs/AGENTS.md#codex`](./AGENTS.md#codex)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `partial` | packages/cli/test/fixtures/hosts/codex/0.162.1/deny.real.jsonl — PreToolUse (Bash) classifies shell commands; ask is mapped to deny. |
| file write | `partial` | docs/AGENTS.md#codex — PreToolUse (apply_patch) classifies declared paths only, not patch body text, with ask mapped to deny. |
| file read | `not seen` | docs/AGENTS.md#codex — PreToolUse and PostToolUse matchers cover Bash, apply_patch and mcp__.* only; Codex emits no file-read hook. |
| MCP call | `partial` | docs/AGENTS.md#codex — PreToolUse (mcp__.*) classifies MCP calls and arguments, with ask mapped to deny. |
| tool result | `partial` | docs/AGENTS.md#codex — PostToolUse scans Bash and mcp__.* output and warns via additionalContext. |
| web fetch | `not seen` | docs/AGENTS.md#codex — Hosted tools such as WebSearch never reach Codex hooks. |

Unsupported steps in `stroq attack --host codex` (11 of 59 steps across 11 of 36 scenarios): `01-readme-pipe-to-shell` step 1 (`post Read`, file read), `05-roguepilot-schema-url` step 1 (`pre WebFetch`, web fetch), `07-settings-hook-removal` step 1 (`post WebFetch`, web fetch), `10-skill-base64-installer` step 1 (`post Read`, file read), `11-fetched-page-ssh-key-upload` step 1 (`post WebFetch`, web fetch), `14-agents-md-invisible-hook-disable` step 1 (`post Read`, file read), `20-pdf-text-exec` step 1 (`post Read`, file read), `21-memory-persistence` step 1 (`post Read`, file read), `24-ghostapproval-symlink-authorized-keys` step 1 (`post Read`, file read), `28-kiro-mcp-json-shell-server` step 1 (`post WebFetch`, web fetch), `36-script-launders-taint-upload` step 1 (`post Read`, file read).

### Copilot CLI (`copilot`)

Adapter reference: [`docs/AGENTS.md#copilot-cli`](./AGENTS.md#copilot-cli)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `seen` | docs/AGENTS.md#copilot-cli — preToolUse classifies bash and powershell commands with deny and ask. |
| file write | `seen` | docs/AGENTS.md#copilot-cli — preToolUse classifies create/edit/write and apply_patch with deny and ask. |
| file read | `seen` | docs/AGENTS.md#copilot-cli — preToolUse checks view/read paths and postToolUse scans the file body. |
| MCP call | `partial` | docs/AGENTS.md#copilot-cli — preToolUse classifies non-native tools as mcp__copilot__&lt;tool&gt;; server name is omitted by the host. |
| tool result | `partial` | docs/AGENTS.md#copilot-cli — postToolUse scans command and MCP output and taints the session silently because stdout is ignored. |
| web fetch | `seen` | docs/AGENTS.md#copilot-cli — preToolUse classifies web_fetch URLs and postToolUse scans fetched content. |

Unsupported steps in `stroq attack --host copilot`: none (59 / 59 steps supported across 36 scenarios).

### OpenClaw (`openclaw`)

Adapter reference: [`docs/AGENTS.md#openclaw`](./AGENTS.md#openclaw)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `seen` | docs/AGENTS.md#openclaw — before_tool_call classifies exec and shell aliases with block and requireApproval. |
| file write | `seen` | docs/AGENTS.md#openclaw — before_tool_call classifies write, edit and apply_patch with block and requireApproval. |
| file read | `seen` | docs/AGENTS.md#openclaw — before_tool_call checks read paths and after_tool_call scans the returned file body. |
| MCP call | `partial` | docs/AGENTS.md#openclaw — before_tool_call classifies non-native tools as mcp__openclaw__&lt;tool&gt;; server name is omitted. |
| tool result | `partial` | docs/AGENTS.md#openclaw — after_tool_call scans tool output and taints the session silently as a fire-and-forget event. |
| web fetch | `seen` | docs/AGENTS.md#openclaw — before_tool_call classifies web_fetch URLs and after_tool_call scans fetched pages. |

Unsupported steps in `stroq attack --host openclaw`: none (59 / 59 steps supported across 36 scenarios).

### Windsurf (`windsurf`)

Adapter reference: [`docs/AGENTS.md#windsurf`](./AGENTS.md#windsurf)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `partial` | docs/AGENTS.md#windsurf — pre_run_command classifies command lines and blocks via exit 2, with ask mapped to block. |
| file write | `partial` | docs/AGENTS.md#windsurf — pre_write_code classifies target paths and edits, with ask mapped to block. |
| file read | `partial` | docs/AGENTS.md#windsurf — pre_read_code checks paths and post_read_code opens and scans the file on disk up to 1 MiB. |
| MCP call | `partial` | docs/AGENTS.md#windsurf — pre_mcp_tool_use classifies mcp__&lt;server&gt;__&lt;tool&gt; and arguments, with ask mapped to block. |
| tool result | `partial` | docs/AGENTS.md#windsurf — post_mcp_tool_use scans MCP results; post_run_command carries no command output. |
| web fetch | `not seen` | docs/AGENTS.md#windsurf — Cascade web fetches have no hook event and never reach Stroq. |

Unsupported steps in `stroq attack --host windsurf` (9 of 59 steps across 9 of 36 scenarios): `04-s1ngularity-public-repo` step 1 (`post Bash`, tool result), `05-roguepilot-schema-url` step 1 (`pre WebFetch`, web fetch), `06-env-dump-exfil` step 1 (`post Bash`, tool result), `07-settings-hook-removal` step 1 (`post WebFetch`, web fetch), `11-fetched-page-ssh-key-upload` step 1 (`post WebFetch`, web fetch), `17-ci-log-instruction` step 1 (`post Bash`, tool result), `18-filename-instruction` step 1 (`post Bash`, tool result), `19-dependency-postinstall-persistence` step 1 (`post Bash`, tool result), `28-kiro-mcp-json-shell-server` step 1 (`post WebFetch`, web fetch).

### Google Antigravity (`antigravity`)

Adapter reference: [`docs/AGENTS.md#google-antigravity`](./AGENTS.md#google-antigravity)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `seen` | docs/AGENTS.md#google-antigravity — PreToolUse classifies run_command and shell aliases with deny and force_ask. |
| file write | `seen` | docs/AGENTS.md#google-antigravity — PreToolUse classifies create_file and edit_file with deny and force_ask. |
| file read | `partial` | docs/AGENTS.md#google-antigravity — PreToolUse checks view_file paths and PostToolUse opens the file on disk up to 1 MiB. |
| MCP call | `partial` | docs/AGENTS.md#google-antigravity — PreToolUse classifies non-native tools as mcp__antigravity__&lt;tool&gt;; server name is omitted. |
| tool result | `not seen` | docs/AGENTS.md#google-antigravity — PostToolUse carries no tool_response field; command and MCP results never reach hooks. |
| web fetch | `partial` | docs/AGENTS.md#google-antigravity — PreToolUse classifies read_url_content and web_fetch URLs; PostToolUse carries no page body. |

Unsupported steps in `stroq attack --host antigravity` (13 of 59 steps across 13 of 36 scenarios): `02-sentry-agentjacking` step 1 (`post mcp__sentry__get_issue`, tool result), `04-s1ngularity-public-repo` step 1 (`post Bash`, tool result), `06-env-dump-exfil` step 1 (`post Bash`, tool result), `07-settings-hook-removal` step 1 (`post WebFetch`, web fetch), `11-fetched-page-ssh-key-upload` step 1 (`post WebFetch`, web fetch), `15-issue-title-pipe-to-shell` step 1 (`post mcp__github__get_issue`, tool result), `16-issue-body-html-comment-exfil` step 1 (`post mcp__github__get_issue`, tool result), `17-ci-log-instruction` step 1 (`post Bash`, tool result), `18-filename-instruction` step 1 (`post Bash`, tool result), `19-dependency-postinstall-persistence` step 1 (`post Bash`, tool result), `28-kiro-mcp-json-shell-server` step 1 (`post WebFetch`, web fetch), `29-memtry-mcp-onboarding-harvest` step 1 (`post mcp__memtry__memtry_onboarding`, tool result), `30-clinejection-issue-title-install` step 1 (`post mcp__github__get_issue`, tool result).

### MCP proxy (any MCP client) (`mcp`)

Adapter reference: [`docs/AGENTS.md#mcp-proxy-any-mcp-client`](./AGENTS.md#mcp-proxy-any-mcp-client)

| Channel | Status | Evidence |
| :--- | :--- | :--- |
| shell command | `not seen` | docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native shell tool. |
| file write | `not seen` | docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native file writes. |
| file read | `not seen` | docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native file reads. |
| MCP call | `partial` | docs/AGENTS.md#mcp-proxy-any-mcp-client — tools/call requests on wrapped servers are classified and blocked via isError: true. |
| tool result | `partial` | docs/AGENTS.md#mcp-proxy-any-mcp-client — tools/call, tools/list, resources/read and prompts/get responses on wrapped servers are scanned. |
| web fetch | `not seen` | docs/AGENTS.md#mcp-proxy-any-mcp-client — Stdio MCP proxy sees wrapped MCP servers only, not the host’s native web fetches. |

Unsupported steps in `stroq attack --host mcp` (51 of 59 steps across 33 of 36 scenarios): `01-readme-pipe-to-shell` step 1 (`post Read`, file read), `01-readme-pipe-to-shell` step 2 (`pre Bash`, shell command), `02-sentry-agentjacking` step 2 (`pre Bash`, shell command), `04-s1ngularity-public-repo` step 1 (`post Bash`, tool result), `04-s1ngularity-public-repo` step 2 (`pre Bash`, shell command), `05-roguepilot-schema-url` step 1 (`pre WebFetch`, web fetch), `06-env-dump-exfil` step 1 (`post Bash`, tool result), `06-env-dump-exfil` step 2 (`pre Bash`, shell command), `07-settings-hook-removal` step 1 (`post WebFetch`, web fetch), `07-settings-hook-removal` step 2 (`pre Write`, file write), `08-rm-rf-home` step 1 (`pre Bash`, shell command), `09-drizzle-force-push` step 1 (`pre Bash`, shell command), `10-skill-base64-installer` step 1 (`post Read`, file read), `10-skill-base64-installer` step 2 (`pre Bash`, shell command), `11-fetched-page-ssh-key-upload` step 1 (`post WebFetch`, web fetch), `11-fetched-page-ssh-key-upload` step 2 (`pre Bash`, shell command), `12-parent-dir-wipe` step 1 (`pre Bash`, shell command), `14-agents-md-invisible-hook-disable` step 1 (`post Read`, file read), `14-agents-md-invisible-hook-disable` step 2 (`pre Write`, file write), `15-issue-title-pipe-to-shell` step 2 (`pre Bash`, shell command), `16-issue-body-html-comment-exfil` step 2 (`pre Bash`, shell command), `17-ci-log-instruction` step 1 (`post Bash`, tool result), `17-ci-log-instruction` step 2 (`pre Bash`, shell command), `18-filename-instruction` step 1 (`post Bash`, tool result), `18-filename-instruction` step 2 (`pre Bash`, shell command), `19-dependency-postinstall-persistence` step 1 (`post Bash`, tool result), `19-dependency-postinstall-persistence` step 2 (`pre Write`, file write), `20-pdf-text-exec` step 1 (`post Read`, file read), `20-pdf-text-exec` step 2 (`pre Bash`, shell command), `21-memory-persistence` step 1 (`post Read`, file read), `21-memory-persistence` step 2 (`pre Write`, file write), `22-gitpwned-git-show-output` step 1 (`pre Bash`, shell command), `23-worktree-escape-zshenv` step 1 (`pre Write`, file write), `24-ghostapproval-symlink-authorized-keys` step 1 (`post Read`, file read), `24-ghostapproval-symlink-authorized-keys` step 2 (`pre Write`, file write), `25-script-trap-removes-home` step 1 (`pre Write`, file write), `25-script-trap-removes-home` step 2 (`pre Bash`, shell command), `26-script-git-clean-workspace` step 1 (`pre Write`, file write), `26-script-git-clean-workspace` step 2 (`pre PowerShell`, shell command), `27-vscode-task-folderopen` step 1 (`pre Write`, file write), `28-kiro-mcp-json-shell-server` step 1 (`post WebFetch`, web fetch), `28-kiro-mcp-json-shell-server` step 2 (`pre Write`, file write), `30-clinejection-issue-title-install` step 2 (`pre Bash`, shell command), `31-ssh-remote-docker-rmi` step 1 (`pre Bash`, shell command), `32-firebase-hosting-disable` step 1 (`pre Bash`, shell command), `33-lftp-mirror-delete` step 1 (`pre Bash`, shell command), `34-cmd-rmdir-quote-collapse` step 1 (`pre Bash`, shell command), `35-force-push-open-pr` step 1 (`pre Bash`, shell command), `36-script-launders-taint-upload` step 1 (`post Read`, file read), `36-script-launders-taint-upload` step 2 (`pre Write`, file write), `36-script-launders-taint-upload` step 3 (`pre Bash`, shell command).
