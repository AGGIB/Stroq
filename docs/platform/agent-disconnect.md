# Remove Stroq hooks

**Agents & coverage** can remove exact hook registrations for the current Stroq runtime from one selected configuration file. This is a configuration change, not a complete agent disconnect or proof that a running host stopped enforcing hooks.

## Use the control

1. Open **Agents & coverage**, choose **Workspace** or **User**, and select **Remove Stroq hooks** on the agent card. Opening the dialog reads availability only; it does not inspect settings or prepare a write.
2. Choose **Preview removal**. Review the fixed source, actual scope, exact hooks to remove, other hooks preserved and similar commands remaining. Events and source/candidate fingerprints are available in details.
3. Acknowledge weaker protection and retention of the full settings copy. User scope, including a workspace that resolves to the user home, requires separate consent to the effect across workspaces.
4. Apply the single-use preview within five minutes. Changed source bytes, identity, permissions, runtime or relevant source context require a fresh preview. An unchanged preview cannot apply or create a backup.
5. Review the receipt and refreshed configuration. Start a new agent session to load the change. Running agents and servers are not stopped, access is not revoked, and native file filters, policy and MCP registrations remain separate.
6. To enable the integration again, use **Reconnect**. It opens the existing setup flow for the selected agent and scope, with a fresh current-runtime preview. The platform does not restore an old full settings copy over newer configuration.

A timeout, interrupted apply or mismatched receipt leaves completion **Unknown**. **Recheck configuration** must successfully reread Agents & coverage and removal availability before another preview; it does not retry the removal automatically.

## Sources and ownership

| Agent       | Workspace source        | User source               |
| ----------- | ----------------------- | ------------------------- |
| Claude Code | `.claude/settings.json` | `~/.claude/settings.json` |
| Cursor      | `.cursor/hooks.json`    | `~/.cursor/hooks.json`    |
| Codex       | `.codex/hooks.json`     | `~/.codex/hooks.json`     |

Workspace paths are relative to the selected canonical workspace; user paths belong to the selected OS profile. Opening the user home through a canonical alias still has user-wide impact. This writer currently requires POSIX and the default user Stroq home; custom `STROQ_HOME` and Windows mutation are unavailable.

Ownership requires the current server-generated template's exact event, matcher/group metadata and handler options. Other commands, modified registrations and lookalikes are preserved and counted, even when their names suggest Stroq. Only the selected source is edited. Windsurf is no longer listed; remove old Windsurf hooks with `stroq uninstall`. The installation record is retained.

Changed JSON may be reformatted. Unrelated values retain their meaning, and detected BOM, CRLF/LF, final-newline and indentation conventions are preserved within the parser's supported layout limits. A no-op preserves every original byte. The recovery copy always contains the exact original bytes.

## Recovery and retention

Each change first retains `before.json` and `manifest.json` under `<selected-user-home>/.stroq/backups/console-disconnect/<receipt UUID>/`. The copy contains the entire original settings file, including unrelated entries and any embedded credentials. Metadata binds its source/candidate hashes, original mode and selected context; the receipt's recovery ID identifies this record.

Retention is private but **unencrypted**, with `0700` directories and `0600` files. Copies have no automatic expiry or eviction. The store accepts at most 32 recovery records; a full or unsafe store refuses another removal rather than deleting an older copy. The UI offers no automatic raw-copy restore or deletion. Files remain sensitive after reconnecting.

Removal uses the same harden configuration lock as native file-filter writes, then rechecks the source/runtime before replacement and verifies the written candidate. It refuses unsafe linked/ambiguous sources. Private permissions and portable identity checks do not protect against another process acting as the same OS user or provide filesystem compare-and-swap.

## Evidence limits

The receipt establishes only the checked file change and absence of exact current-runtime hooks in that file. It does not establish all-source removal, host adoption or runtime blocking. Removal has not been tested against a real host; local fixtures cannot replace that evidence. The dialog's browser and keyboard behaviour has not been verified.
