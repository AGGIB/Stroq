# Scoped agent connection

Connect prepares the current Stroq hook templates for Claude Code, Cursor or Codex CLI in an explicitly selected workspace or user source. It does not launch a host or spend a provider request. The receipt describes configuration; it is not evidence that a running client blocked an action.

## Preservation and review

The console compares complete handlers and their group metadata against the templates for this exact Stroq runtime. It keeps the first exact registration, adds missing templates and removes only additional exact duplicates. Ordinary commands, modified options, unfamiliar group metadata, unknown settings and unmatched hook events remain intact. Codex's supported legacy root arrays and single groups remain at their original locations.

A command that resembles a Stroq invocation but does not match the complete current template is preserved. Connect reports **Review required**, and agent inspection keeps the source in its changed state. The receipt does not imply that retained commands are safe. Repairing or deleting those commands is a separate manual decision. The CLI's legacy initializer retains its own upgrade behavior; the console generates a candidate from the current templates directly instead of accepting the CLI's broad suffix merge.

If the configuration already has exactly one of every current template, Connect is a true no-op. It preserves the original bytes, including supported BOM, whitespace and line endings, and writes no configuration, installation record, backup or lock. An absent or different advisory installation record does not justify adopting an otherwise unchanged source.

## Preview and apply

Read-only previews contain fixed source labels, workspace identity, source/candidate hashes, event metadata and counts. They never return the configuration, commands, environment values or filesystem paths. Invalid UTF-8, duplicate JSON keys, lossy numbers, unsupported shapes and disabled hooks are refused.

Plans expire after five minutes and are bounded to eight previews and 8 MiB in server memory. Apply rechecks the selected source, advisory record, relevant shadow source, directory/file identities, permissions and runtime. Missing acknowledgements leave the preview usable; an accepted apply consumes it even if a later recheck fails.

Changes affecting a user source, including a home directory opened as a workspace, require separate shared-scope acknowledgement. Changes retaining preexisting configuration or installation-record bytes require explicit full-copy acknowledgement. Opening a page or generating a preview writes nothing.

The writer holds the same Stroq configuration lock as native file filters and hook removal. It finishes recovery copies before changing the configuration and advisory record, checks the resulting bytes and file identities, and refuses to roll back over a concurrent editor. Portable check/rename does not provide an OS-level compare-and-swap against a malicious process running as the same user.

## Recovery and limits

For a changed configuration, complete existing configuration and advisory-record bytes are retained beneath `<selected-user-home>/.stroq/backups/console-setup/`, with an exact manifest linked to the preview ID. A newly created configuration still gets a manifest even when no prior files existed. These local copies may include credentials or unrelated settings; they remain unencrypted with no automatic expiry or eviction. New directories/files are private. The browser exposes only the recovery label and existence flags.

Hook setup requires POSIX, the default user Stroq directory and runtime paths representable safely in hook commands. Hooks continue to refer to that local runtime. Start a new agent session, or restart Cursor, after a change. Codex also requires its own hook approval and, where applicable, workspace trust. Reconnect uses a fresh preview; it does not overwrite newer settings from an old recovery copy.

Windsurf is not offered: it became Devin, which reads `.devin/hooks.json`, so the old Windsurf targets would not reach a Devin user. Existing Windsurf hooks can still be removed with `stroq uninstall`.

Tests with local fixtures cover the three agents in both scopes, source preservation, strict parsing, no-op behavior, exact duplicate handling and stale-source refusals. Connect has not been tested with a real Claude session. Rendered, responsive and keyboard walkthroughs have not been verified.
