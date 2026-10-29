# Reversible MCP registration removal

The workflow is **inspect an exact MCP entry → preview removal → remove that registration → recheck → preview a guarded restore**. Open an installed MCP item in Skills & MCP to begin; retained history is at `/skills/mcp/`. A successful removal means one entry is absent from one configuration source. It does not stop an active server, disable every same-named source, uninstall a package, revoke credentials or resolve an incident.

The same local API/store also supports [configuring one strict stdio proxy](mcp-protection.md). That action replaces an eligible entry instead of removing it. Its guarded undo requires the exact recorded wrapper; removal restore below continues to require an absent slot.

## Supported sources

| Client         | Eligible configuration                                                        | Platforms for mutation |
| -------------- | ----------------------------------------------------------------------------- | ---------------------- |
| Claude Code    | Project `.mcp.json`                                                           | macOS and Linux        |
| Cursor         | Project `.cursor/mcp.json` or user `~/.cursor/mcp.json`                       | macOS and Linux        |
| Claude Desktop | User manual `~/Library/Application Support/Claude/claude_desktop_config.json` | macOS                  |

Only eligible `mcpServers` JSON entries with a current verifiable inventory fingerprint can be selected. Both stdio and HTTP registrations can be removed; this edits configuration and does not call or start either server. Unknown fields in the selected entry and other settings are preserved as JSON data. A clean content scan is not required to contain a selected registration.

If the selected workspace resolves to the user home, its `.cursor/mcp.json` is the same file as Cursor's user configuration. Discovery exposes it once as a **user** source, including when the workspace was opened through a filesystem alias. Preview therefore discloses its effect across workspaces, and guarded restore uses the same user-source identity.

Windsurf/Devin sources remain **read-only and unavailable for containment**. Inventory distinguishes a selected legacy `.codeium/windsurf/mcp_config.json` or `.codeium/mcp_config.json` source from the current Cascade JSON source at the configured/default Devin location. A file's presence does not establish that the current agent mode loads it; Devin Local has a separate configuration mechanism. All of these sources remain gated from mutation.

The server passes selected `APPDATA`/`XDG_CONFIG_HOME` values into a shared resolver. With the default OS profile it captures the relevant server environment values; an explicitly supplied profile defaults to an empty config environment unless the server supplies one. Workers do not consult an ambient profile or environment fallback. The default current Cascade location is `~/.config/devin/mcp_config.json` on POSIX, or the selected `XDG_CONFIG_HOME` location when provided. A setting outside the selected user profile or otherwise invalid creates a source-specific coverage gap. The rejected source is not read through a default-location fallback, and valid Claude/Cursor sources remain available. Recognizing a custom location does not enable a Windsurf/Devin writer.

Windows mutation and the Linux Claude Desktop source are unsupported. Codex TOML, VS Code's `servers` shape, Claude Code local/user registrations in `~/.claude.json`, plugins, managed sources and account connectors are outside this action. Removing a project registration can expose a same-named fallback from another source. [Claude Code scopes and precedence](https://code.claude.com/docs/en/mcp#scope-hierarchy-and-precedence), [Cursor configuration locations](https://cursor.com/docs/mcp#configuration-locations), [manual Desktop configuration and restart](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Devin Desktop Cascade MCP](https://docs.devin.ai/desktop/cascade/mcp).

## Preview and apply

Preview is read-only. It creates no lock, directory, baseline or recovery file and never launches an agent/server, sends an MCP request, fetches content or starts a credential scan. It shows the client, project/user source, exact entry fingerprint, current and planned configuration hashes, file byte count, preserved registration count and any reformatting.

A preview is single-use, expires after two minutes, and binds the workspace, runtime, source-root identity, concrete source locator, whole-file raw bytes, file identity/mode and selected entry SHA. Even a sibling-only change, identical file replacement or changed source selection invalidates it. User scope can affect every workspace using that profile. Applying requires both an active-session acknowledgement and explicit agreement to retain the complete configuration unencrypted.

The capture is at most 256 KiB and requires a regular, single-link file, safe components below its canonical root, valid UTF-8 and a strictly parseable JSON object. Comments, trailing commas, duplicate decoded keys, lossy numeric values, negative zero and key ordering that cannot survive serialization are refused. The writer also requires an owned, owner-writable source. Unsafe, incomplete or unsupported input is not replaced with an empty configuration.

Apply writes and verifies private original/edited recovery copies, persists intent, then stages and syncs the complete edited config beside the target and renames it into place after fresh identity and byte checks. It removes exactly one own property from `mcpServers`; unrelated root fields, entries and opaque nested fields are preserved. An empty `mcpServers` object and the config file remain. Supported BOM, indentation, line endings and final-newline choice are retained; a layout that requires reformatting is disclosed in preview.

Completion requires exact edited bytes and selected-key absence, plus matching retained payloads. The receipt is completion-time `configuration` evidence, with `hostEnforcement: false`, `requiresClientRestart: true` and `reviewBaselineChanged: false`. Review baselines and installation pins are unchanged. Restart/reconnect the client as appropriate and check its active configuration separately; a receipt cannot establish the fate of an already running process.

## Recheck and restore

Opening or refreshing retained history re-reads source and payload evidence. It does not rerun removal, adopt changes, launch a server or scan credentials. Registration slots, recovery payloads and whole-source fingerprints are separate facts:

| State               | Meaning                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `removed`           | Completed removal, valid recovery payloads and selected own key absent from the bound source. Unrelated later edits can coexist; `sourceMatchesChange` distinguishes the whole-file hash. |
| `reappeared`        | An entry exists again at that source slot, even when its fingerprint matches the removed entry.                                                                                           |
| `restored`          | A completed restore's selected entry matches the retained entry SHA. This does not mean all configuration bytes still match a historical file.                                            |
| `changed`           | A restored entry or retained evidence changed; inspect separate slot/payload fields.                                                                                                      |
| `config-missing`    | The bound configuration file is missing. This is not a verified removal receipt.                                                                                                          |
| `recovery-required` | A persisted prepared/restoring operation is unresolved. Current slot and payload evidence remain separate.                                                                                |
| `unverifiable`      | Source/root/parse evidence cannot support a stronger status, or a project record belongs to another workspace.                                                                            |

Restore requires a fresh preview and an existing, safely capturable config with an own `mcpServers` object. The original name must be absent as an own key. Any occupied slot is a collision, including null, malformed data or an identical entry. Missing config files and parents are not recreated.

If the entire current file still equals the retained edited bytes, restore returns the exact original bytes and original mode, including a BOM or original line endings. If unrelated settings changed, it adds only the opaque retained entry to the current document, preserves the newer siblings/settings and current mode, and discloses necessary reformatting. It does not overwrite the current file with an old whole-file backup merely because the entry is absent.

Restore apply rechecks the previewed manifest, payload, runtime and current source. It persists a restoring intent before changing the file, then verifies restored bytes and entry digest before completion. Retained copies remain. Another installation appearing before apply makes the preview stale or the slot occupied; no automatic retry replaces it.

Project records are tied to the originating canonical workspace/root and cannot follow their source from a different workspace. User-source records share the selected profile and can be rechecked/restored from another workspace after a new preview. Canonical record links bind workspace and record UUID; exports contain derived evidence, not recovery JSON.

## Storage and recovery

Recovery lives at `<selected-user-home>/.stroq/console/mcp-containment/<record UUID>/`, with complete `before.json`, an edited config and private `manifest.json`. New v2 records use `changed.json` for both removal and proxy configuration. Valid legacy v1 removals retain their original `removed.json`; reading state or preparing restore does not rewrite/migrate their files. A deliberate restore updates its existing record lifecycle while keeping the v1 format and payload name. This fixed user-home location is used even with a custom `STROQ_HOME`. Project backups are not placed in the project repository.

Both configuration copies are complete and **unencrypted**. They can contain credentials in the selected or unrelated entries, headers, environment values and other private settings. The manifest also retains the internal source/name needed for recovery. Vault and record directories require current-user ownership and mode `0700`; files require ownership and mode `0600`. Original source modes are separate and preserved as described above. A verified `.gitignore` containing `*` reduces accidental Git inclusion; it is not encryption or protection against a forced add.

The store is shared across workspaces and both actions for that user, and accepts at most **32 records and 17 MiB** of accounted payload/metadata. Each config copy is limited to 256 KiB and each manifest to 16 KiB. No payload expires, is evicted or is deleted automatically, including after restore. A full or malformed store blocks new mutations. Copied stores, replaced roots, changed payloads or unsafe private permissions are refused or exposed as gaps. Root bindings are local continuity checks, not signed provenance.

Intent is recorded before the config changes. An interrupted operation may already have changed the source; refresh current evidence before any further action. Restoring a removal record can be previewed when the record/payload are valid, the exact source remains bound and the selected slot is absent. An occupied slot is never overwritten to clear that recovery state. Proxy undo instead requires its exact recorded wrapper, as described in the protection guide. Partial backups without a valid manifest, unexpected files and other malformed records remain storage gaps requiring manual inspection; there is no automatic repair or deletion action.

Mutations share a per-user main-process lock across platform instances. Workers have a 25-second deadline, bounded replies and a 256 MiB heap limit; they terminate before the parent releases the lock on shutdown or timeout. That lock coordinates Stroq writers, not external editors. Portable path/identity checks and rename narrow ordinary race windows but do not provide OS compare-and-swap, defend against a malicious process running as the same user, or guarantee survival through a power failure. The store is not an execution sandbox. [Security retention policy](../../SECURITY.md#local-data-retention).

## Local API and verification

The authenticated local API exposes `GET /api/mcp-containment`, `POST /api/mcp-containment/preview` and `POST /api/mcp-containment/apply`. Public state, preview and receipt schemas are v2. Requests are closed and bounded; the browser supplies an inventory ID and expected SHA for `remove-registration` or `protect-registration`, a retained UUID for `restore-registration`, or a preview UUID plus acknowledgements for apply. Records distinguish the original change and project legacy v1 records as removals without destructive migration. `sourceMatchesChange` is shared by both actions; removal keeps its absent-slot semantics. A `configured`/`guarded` entry and separate runtime match describe proxy configuration, as explained in the [protection guide](mcp-protection.md).

The browser cannot choose a path, command, environment, replacement JSON or backup location. API errors use fixed codes. Source JSON, raw command/env values and recovery paths are not returned in state, previews, receipts or exports. Both mutations and guarded undo share the same parent-owned lock and capacity limits.

Removal and restore are tested on temporary fixture profiles through the actual HTTP server and its workers. That does not establish a real MCP client's reload or process-stop behavior. It has not been tested on a real user's registrations. Browser rendering, keyboard and responsive behavior have not been verified.

Clients and sources not listed under [Supported sources](#supported-sources) are not covered. A configuration receipt is not a universal disable or verified host enforcement.
