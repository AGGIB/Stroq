# Configure an MCP strict proxy

The workflow is **select one installed stdio registration → Preview proxy → acknowledge scope and effects → configure → recheck → preview proxy removal**. Open an MCP item in Skills & MCP; retained configuration evidence and recovery are at `/skills/mcp/`. The action changes one entry, preserving other registrations and settings. GET, preview and apply never execute the configured server, launch an agent, make an MCP handshake or start a credential scan.

## Eligible registrations

| Client         | Configuration source                                                          | Mutation platforms |
| -------------- | ----------------------------------------------------------------------------- | ------------------ |
| Claude Code    | Project `.mcp.json`                                                           | macOS and Linux    |
| Cursor         | Project `.cursor/mcp.json`                                                    | macOS and Linux    |
| Cursor         | User `~/.cursor/mcp.json`                                                     | macOS and Linux    |
| Claude Desktop | Manual user `~/Library/Application Support/Claude/claude_desktop_config.json` | macOS              |

The selected inventory item must have a current verifiable fingerprint and a safe metadata label. Protection accepts only an unwrapped stdio entry: a nonempty command, optional string arguments and optional string-valued environment. If present, `type` and `transport` must be `stdio`. Any own `url` or `serverUrl` field excludes protection, even when null. HTTP/SSE entries can still use the separate [registration removal](mcp-containment.md) workflow.

Malformed/oversized arguments or environment, NUL, unsafe variable names and original `NODE_*`, `STROQ_*`, `LD_*`, `DYLD_*`, `HOME`, `USERPROFILE`, `HOMEDRIVE` or `HOMEPATH` overrides are refused. Existing recognizable Stroq wrappers, including reordered/client-less, pinned, strict or cloaked invocations, are not upgraded, nested or adopted by Protect. No pin or cloak is added.

The shared source capture also refuses unsafe paths/links/hardlinks, unsupported ownership/mode, invalid UTF-8, duplicate JSON keys, JSONC and other JSON that cannot be preserved safely. It does not replace an unreadable configuration with an empty file. Windsurf/Devin, Windows mutation, Linux Desktop, Codex TOML, VS Code `servers`, Claude Code `~/.claude.json`, plugins, managed sources and account connectors remain outside this writer. Discovery of a source does not prove the active client uses it.

When the workspace resolves to the user home, Cursor's `.cursor/mcp.json` is exposed once as the **user** source. Its scope is not narrowed by opening the same file as a project or through an alias.

## What the preview configures

The server builds and parses back one wrapper using the existing CLI builder. It selects the installed Node/CLI entry, records `--strict`, the server/client identity and selected workspace context, and preserves the upstream command, arguments, opaque fields and client-controlled server `cwd`. Other entries remain unchanged. Preview shows scope, workspace context, preserved sibling count, reformatting and current/candidate fingerprints without exposing command arguments, environment values or recovery JSON.

The proxy uses the **running console's server-selected Stroq home** for policy and storage. It loads that home's `policy.yaml`, or the default policy if absent. `--cwd` selects workspace/event paths and project secret-index context; it does **not** select the policy file. The generated entry explicitly binds `STROQ_HOME` and profile `HOME`/`USERPROFILE`. It records the original declared environment names for server pass-through before adding those controls, so `STROQ_HOME` is not passed to the upstream server.

The upstream server receives its declared variables plus the existing proxy's base process variables. Undeclared ambient credentials may no longer be available. This is environment filtering, not a sandbox: base variables include configuration/cache locations and network-proxy settings. Original declared environment values are preserved and recovered by undo.

A **user** registration is shared across workspaces, while retaining this Stroq policy home and the originally selected workspace context. The preview requires a separate shared-context acknowledgement in addition to active-session limits, proxy effects and unencrypted retention. This does not index every other workspace. The policy home is bound, not a frozen policy version; a future proxy launch can load a later policy from that home.

Preview is read-only, expires after two minutes and is single-use. Apply rechecks source/root identity, exact file bytes/mode, entry digest, runtime/context and candidate bytes under the shared parent-owned lock. A sibling-only edit or identical-byte file replacement after preview makes it stale. Missing acknowledgements refuse before consuming the preview. Apply retains original/changed copies and intent before replacing the file, then verifies the resulting bytes and wrapper digest. On an uncertain failure, recheck retained history before another action.

## Strict behavior and evidence

On the next client connection, the configured entry starts the strict proxy in front of that server. Reconnect or restart the client as appropriate; applying configuration does not alter an already running connection or stop a server process. Other scopes/connectors can still supply a server with the same name.

The existing policy engine can deny tool calls before forwarding. An `ask` becomes a blocked call because the proxy cannot prompt. Strict mode withholds server messages it cannot fully read and scan; repeated or incompatible traffic can end that proxy/server connection. A scanned message is not guaranteed harmless. Strict does not sandbox the server, prevent its independent file/network access, undo prior server effects or pin its package. Cloaking stays off and this action creates no reversible cloak dictionary. The detailed [MCP channel limits](../AGENTS.md#mcp-proxy-any-mcp-client) and [security scope](../../SECURITY.md#scope) still apply.

Proxies started with the current runtime also check [launch-policy continuity](mcp-policy-continuity.md) immediately before new `tools/call` dispatch. A changed parsed policy or unavailable source withholds the call and latches refusal until restart, including after the old file is restored. Comments and equivalent parsed layout do not change policy identity. Restart loads the current policy; there is no hot reload or automatic retry. Older running proxies are not upgraded by saving policy or applying a wrapper. This control does not stop the server or undo work already forwarded.

Retained state separates three facts:

| Evidence                              | Meaning                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configured` / `guarded`              | Completed configuration change, valid recovery payload and exact recorded wrapper entry still present                                                |
| `sourceMatchesChange`                 | Whether the entire configuration still matches change-time bytes; unrelated later edits may coexist with the same wrapper                            |
| `runtimeMatches: true / false / null` | The recorded runtime fingerprint, executable/entry paths and selected Stroq/profile paths match this console's context, differ, or cannot be checked |

A matching runtime is a local continuity check, not attestation of Node, the upstream package, client environment, current policy contents or a running connection. Runtime drift remains visible even with an unchanged wrapper; it does not itself prevent guarded undo. `changed`, `config-missing`, `unverifiable` and `recovery-required` expose evidence gaps rather than silently repairing them. A receipt remains `evidence: configuration`, `hostEnforcement: false`; baselines, installation pins and incidents are not automatically changed.

## Guarded undo and private recovery

Use retained history to **Preview proxy removal**. Undo is allowed only while the source slot still contains the exact recorded wrapper SHA. A modified wrapper, original unwrapped entry, missing slot or any other value is a conflict. Stroq will not delete an unrelated installation to clear its record. Newer unrelated siblings/settings are preserved.

If the whole file still equals retained changed bytes, undo restores exact original bytes and mode, including BOM/line endings. Otherwise it replaces only the unchanged wrapper with the retained original entry, preserves newer siblings/current mode and discloses necessary reformatting. It does not recreate a missing config/parent. Undo removes strict proxy control for future connections and needs its own proxy-effects acknowledgement; it does not disconnect an existing client. User-source undo can be previewed from another workspace in the same profile; project records stay with their canonical originating workspace.

Protection and removal share the private store at `<selected-user-home>/.stroq/console/mcp-containment/<record UUID>/`, even with custom `STROQ_HOME`. New v2 records retain complete `before.json`, `changed.json` and metadata. Legacy v1 removals keep `removed.json`; reads do not migrate them. The original and edited copies can contain unrelated credentials and remain **unencrypted**, including after undo. The existing private permissions, shared capacity/refusal rules and absence of automatic expiry/deletion apply. See [storage and recovery](mcp-containment.md#storage-and-recovery) and [local retention](../../SECURITY.md#local-data-retention).

## Verified boundary

The workflow is tested on temporary profiles through the actual HTTP server, and with a generated Stroq wrapper in front of an inert MCP server. These are proxy and backend results. No real Claude Code, Cursor or Claude Desktop client has been used, so client reload, adoption and host enforcement are not established. It has not been tested on a real user's registrations or servers, or with provider traffic. Browser visual, keyboard and responsive behavior have not been verified. These bounded results are not a claim of universal protection or native-client enforcement.
