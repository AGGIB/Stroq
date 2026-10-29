# Skills & MCP watch

Skills & MCP watch records changes in the selected local workspace and user
sources while the local console service runs. It is an independent, explicit
opt-in under **Protection → Skills & MCP watch**. Enabling the existing Workspace
change watch does not enable this watch or extend that earlier consent.

This page describes the watch's source and storage contracts. It is a
description, not a record of verification.

## Enable, resume and pause

Select **Watch sources**, inspect the preview, and acknowledge local checks,
selected user sources and metadata retention. Enable and pause use one-use,
two-minute previews bound to the current saved intent revision and private
runtime/source context. Loading watch state, opening observed history and
refreshing that state do not enable the watch or start an observation.

A successful enable schedules an initial check. Each completed, failed or skipped
attempt that leaves the watch enabled schedules the next attempt five minutes
after it finishes. Checks do not overlap or accumulate a catch-up burst. A busy
inventory/configuration operation can leave a skipped attempt; a transient
unavailable capture preserves history and can retry. A binding or storage failure
can stop scheduling and expose Needs review or Unavailable.

Scheduling belongs to the local service, independently of browser polling.
Closing the browser does not stop it. Closing the service stops its timer and
releases its lease after outstanding work drains. Restart resumes a saved opt-in
only when the canonical workspace/user identities, data-directory location, engine
runtime and source-selection profile still match. Another console holding the private lease
produces In use, without a takeover.

**Pause watch** saves disabled intent before draining this watch's outstanding
read. It does not cancel a shared inventory worker on behalf of other operations.
A late result from the previous scheduling generation is discarded; an observation
already published before pause remains historical. Pause retains saved versions
and remains available when the runtime or observation history cannot be read,
provided the saved intent and its private location are still verifiable.

## Fixed source scope

Workspace and user paths come from the local server. The browser cannot submit a
path, command, executable, environment map or alternate worker operation.

### Skills

The collector searches recursively for `SKILL.md` inside six fixed families:

| Source               | Selected workspace | Selected user home         |
| -------------------- | ------------------ | -------------------------- |
| Claude               | `.claude/skills`   | `.claude/skills`           |
| Shared agents        | `.agents/skills`   | `.agents/skills`           |
| Codex local / legacy | `.codex/skills`    | `.codex/skills`            |
| Cursor               | `.cursor/skills`   | `.cursor/skills`           |
| Windsurf             | `.windsurf/skills` | `.codeium/windsurf/skills` |
| Devin                | `.devin/skills`    | `.config/devin/skills`     |

Each source/scope has Read, Absent or Partial coverage. Absent means that exact
fixed folder was absent. If the workspace is the selected user home, skill
sources are collected once with user scope; six missing project copies are not
invented as gaps.

The watch inherits bounded traversal, capture and content scanning from the
[installed-artifact collector](artifact-review.md#skill-evidence): 256 discovery
candidates, 1,024 directories, 4,096 directory entries, eight levels, and aggregate
skill capture budgets of 4 MiB and 15 seconds. Unsafe links, unreadable inputs and
exhausted budgets remain explicit coverage limits.

These are filesystem origins, not proof that a client is installed or loaded a
skill. The watch does not reproduce a client's complete discovery/override rules,
resolve managed or synced skills, inspect plugin caches, search ancestor or nested
workspace roots, use main-checkout fallbacks, or revoke instructions already
loaded into a conversation. Managed content encountered inside a fixed source is
still only static evidence. Action eligibility is checked separately by
[skill quarantine](skill-quarantine.md).

### MCP configuration

The watch uses the existing supported JSON source selection:

| Source                | Scope and selected location                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Claude Code           | Workspace `.mcp.json`                                                                                     |
| Cursor                | Workspace and user `.cursor/mcp.json`                                                                     |
| Claude Desktop        | User platform-specific `Claude/claude_desktop_config.json` location                                       |
| Windsurf legacy       | User `.codeium/windsurf/mcp_config.json` when present; otherwise `.codeium/mcp_config.json`               |
| Devin Cascade current | User config base `devin/mcp_config.json`, selected from the server's supported platform/environment rules |

The current Devin config base uses normalized `XDG_CONFIG_HOME` or its `.config`
default on non-Windows platforms; the selector also models Windows `APPDATA`.
This does not establish watch support on an unsupported host platform. Environment
bases outside the selected user root are refused. Claude Desktop retains its own
platform-specific fixed location. A workspace equal to the user home has one
Cursor user source, without a duplicate Cursor project source.

A registration is captured as canonical entry JSON, with safe transport, wrapper
and strict-mode metadata. MCP configuration reads are bounded to 256 KiB per file.
Codex TOML and VS Code MCP sources are outside this inventory. A configuration
entry does not prove that its server is connected or that a particular tool is
available. The watch never starts a server, fetches remote tool definitions,
executes a skill or project command, or calls an AI provider.

## Observation is separate from review

The private scheduler uses the collector's `observe` operation. It captures
current sources without reading or decorating them with the reviewed inventory
baseline. A malformed baseline, baseline-only missing rows and baseline overflow
therefore cannot create source changes or artificial watch gaps.

The saved projection contains bounded artifact identities, sanitized labels,
non-null artifact fingerprints, scan summaries, static capabilities, MCP metadata,
source coverage and gaps. It excludes the reviewed SHA, review state, signal
assessment/risk decision, containment advisory and ordinary capture-generation
time. Recording review or accepting a signal does not manufacture an observed
source version. A null SHA does not establish a present artifact; the collector's
unreadable-source coverage remains relevant.

The first capture establishes an observation history entry. It does not create a
review baseline, grant trust, accept risk, approve a tool contract, change a policy
or apply containment. An empty finding list or a complete bounded capture is not
a safety verdict.

The capture is a collection of bounded reads, not an OS-atomic snapshot of all
sources. Its timestamps describe observation, not installation time or continuous
presence between checks.

## Comparing adjacent versions

Comparison uses adjacent observed versions in the same private context chain.
Skills are grouped by exact source and scope. MCP registrations are grouped by
agent and scope: current public metadata cannot safely attribute every Windsurf
registration to a separate physical config file, so a gap conservatively affects
that whole group. Unknown gap scope/kind cannot silently establish absence.

| Captured evidence                                                                                      | Recorded change                                          |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Reliable before/after hashes for the same artifact and source differ                                   | Changed, even when another item made that source partial |
| Artifact appears only after; its source group is complete in both adjacent captures                    | Added                                                    |
| Artifact appears only before; its source group is complete in both adjacent captures                   | Missing (`removed` in the API)                           |
| Artifact appears after an incomplete source observation                                                | Observed; first discovery is unconfirmed                 |
| Artifact is absent from a partial source, or an incomplete tree cannot establish a reliable comparison | Unverified                                               |

One partial source does not suppress a valid comparison in another complete
source. Partial capture never establishes removal for its affected group. A failed
capture writes no replacement version and preserves the previous accepted history.
A later complete capture compares with its immediate predecessor; it does not
rewrite an earlier partial observation into a complete one.

Adjacent identical projections in the same chain coalesce: their version ID and
first-observed time remain fixed, and last-observed time advances. A → B → A is
three versions; returning to an earlier hash never reuses that earlier version's
ID. Coverage or captured metadata changes can also create a new version.

Every accepted check has a fresh `checkId`, including a check coalesced into the
same version. The stable `latestCaptureId` identifies the observed version;
`latestCheckId` identifies the most recent accepted check. Failed or skipped captures do not replace accepted versions. An uncertain
publication requires a saved-state refresh to determine whether new IDs were
published. This history is not an archive of every timer
attempt or every filesystem event.

## Current Protection and historical views

**Observed versions** shows saved source-change evidence. An exported observation
is marked `currentReview: false` and `hostEnforcement: false`. Following a history
link does not use the old row as current evidence or authorize an action.

After a newly accepted check, Protection requests a fresh current inventory once
for that new check ID, including when the observation version coalesced. Repeated
state polls do not trigger inventory reads. A busy view defers that refresh rather
than treating saved history as a fresh assessment. A failed refresh keeps earlier
content explicitly historical.

Review, signal decisions, quarantine and MCP controls continue to use their own
fresh source-bound previews and evidence. Watching neither clears their attention
rows automatically nor treats a changed/missing configuration as remediation.

## Private context and storage

Saved intent binds the canonical project/user identities and storage location,
engine version, runtime SHA and a private source-profile SHA. The profile hashes
platform and effective normalized MCP environment selection, without retaining
raw environment values. The history chain includes that binding. A changed
runtime, root identity or source-selection profile requires a fresh preview and
enable; it cannot silently resume the previous comparison chain. A new chain
retains older history where its workspace store remains available and reports
comparison unavailable. A replacement project incarnation can select a different
private store identity rather than inheriting the earlier project's history.

The selected Stroq data directory cannot be a fixed skill root or lie inside one.
Both selected and canonical locations are checked to prevent watch history from
being collected as a live skill source. This restriction does not prevent pausing
a retained, verifiable intent.

| Data                                            | Private location and bound                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Explicit enabled/disabled intent                | `<STROQ_HOME>/console/inventory-monitor/<store ID>.json`; at most 64 records, 8 KiB each, 1 MiB aggregate                   |
| Accepted observed versions and comparison facts | `<STROQ_HOME>/console/inventory-monitor-observations/<store ID>.json`; at most 16 adjacent versions and 8 MiB per workspace |
| Service ownership                               | Separate private `inventory-monitor-leases` namespace; independent of Workspace watch ownership                             |

Directories are private `0700`, files `0600`. Metadata is local and unencrypted;
sanitized names, relative folder labels, hashes and timestamps can still reveal
project structure. Source files, instruction text, launch commands, environment
values and content snippets are not retained in this observation store.

History is newest first. Reaching a version or byte bound evicts oldest versions,
with an explicit omitted count. Each public version projects at most 64 change
rows, while preserving the total/omitted counts and private comparison facts.
The public state response has a separate 1 MiB bound: oldest versions can be
omitted from that response until it fits. Such view trimming increments its
omitted count without deleting those additional versions from private storage.

Reads reject malformed, duplicate-key, unsafe or incompatible private records and
preserve their bytes. Missing profile binding is not silently migrated. Writers
recheck pinned locations, intent revision, roots, staged bytes, runtime/source
context and lease before guarded publication under the configuration lock.
Unconfirmed publication remains explicit uncertainty; it never rolls back over
foreign state or silently resets history. This is portable filesystem protection,
not isolation from a malicious process running as the same OS user.

## Local API and implementation map

All routes use the console's authenticated loopback and same-origin JSON gates.
Action bodies are strict JSON, limited to 4 KiB, and carry only fixed operations
and opaque revisions/IDs.

| Route                                 | Contract                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/inventory-monitor`          | Saved intent, service attempt state and projected history; no observation                                                                                                    |
| `POST /api/inventory-monitor/preview` | `action: enable/pause`, nullable `expectedRevision`; prepares a one-use preview                                                                                              |
| `POST /api/inventory-monitor/apply`   | `previewId`, `confirm: true`, `acknowledgeLocalChecks`, `acknowledgeUserSources`, `acknowledgeRetention`; all three acknowledgements are true for enable and false for pause |

The public schema is [inventory-monitor.ts](../../console/lib/inventory-monitor.ts).
The fixed routes, lifecycle and context checks are in
[inventory-monitor-http.ts](../../console/scripts/inventory-monitor-http.ts),
[inventory-monitor-control.ts](../../console/scripts/inventory-monitor-control.ts),
[inventory-monitor-service.ts](../../console/scripts/inventory-monitor-service.ts)
and [inventory-monitor-context.ts](../../console/scripts/inventory-monitor-context.ts).
[Inventory observe](../../console/scripts/inventory.mjs) selects the private worker
operation; [observation projection](../../console/scripts/inventory-observation.ts)
and [storage](../../console/scripts/inventory-observation-store.ts) define the
retained source facts and adjacent comparison behavior.

## Primary-source design references

These are documented vendor behaviors and engineering inputs. Stroq did not run
those products or reproduce their results.

- **Snyk Evo ADS:** its MCP Governance documentation separates discovery from
  endpoint log/block enforcement through hooks. That distinction supports a clear
  boundary for Stroq: this watch supplies periodic static evidence, while actual
  runtime controls require their own integration and proof.
  [MCP Governance GA](https://snyk.io/blog/evo-ads-govern-agent-behavior-ga/).
- **MCPProxy:** its review flow distinguishes current/stale scan coverage and
  binds approval to the definitions shown. A clean scan of a changed contract does
  not itself approve that change. Stroq adopts the separation of observation and
  decision, without claiming that this local config watch observes remote tool
  definitions or provides MCPProxy's runtime quarantine.
  [Security quarantine](https://docs.mcpproxy.app/features/security-quarantine/).
- **MCPProxy attention workflow:** a review item opens the relevant review screen
  rather than directly approving from the summary. This informs the handoff from
  current Protection evidence to a separate fresh decision flow.
  [Needs Attention](https://docs.mcpproxy.app/features/needs-attention/).
- **DefectDojo:** its reimport documentation warns that partial scans can
  incorrectly close findings when interpreted as full replacements. Stroq's
  source-group completeness checks address that same class of comparison error;
  they do not automatically close or remediate findings.
  [Reimport and partial-scope warning](https://docs.defectdojo.com/import_data/import_intro/reimport/#why-findings-close-and-reopen).

The engineering choices and limits above come from Stroq's implementation. None
of these references establishes equivalent coverage, host blocking, native skill
loading behavior or real-provider verification for Stroq.
