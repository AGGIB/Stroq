# Credential file filters

**Agents & coverage** can inspect and configure a fixed set of native file filters for Claude Code and Cursor. This changes agent settings; it does not establish that a running client loaded them or blocked a read. Existing hook setup, live protection checks and MCP controls remain separate layers.

## Use the control

1. Open **Agents & coverage** and choose **Workspace** or **User** scope. In a Claude Code or Cursor card, open **Review filters**. This reads configuration only; it never reads the credential files named by the patterns.
2. Review the selected source, affected scope, explicit rule count and managed/preexisting ownership. **Configured rules** means the fixed patterns are present in that source. Unavailable ownership is not treated as user-owned data or a working recovery history.
3. Choose **Preview filters**. Review the exact fixed patterns, how many are present/added, reformatting and actual backup strategy. Cursor may add a managed block while preserving identical user-owned lines outside it.
4. Acknowledge the native boundary and private retention. Repository-wide or user-wide changes require separate scope consent. Apply the preview within two minutes; an expired or changed source requires a new preview.
5. Recheck configuration. Start a fresh client session and verify its loaded settings before relying on the change. Use a separately recorded client check for a blocking claim.
6. **Preview undo** computes the effect of all verified applications of this filter to the selected file. Review whether it restores a complete copy, removes entries surgically, deletes a file created by Stroq, or only clears obsolete history. Undo needs explicit consent to weakening the filter.

An interrupted or mismatched apply receipt is **Unknown** until a successful recheck. The UI never silently retries a consumed operation. Newer unrelated settings are preserved during surgical undo. Mixed or unexpected recorded edits are refused rather than being silently reversed.

## Changes in the Protection queue

Protection rereads the fixed file-filter report when opened or explicitly refreshed. A recorded setup with missing patterns links to the exact agent/scope for review. A source or ownership failure is shown as an evidence gap. Optional absence and configured user-owned rules do not create warnings. Job-only polling does not recapture native file settings or advance their inspection time. No client, credential scan or configuration action starts from this read.

## Sources and coverage

| Agent and scope         | Source                                                                                            | Fixed patterns                    |
| ----------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------- |
| Claude Code · Workspace | Resolved repository/main-checkout `.claude/settings.local.json`, or documented cwd-local fallback | 13 `Read(...)` deny rules         |
| Claude Code · User      | `~/.claude/settings.json` for the selected OS profile                                             | Same 13 rules                     |
| Cursor · Workspace      | Selected workspace `.cursorignore`                                                                | Managed `.env` and `.env.*` block |

Claude rules contain two top-level environment-file patterns and eleven home credential paths, including SSH, AWS, gcloud, GitHub CLI, Kubernetes, Docker, npm, netrc, PostgreSQL, Git and GnuPG stores. `.env.*` also covers `.env.example`; no exclusion is implied. Claude's native Read rules apply to supported file tools and recognized shell readers, not arbitrary Python/Node programs or all subprocess access. See [Claude permissions](https://code.claude.com/docs/en/permissions#what-read-and-edit-rules-cover).

Claude's current local-settings location depends on Git/worktree/platform/ownership context. The console resolves supported Git metadata without executing repository hooks, commands or configuration. Preview identifies repository-root or main-checkout changes and their broader scope; unsupported layouts are unavailable. A relocated `CLAUDE_CONFIG_DIR` user source is not edited through a guessed default. These are configuration-source checks, not an installed-client-version attestation. See [Claude settings](https://code.claude.com/docs/en/settings).

Cursor already ignores common secret files by default. Missing explicit Stroq rules do not establish exposure. Native context ignore rules do not prevent terminal or MCP reads. This recipe supports Workspace scope; Cursor's separate global user ignore feature is not configured here. See [Cursor ignore files](https://cursor.com/docs/reference/ignore-file).

## Recovery and local data

The console reuses the CLI harden engine and its actual manifest lock. Private server-held previews bind selected workspace/profile, runtime, configuration identity/mode/bytes, raw manifest and referenced backup state. Mutation recomputes under that lock; the parent keeps the lock until the worker has terminated. No-op apply creates no manifest, lock, backup or managed ownership.

The shared engine records ownership at `<STROQ_HOME>/harden/manifest.json` and retains copies below `<STROQ_HOME>/backups/`. Copies may contain complete private settings or embedded credentials. They are unencrypted, use private POSIX permissions, retain the first plus newest four copies per file on a best-effort basis, have no automatic expiry and remain after undo. Credential-shaped source text is not copied; undo then uses recorded entries. Detection is heuristic and can miss embedded secrets. Missing/pruned copies can require surgical recovery; exact-byte restoration is offered only when a verified copy is actually usable.

Only fixed target/action enums and an opaque preview ID enter from the browser. Public reports contain fixed source labels, counts and hashes, not source contents, absolute filesystem paths, commands or raw engine diffs. Symlinked/unsafe sources, ambiguous JSON and edited managed blocks are refused. Portable file checks and atomic rename are not a filesystem compare-and-swap guarantee against a malicious process running as the same OS user.
