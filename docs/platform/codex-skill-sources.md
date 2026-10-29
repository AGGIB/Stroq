# Codex skill source inspection

This is bounded source inspection, not effective-session or enforcement proof.

**Codex sources** is a manual local preview of selected Codex skill sources and
captured user configuration. It helps find ancestor skills that the ordinary fixed
inventory does not inspect. It does not establish the skills loaded by a running
Codex client, the validity of that client's full configuration, or its effective
session enablement.

## User workflow

Open **Skills & MCP → Codex sources**, or **Agents & coverage → Codex CLI → Skill
sources → Inspect**. The selected local workspace and user context must be available. The
button starts a capture; mounting the page or opening the agent card does not.

The dialog shows the selected Codex data-directory class, source boundary, marker
policy, user configuration status, source chain and captured entrypoints. Each
copy retains its source family, scope and safe folder label. Expand a source to
see entrypoints and **Entrypoint evidence** for hashes, static rule matches and
capability hints. **Coverage & limits** explains partial or uninspected coverage.
An empty match list is not a safety verdict.

**Inspect again** performs another bounded capture. Earlier evidence becomes
historical while a replacement is pending; a failure retains it as historical.
Closing the dialog cancels that view's pending request and rejects late results.
The report is held in the current view, without a saved inspection history.
**Export source evidence** explicitly downloads the sanitized report and its
historical flag.

This operation does not run a Codex client, call a provider, execute a skill or
project command, start an MCP server, or fetch remote skill content. It reads no
review baseline and creates no trust or approval decision.

## Selected sources and boundary

The local server supplies the selected canonical workspace, canonical user home
and its captured `CODEX_HOME` setting. The browser supplies no path, command,
environment map or alternate source list.

The preview considers two local folder families:

| Location                                                            | When inspected                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Selected directory `.agents/skills`                                 | Always, subject to safe paths and capture limits                                                |
| Each ancestor `.agents/skills` through the nearest marker directory | Only when the marker boundary is established                                                    |
| Selected user home's `.agents/skills`                               | Independently of the repository boundary                                                        |
| Selected directory `.codex/skills`                                  | Always, subject to safe paths and capture limits                                                |
| Each ancestor `.codex/skills` through the nearest marker directory  | Only when the marker boundary is established                                                    |
| Selected Codex data directory's `skills`                            | Independently of the repository boundary, when the selected directory can be established safely |

The chain is displayed from the selected directory toward the boundary, with
shared `.agents/skills` followed by legacy `.codex/skills` at each level, then the
user sources. This presentation order is not native override precedence. Equal
names at different paths retain separate source/candidate identities. An identical
source path is captured once; a path also matching a user source keeps user scope.
If both user routes resolve to the same literal canonical path, the shared route
and its existing identity are retained. No symbolic-link target is followed to
deduplicate or expand coverage.

Both distinct user rows and the three uninspected system/admin/plugin rows are
reserved before the source-row cap. Farthest repository roots beyond that cap are
omitted explicitly with a source-limit gap. Candidate, byte and traversal budgets
remain shared across both families; reserving a row does not reserve entrypoint
capacity. A present source can therefore still have partial or omitted evidence.

The marker policy comes only from the captured user `config.toml`:

- A missing file or an omitted `project_root_markers` uses `.git`.
- A valid empty array intentionally selects the current directory only.
- A supported configured array contains at most 32 nonempty basenames, each no
  longer than 255 characters. Path separators, `.` and `..` are unsupported.
- The nearest regular file or directory with a marker name establishes the
  boundary. An ordinary `.git` file is sufficient: its target is not interpreted.
  A `.git` directory does not need a `HEAD` file for this preview's skill boundary.
- A refused link, unreadable marker, unsupported policy or exhausted ancestor
  bound leaves the boundary unverified or limited. Only the selected directory
  and user skill roots are then inspected.
- If no marker is found, ancestor skill folders are not inspected.

The ancestor walk probes at most 32 directory positions, including the selected
current directory. It does not execute Git, inspect nested repositories to find
new roots, follow worktree gitfile targets, or infer a main-checkout fallback.
Selected roots, inspected ancestor identities, marker observations and captured
configuration are rechecked during the operation. Source and entrypoint checks
also reject changed filesystem identities. This is a sequence of bounded reads,
not an atomic snapshot across all sources.

## Codex data directory and user declarations

Absent or empty server-captured `CODEX_HOME` selects the default user `.codex`
data directory. A nonempty custom data directory must be an existing canonical directory inside
the selected user home, reached without linked components. Relative, outside,
missing or unverifiable custom directories are explicitly unsupported; they never
silently fall back to the default. The preview bounds the custom data-directory path to
4,096 characters. The default data directory's linked or unreadable configuration is
also refused.

The report's existing `context.profile` field identifies this data-directory
selection. It does not identify a native `--profile` configuration. Named profile
files and session overrides remain unverified. An unsupported data-directory
selection keeps the user legacy source explicitly uninspected; selected workspace
sources and the modern user `.agents/skills` remain independently inspectable.

Only the selected data directory's `config.toml` is read, up to 256 KiB. The capture uses
strict UTF-8, strict TOML parsing, bounded parser depth and typed fields. Duplicate
keys, quoted Boolean values such as `enabled = "false"`, or a non-table `skills`
value cannot silently become valid declarations. Invalid, unavailable and
unsupported settings leave item declaration state **Unknown**. A missing user
configuration produces **Not specified** for otherwise valid captured metadata.

The parser is pinned `smol-toml` 1.9.1, whose documented grammar is TOML 1.1.
Parsing successfully here means that Stroq could interpret this bounded user
capture. It is not an oracle for the TOML version or whole configuration schema
accepted by the installed Codex runtime. Unrelated native settings, managed
layers, project layers and session overrides are not validated by this preview.

At most 512 `[[skills.config]]` entries are interpreted:

- `enabled` must be a Boolean. Exactly one `path` or `name` selector is used;
  both/neither selectors and empty names are ignored and counted.
- Relative selector paths are normalized against the containing configuration
  directory. Selectors never cause a target read, directory enumeration or
  filesystem canonicalization. An exact captured document path is a definite
  match; a different verified captured document is a definite nonmatch. Other
  paths may be aliases to the current document, so their possible effects remain
  unknown unless a later definite declaration establishes the result. A
  folder-shaped selector is never expanded to `SKILL.md`; without resolving it,
  its target type and possible alias effect remain unverified.
- Name selectors trim Unicode `White_Space` only at their edges and compare with
  the captured normalized name. Later matching rules override earlier rules,
  including a later name rule overriding a path rule.
  If a name cannot be established, a decision that depends on it stays unknown.
- Unmatched and ignored rule counts describe this bounded captured set. They do
  not establish that an uncaptured selector is invalid or ineffective elsewhere.

| Item state                 | Meaning in this report                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| User config: enabled       | A matching captured user declaration says `enabled = true`                                    |
| User config: disabled      | A matching captured user declaration says `enabled = false`                                   |
| User config: not specified | No matching or unresolved potentially matching user declaration applies                       |
| User config: unknown       | Configuration, metadata, unresolved path aliases or capture cannot establish that declaration |

These labels do not establish effective enablement in a Codex session. In
particular, session flags may change the result. The UI exposes no enable,
disable, review or quarantine mutation for these rows.

## Entrypoint evidence and limits

Discovery is recursive within each selected skill root in either family, including a
root-level `SKILL.md`. Hidden descendant directories are skipped and reported.
Linked paths and nonregular or multiply linked entrypoint files are refused.
Unreadable inputs, unverified metadata and exhausted budgets remain visible gaps.

Only `SKILL.md` bytes are captured and scanned. Referenced scripts, assets,
references and other skill-tree files are not read. An entrypoint SHA-256 therefore
fingerprints that document, not the complete skill package. Static capability
hints and rule matches describe document content; they do not prove execution or
host enforcement. A partial read or changed context cannot become a clean,
verified declaration.

Metadata is checked through the existing safe YAML reader, with a 16 KiB
frontmatter bound and no aliases, merges or duplicate keys. Common readable names
use collapsed Unicode whitespace, preserve case and Unicode, and allow up to 64
Unicode code points. A missing or empty name can use the normalized containing
folder name; a fallback that is still empty uses `skill`. A nonempty description
is required without a separate 1,024-character limit. The entrypoint and
frontmatter byte budgets still apply. Unsupported types or YAML features remain
**Metadata unverified**, with unknown declaration state. This reader does not
reproduce every repair or accepted syntax of the native parser.

| Bound                                        | Maximum per manual capture           |
| -------------------------------------------- | ------------------------------------ |
| Ancestor positions                           | 32, including the selected directory |
| Source rows                                  | 64, including uninspected families   |
| Entrypoint candidates                        | 128                                  |
| Traversed directories / entries              | 1,024 / 4,096                        |
| Recursive depth                              | 8 below a selected source            |
| Each `SKILL.md` / aggregate entrypoint bytes | 64 KiB / 8 MiB                       |
| User configuration                           | 256 KiB, 512 declaration entries     |
| Static matches per entrypoint / report gaps  | 32 / 128                             |
| Worker capture deadline                      | At most 15 seconds                   |

Omitted counters and gaps accompany bounded results. The worker deadline can end
an inspection with partial evidence or an unavailable response; it is not a
promise that every source will be enumerated. The browser also has its own
request timeout and rejects results from a cancelled or changed workspace view.

## Privacy, identity and separation

The report and export contain sanitized source labels, safe relative folder
labels, sanitized names, document and configuration hashes, finite status codes,
rule IDs/titles/severity, counts and capability categories. They exclude raw
`SKILL.md` text, frontmatter descriptions, raw TOML, selector values, absolute
source/data-directory paths, environment values and filesystem error text. Sensitive
folder labels can be withheld. Hashes remain derived local evidence, rather than
proof of safety or loaded state.

Manual source IDs use the `source-` namespace and candidates use `candidate-`.
Their identities include the selected source path and candidate locator so equal
leaf folders under distinct ancestor roots do not collide. These IDs are separate
from ordinary inventory artifact IDs. A displayed label or identifier does not
authorize filesystem access or a mutation.

Opening this preview does not expand the ordinary inventory, its review baseline,
existing quarantine eligibility, or either existing watch's source scope or
opt-in. It creates no watch intent, observation version, source-change alert or
recurring scan. The ordinary inventory can still independently inspect its
existing fixed `.codex/skills` roots under its own contract.

This preview shows bundled/system, administrator and plugin sources as
**Uninspected**. Hidden `.system` descendants are not inspected as legacy skills.
Managed configuration, named profiles and session overrides remain explicitly
unverified. It does not resolve synced skill
stores, plugin caches, remote hosts or every client-specific source layer.

## Upstream references and scope

The official [Build skills documentation](https://learn.chatgpt.com/docs/build-skills)
provides the product-facing explanation of skill directories and progressive
loading. It is a reference for users, not evidence that a local client discovered
or loaded any particular captured file.

These links point to upstream Codex at commit
`970111f6cb62cc02fe36a82ea7d71b37a2889c97`:

- [Skill roots and ancestor marker selection](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/skills/src/host_roots.rs).
- [Default and configured project root markers](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/config/src/project_root_markers.rs).
- [User/session skill declaration rules](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/config/src/skills_config.rs).
- [Custom Codex home resolution](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/utils/home-dir/src/lib.rs).
- [Native metadata parsing and normalization](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/skills/src/parser.rs).
- [Native host discovery](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/skills/src/loader/host.rs)
  and [merge behavior](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/skills/src/loader/host_merge.rs).

These are implementation references for a specific upstream revision. They do not
identify the installed client build or prove compatibility with it. Stroq applies
a deliberately bounded local subset, including refusing links and inspecting
only captured user declarations. Native effective resolution and already-loaded
session state require separate evidence.

### Offline native characterization

The installed official `codex-cli 0.163.0-alpha.11` on macOS was measured offline
with fresh disposable profiles, in a child OS sandbox denying network access. Only
`initialize`, `initialized`, `config/read` and `skills/list` were sent; no model
turn or provider request was made. The [sanitized summary](fixtures/codex-offline-skills-0.163.0-alpha.11.json)
retains the binary SHA, operation list and finite fixture results; it is not a raw
protocol recording or a statement of current-session loading.

That build listed modern and legacy CWD/repository/user skills, including legacy
folders without project configuration files. User name and exact document-path
declarations applied; project skill declarations were visible in `config/read`
but did not change `skills/list`. Project trust affected configuration layers,
while an untrusted fixture still listed these skill folders. User root markers
changed skill ancestry; project root markers did not. Accordingly, this static
preview neither merges project skill declarations nor hides roots based on an
assumed trust state.

The current official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes a folder selector. In the measured build a folder selector did not
disable the fixture, while its `SKILL.md` document selector did. Stroq preserves
unknown alias handling rather than silently expanding folders. These results
apply to the measured binary/platform and fixtures, not every Codex version or
active client.

Related contracts: [installed-artifact review](artifact-review.md),
[skill quarantine](skill-quarantine.md), and
[Skills & MCP watch](skills-mcp-watch-spec.md).
