# Installed-artifact evidence

Open an installed skill or MCP entry from **Skills & MCP**. The detail view requests a new bounded capture of that exact version and compares it with the version explicitly reviewed before. It displays content results separately from static capability scope. Nothing from the artifact is executed or installed.

A detail link contains the hashed workspace identity, artifact ID and expected SHA. A different workspace, unavailable item or changed version is explicit; the interface does not silently substitute the current version. A structurally valid report must also match the requested identity, digest, source, agent, kind and scope. Closing or changing the selection aborts the outstanding browser request and hides earlier evidence.

`POST /api/inventory/inspect` accepts only `{id, expectedSha256}` under the same bearer/Host/Origin/Fetch-Site gates as the other local operations. The strict UTF-8 JSON body is capped at 4 KiB. Paths, executables, arguments, environment maps and remote URLs cannot be supplied. Missing, changed or unsafe captures return 409. A bounded worker returns only derived evidence, and is terminated before its service slot is released on timeout or shutdown.

The review dialog uses `POST /api/inventory/compare` with `{id, expectedSha256, expectedReviewedSha256}`. The last field is null for an unreviewed item. The response binds both revisions to the same canonical workspace, artifact, kind, agent and scope, and the browser independently recomputes the derived changes from two validated captures. A changed baseline requires a fresh read; it cannot silently substitute another reviewed version.

## Changes since review

The leading comparison shows captured files added, modified or removed, changed static capability counts and new/absent rule signals. Missing detail slots or incomplete capture lists produce **Not observed** states, rather than fabricated additions/removals. Scope gaps and a changed recorded engine profile withhold affected analysis comparisons; byte fingerprints remain comparable. Profile equality does not establish that every runtime byte was identical, and no lower count establishes remediation or fewer runtime permissions.

MCP entry changes and source-file changes are separate. An edit to another registration can change the source file while this selected entry remains identical. Transport, Stroq wrapper and strict flag can be compared; launch commands, URLs, environment values, server code and tool definitions are unavailable. A changed entry with unchanged visible fields still remains changed.

Old fingerprint-only reviews show **Previous details unavailable**. Opening or refreshing them does not migrate or invent a capture. **Record review details** explicitly captures the still-current version; reviewing one item does not accept another item or a later source revision.

## Skill evidence

Discovery reads six fixed source families in the selected workspace and user home:

| Source               | Workspace root     | User root                    |
| -------------------- | ------------------ | ---------------------------- |
| Claude               | `.claude/skills`   | `~/.claude/skills`           |
| Shared agents        | `.agents/skills`   | `~/.agents/skills`           |
| Codex local / legacy | `.codex/skills`    | `~/.codex/skills`            |
| Cursor               | `.cursor/skills`   | `~/.cursor/skills`           |
| Windsurf             | `.windsurf/skills` | `~/.codeium/windsurf/skills` |
| Devin                | `.devin/skills`    | `~/.config/devin/skills`     |

These are filesystem origins, not proof of installed clients, enabled plugins or
loaded skills. A shared root is one source, not three independently detected
agents. Compatibility loading and client settings can differ by version.
See [current Claude discovery](https://code.claude.com/docs/en/skills#choose-where-skills-load),
[Codex local roots](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills),
[Cursor roots](https://cursor.com/docs/skills#skill-directories) and
[Devin/Windsurf scopes](https://docs.devin.ai/desktop/cascade/skills#skill-scopes).

The collector searches for `SKILL.md` recursively within those roots. It does not
search ancestor projects, nested workspace configuration roots, main-checkout
fallbacks, additional managed/system roots, custom homes or plugin caches.
Symbolic links and hardlinked files are refused with partial coverage. The
coverage disclosure shows Read, Absent or Partial per exact source and scope;
Absent applies only to that fixed folder, never to every skill a host could load.

Discovery is bounded to 256 candidates, 1,024 directories, 4,096 directory entries
and eight levels. Aggregate skill capture retains its 4 MiB and 15-second budgets;
skipped candidates remain incomplete rather than silently disappearing. An old
review is Missing only when its exact source was inspected without a gap. An
uninspected or incomplete source leaves that historical identity Unverifiable.
Opening the user home as the workspace has one user-scoped source, not a second
project-scoped copy.

Existing direct Claude identities and tree fingerprints remain stable. Other
source/relative-location combinations have distinct opaque IDs, including equal
skill names in different folders. An immutable captured tree is hashed as
`stroq-tree/1`; it is a collection of captured bytes, not an OS-atomic filesystem
snapshot or a guarantee about later edits. Quarantine eligibility is checked separately:
complete isolated folders in the six fixed sources offer that operation, including nested folders. Source roots, overlapping entrypoints, managed/plugin content and unsafe links stay read-only. Source/scope and a sanitized relative folder label distinguish equal leaf names; labels never resolve paths. See [reversible quarantine](skill-quarantine.md).

The actual bundled content scanner evaluates captured Markdown at threshold 0.6. **Matched signals** counts rule matches, including matches below threshold. A score of 0.4 can therefore remain below threshold while displaying a matching rule. File labels identify the captured file, while fixed rule titles, categories, severity and decoding variant explain the signal. Raw content and matching snippets are withheld.

Static capabilities are aggregate source/declaration signals across the tree; they are not attributed to an individual file or presented as observed behavior. Unsupported source, dependency/native/shell/frontmatter limits and incomplete captures remain visible. Content verdict, scan failures and static scope limits are separate fields.

Capture limits are 128 files, 512 KiB total, 200,000 bytes per file and eight directory levels. A report retains at most 32 file details and 100 matching details; every displayed match resolves to a retained file. Omitted counts remain explicit. Sensitive or unsafe names become generic labels without exposing source content, commands or credential names/values.

## MCP evidence

MCP inspection captures one configured entry and its configuration file. The artifact SHA uses canonical entry JSON; the file SHA and length use the original complete configuration bytes, including any UTF-8 BOM. Transport, Stroq wrapper and strict flag describe configuration only. Server code, tool descriptions and runtime behavior are not scanned; no MCP server is started. Bundled engine metadata is retained as provenance without claiming its content rules were applied to the entry.

## Review and export

**Mark version reviewed** requires evidence accepted for the selected version and a readable baseline. Actual incomplete scans, missing/unverifiable artifacts and stale fingerprints remain ineligible. A static capability scope limit alone is not a trust decision. The request also binds the expected previous reviewed SHA. The backend captures and validates the selected derived evidence, rechecks the exact source and previous baseline under the existing review lock, then updates the private baseline. Another review advancing that baseline invalidates the earlier approval.

Review records a version and bounded derived evidence for change tracking; it does not trust, pin, activate or remediate the artifact. Refresh never accepts changed content. Existing valid v1/v2 baseline files remain readable without writes, including their exact prior evidence profile. Only an explicit review produces a v3 store with source provenance, preserving older hash-only rows as having no historical details.

V3 baselines persist under `<STROQ_HOME>/console/inventory-<workspace ID>.json`, with at most 512 entries and 8 MiB per workspace. They retain the finite source ID, sanitized file labels/IDs/hashes/sizes, aggregate capabilities, rule metadata, engine/coverage fingerprints and review/capture times; never raw file content, commands, environment values or snippets. New files are private. Retention has no automatic expiry or eviction; malformed, unsafe or full storage refuses another review. Sensitive labels remain hidden. The baseline is local review history, not signed provenance.

An explicit export captures the exact current comparison, its reviewed evidence where available, and an export timestamp. Local links exclude authentication fragments, query tokens and search text. The view's browser layout and keyboard behaviour have not been separately verified.

## Attention and a fresh version

Protection keeps threshold-reaching static signals visible even after the exact
version has been reviewed, unless a separately recorded signal assessment still
matches this exact source revision and analysis. Incomplete captures, unverified historical entries,
partial source coverage and an invalid baseline remain distinct attention
conditions. Matched-rule counts alone do not produce a suspect verdict.
Up to six source-qualified artifact rows link to exact workspace/item/SHA
selections; overflow retains explicit matching-view links. Changes and first
reviews have their own inventory views. No row claims an observed attack or
runtime remediation.

The inventory view is retained in local links, selection, type filters and close
navigation. `Matched signals`, `Changes`, `New` and `Incomplete` filter the current
captured inventory; Incomplete also opens coverage. A failed full inventory read
keeps its prior capture and timestamp explicitly historical. Only a valid matching
read refreshes that state; polling workspace or live-job history never does.
This is not background skill monitoring.

If a selected version or baseline changes, comparison refuses it and offers a
read-only **Refresh inventory** action inside the dialog. A changed linked version
closes the old selection and focuses **Open current version**. Opening the new
version remains explicit and never accepts it. Existing supported quarantine and
MCP actions keep their independent capture, scope and consent requirements.

## Exact-revision signal assessments

A complete suspect skill has a separate **Signal decision** action: Accept risk
or False positive with a finite reason, an exact preview and an acknowledgement.
**Reopen signals** appends another decision. The original verdict, rules and
findings remain visible. Recording an artifact baseline never implicitly records
a signal decision.

Each assessment binds workspace, opaque item ID, source family, agent, scope,
complete artifact SHA, captured directory/file metadata and an analysis fingerprint.
The latter includes the actual verified local runtime digest, rules profile and
scan/capability result. An ordinary A → B → A edit changes metadata even if the
bytes return to A; the old assessment stays historical. A different runtime or
analysis also requires another explicit assessment. A user-scoped skill decision
belongs only to the current workspace context.

Only a current matching assessment removes the corresponding static-signal row
from Protection. New/Changed/Missing artifacts, baseline failures, incomplete
captures, source coverage and historical inventory reads remain independent.
An unavailable decision store keeps signals unresolved and adds a coverage item.
Static blind spots remain visible; actual omitted file/match details, timeouts
and invalid UTF-8 cannot be acknowledged as complete evidence. The selected
assessment is a fresh capture separate from an older comparison report; exports
retain its own timestamp and binding.

`POST /api/inventory/signals/state` accepts `{id, expectedSha256}`. Preview adds
`expectedDecisionId`, `decision` and `reason`; apply accepts only an opaque
`previewId` and `acknowledgeSignalOnly: true`. All three use the local bearer,
Host, same Origin/Fetch-Site and strict JSON gates with a 4 KiB input bound.
State and preview never create storage. At most eight previews live for two
minutes in the parent service. Apply consumes its preview once, including a
failed stale apply. The existing inventory lock remains held until the worker
terminates. Before publishing, the worker rechecks source binding, prior item
decision, actual runtime digest and expiry. Unrelated item decisions merge; a
changed decision for the selected item requires another preview.

Private records live at
`<STROQ_HOME>/console/inventory-signals-<workspace ID>.json`, schema
`stroq-inventory-signal-store/1`. They retain opaque IDs, digests, source/scope,
finite reason, timestamp and append-only events. No raw instruction text,
excerpts, absolute source paths or free-form comments are retained. Files require
0600 permissions and owned, pinned, nonlinked storage. Exclusive staging,
raw-byte compare-and-swap, fsync and verified readback protect publication.
Retention is unencrypted, bounded to 512 events / 512 KiB per workspace, without
automatic expiry or eviction. A malformed, unsafe or full store refuses another
decision. Public history shows the latest 32 events for the selected item and an
explicit omitted count. This assessment changes no skill files, baselines,
detector rules, permissions, agent trust or native discovery, and establishes
neither runtime blocking nor a safety verdict.

### Design references

GitHub documents reason/comment and reopening for
[code-scanning dismissals](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts#dismissing-alerts),
with dismissal scope across branches. DefectDojo documents that
[reimport does not reopen matching Risk Accepted or False Positive findings](https://docs.defectdojo.com/import_data/import_intro/reimport/)
and warns about treating partial scans as complete replacements. Snyk exposes
[ignore reason, expiry and path scope](https://docs.snyk.io/developer-tools/snyk-cli/commands/ignore),
with broader behavior when path is omitted. These describe what those tools
document; Stroq did not run them. Stroq's narrower exact revision and
analysis binding is an engineering choice, not a claim of vendor equivalence.
