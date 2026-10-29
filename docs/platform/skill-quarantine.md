# Reversible skill quarantine

The workflow is **preview an exact installed version → move it out of discovery → recheck both locations → preview a guarded restore**. It reduces one installed discovery surface while retaining the original bytes. It does not establish that a skill is malicious or that an agent is safe.

## Scope and effect

A complete isolated skill folder can be moved from any of the six fixed source families below, including nested folders. The source root itself and folders with an ancestor or descendant `SKILL.md` stay inspectable but cannot be moved: a single-artifact action must not change another discovered skill.

| Source              | Project            | User                       |
| ------------------- | ------------------ | -------------------------- |
| Claude              | `.claude/skills`   | `.claude/skills`           |
| Shared              | `.agents/skills`   | `.agents/skills`           |
| Codex compatibility | `.codex/skills`    | `.codex/skills`            |
| Cursor              | `.cursor/skills`   | `.cursor/skills`           |
| Windsurf legacy     | `.windsurf/skills` | `.codeium/windsurf/skills` |
| Devin               | `.devin/skills`    | `.config/devin/skills`     |

These are captured filesystem sources, not proof that any particular client loads them. In particular, current Codex documentation describes `.agents/skills`; `.codex/skills` remains a compatibility source. Any client reading the selected source can be affected. The server resolves its identity from the inventory; browser requests cannot supply paths, commands or environment values. Project scope changes that installation; personal scope can affect every workspace using it.

Opening the user home itself as a workspace does not make its personal skills project-local. After canonicalizing both roots, including symlink aliases, a shared location has one **user** identity and every preview discloses its effect across workspaces. A project-scoped ID or stale plan cannot move that shared installation. Retained records created with the former incorrect project scope remain an explicit storage gap; they are not silently migrated or restored. A prior project-scoped review also does not review the new user-scoped identity.

The capture must contain an exact `SKILL.md`, at most 128 files, depth 8, 200,000 bytes per file and 512 KiB total. Incomplete captures, skipped `.git` or `node_modules` content, unsafe names, symlinks, hardlinks and special files are refused. Synced skills, plugin manifests/components, bundled and managed sources are outside this control. Windows is unsupported. MCP configuration and servers are not changed.

Legacy direct Claude lookup completely enumerates and sorts at most 4,096 immediate entries per Claude scope root before selecting an opaque artifact ID. Files and non-skill directories count toward that bound. An over-limit directory is refused even if the selected name was encountered; no partial listing authorizes a move. This lookup bound is separate from the inventory's 256 skill candidates and the vault's 32 retained records per scope. For other or nested selections, the bounded inventory discovery resolves the exact source-bound ID, followed by a fresh full tree capture and parent checks. A refused unrelated Claude root does not prevent control of a safe selected source. Synced, plugin and `.system` subtrees remain outside control.

Claude Code documents that removing a personal/project directory removes that skill from discovery, but its previously loaded instructions persist in the conversation. Synced and plugin sources have separate removal mechanisms. **Start a fresh agent session after quarantine.** A same-named skill from another scope or copy can still be available; this operation makes no global absence claim. [Official removal and lifecycle documentation](https://code.claude.com/docs/en/skills#remove-a-skill), [content lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle).

## Preview, apply and restore

Preview is read-only and creates no directory, store or lock. It identifies the artifact, fixed source, scope, sanitized relative folder label, full SHA, file count, byte count, intended discovery-path effect and session limits. Sensitive folder labels are withheld; the opaque artifact ID disambiguates them. Labels never resolve filesystem paths. A plan is single-use, expires after two minutes and binds the exact tree, directory identity, workspace and runtime bytes. Apply rechecks those bindings and requires explicit confirmation plus acknowledgement of the session limits. The parent rechecks expiry after acquiring the shared lock. The worker independently verifies the actual trusted runtime before durable intent, folder move, final entrypoint publication and completion; cheap deadline checks also guard resource progress. Captured physical metadata refuses A → B → A source replacement even when file bytes return. A clean scan is not a prerequisite for containing a selected version.

Quarantine uses a same-filesystem rename into `<root>/.claude/.stroq-quarantine/<record UUID>/payload`. Cross-filesystem moves are refused; there is no copy-and-delete fallback. The selected source and container directories stay in place. All six sources share the existing vault and its limit; adding a source does not multiply retention capacity. Intent is persisted before the move; completion requires the original path to be absent and the retained payload to match the captured `stroq-tree/1` digest, including executable bits.

Restore keeps the retained payload. It never overwrites an existing original object, including an empty directory or identical bytes. The writer exclusively creates the original directory and resource files, preserves empty resource folders, stages and syncs the complete `SKILL.md` privately, then publishes it last through an exclusive hard link. Existing targets are never replaced. Missing fixed source/container parents are created exclusively and pinned, while previously observed parents retain their original identities. A changed parent or foreign `EEXIST` refuses publication. Legacy records remain readable; nested entrypoints or managed/plugin content prevent restore through an explicit restore block or unverifiable payload evidence. This version cannot safely restore several discovery entrypoints together. It then verifies the restored digest and retained payload. Failed or interrupted operations preserve payload and intent for recovery rather than automatically deleting or moving data back. Any failed apply may have changed the filesystem. An uncertain client result persists across dialog remounts and revision changes, disables further previews/applies and requires an explicit accepted same-workspace vault recheck before retry. Automatic history loading cannot clear this state.

Review baselines and Stroq installation pins are unchanged. Restored bytes have fresh physical metadata, so a prior static-signal assessment requires a new decision even when its content SHA matches. Restoring this captured version is not the same as restoring or rolling back a confirmed Stroq installation receipt.

## Evidence and recheck

The receipt describes completion-time evidence with `evidence: discovery-path` and `hostEnforcement: false`. Current state is derived again from the original path and retained tree; a ledger entry alone cannot prove containment.

| State                                 | Meaning                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `quarantined`                         | The original path is absent and the retained payload matches.                       |
| `reappeared`                          | An object exists at the original path after quarantine, even if its digest matches. |
| `restored`                            | A completed restore has the exact captured version at the original path.            |
| `payload-changed` / `payload-missing` | Retained evidence changed or disappeared.                                           |
| `recovery-required`                   | An interrupted prepared/restoring intent needs deliberate recovery.                 |
| `unverifiable`                        | Current evidence cannot support a more specific result.                             |

Recheck does not execute the skill, start an agent, call a model, stop a process or verify historical remediation. A replacement or changed version returns an actionable result instead of inheriting a previous review. Missing, malformed or unsafe vault metadata produces a gap or unavailable state, not a successful empty inventory.

## Storage and limits

Original files, including any secrets they contain, are retained locally **unencrypted**. A verified private `.gitignore` containing `*` is created before any payload enters the vault to reduce accidental Git inclusion; it is not encryption or protection against forced adds. Durable records bind canonical root path, device and inode, so a copied vault or replaced root is refused. Vault and record directories are private mode `0700`, metadata is `0600`, and ownership is checked. Raw payload, absolute source paths, commands and environment values are not part of public state or receipts. Public v2 envelopes include a validated display-only source/location; private v2 records retain the exact server-selected locator. Original private v1 records remain byte-stable on read and retain their version when explicitly restored. The retained directory is not an execution sandbox.

The limits are 32 records per scope vault, 64 combined, with no automatic garbage collection or payload deletion, including after restore. Full storage refuses new quarantines; existing records can still be restored. Apply is serialized across workspaces sharing a user vault. Workers have a 25-second deadline, 256 MiB memory limit and bounded replies; they terminate before releasing their apply lock.

Portable Node path checks reduce accidental replacement and ordinary link hazards. They do not defend against a malicious process running as the same OS user and racing ancestor directories or replacing private state. Neither filesystem permissions nor a matching digest revoke credentials, remove other copies, undo previous effects or prove host blocking.

## Research basis and verification

The product model follows the useful inventory → action → evidence loop documented by [Snyk MCP Governance](https://snyk.io/blog/evo-ads-govern-agent-behavior-ga/) and the drift concern described by [Zenity MCP Security](https://zenity.io/platform/mcp-security). These public vendor materials were read without account access; neither is evidence that those products quarantine skill folders on disk.

Quarantine is tested with temporary profiles and fixture skills, never a real user's skills. Recovery after an interruption and the failure paths have not been checked in a browser. Fixture and filesystem results cannot establish real-host blocking, native-client skill resolution or revocation. Quarantine is not a host-enforcement claim.
