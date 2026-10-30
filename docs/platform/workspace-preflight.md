# Workspace preflight

The Protection workspace check inspects the selected local checkout before its
startup features are enabled. It uses the existing CLI repository and agent
surface detectors. It is a static review of captured files, not an editor trust
setting, a sandbox or proof that a host blocked an action.

Open **Protection → Workspace** and select **Check workspace**. Opening the page,
refreshing history and following links never start a check. A running check can
be canceled. No project command, Git subprocess, package installation, MCP server
or provider request is launched by this workflow.

A check stays `running` while its terminal history write is pending. A completed
report is published after that write settles; a storage failure stays visible.
Cancellation waits for finalization and may return a completed report if reading
had already finished.

The report separates sources from detected capabilities. Files carry exact byte
fingerprints and permission modes. Relevant directories and links have separately
typed structural fingerprints, not invented file-content hashes. A formatting edit
therefore changes the captured version even when the detected execution
capabilities remain the same. Ordinary source-code edits outside the supported
surfaces do not create a new reviewed version by themselves.

**Review this version** requires explicit acknowledgement and a fresh matching
capture. It stores the derived report as the baseline for later checks. It does
not grant authority, change a policy, enable editor trust or mark a finding
resolved. A different reviewed revision or changed source requires a new review;
refresh never accepts changes.

The fixed workspace `.vscode/tasks.json` source has a separate explicit
[Make tasks manual action](workspace-task-controls.md), with exact-byte preview,
private recovery, guarded restore and a new static capture. Reviewing a version
does not invoke it. The file change and capture remain separate from editor
adoption or stopping already-running tasks.

## Error attention after review

Protection keeps observed **error-level** startup/instruction signals separate
from the review baseline. Recording **Review this version** can clear a source
change notice, but does not remove hidden-instruction, automatic-task or other
error observations from the queue. Warnings and notices remain routine report
entries rather than mandatory signal rows.

Each attention row identifies the captured source, line when available, capture
time and exact saved check. Six individual rows are shown, with an explicit
overflow link. A later failed/running check or unavailable runtime leaves prior
observations labeled **Historical capture**. Partial coverage keeps older errors
because absence has not been established. A newer complete capture closes only
its matching analysis-profile chain; a different runtime or scope cannot establish
that an older error was remediated. No signal is described as a confirmed attack
or proof of execution.

This projection uses the existing retained check history only. It creates no new
durable findings store or per-signal risk assessment. The separate task action
has its own recovery records; attention rows are not remediation receipts. Errors
can no longer be projected after their source reports leave that bounded history.
A complete later capture without the signal means only that it was not observed
within that capture's declared static scope. It does not establish native trust,
process termination or successful remediation outside that scope.

## Coverage and evidence

Supported detectors cover repository execution settings, hooks, environment
startup, supported editor/agent configuration, devcontainer commands and package
installation scripts. A capability means a static execution surface exists; its
presence alone is not a malicious verdict. The report does not evaluate every
possible extension, interpreter, dependency or startup behavior.

Coverage is limited to file-declared workspace surfaces. Inherited `GIT_*`
environment settings and Git configuration outside the selected scope are not inspected. Active
worktree-specific Git configuration is read only when the common configuration
enables it. Unfollowed Git includes leave an explicit gap. So do two places Git
reads configuration and hooks from that the capture does not: the repository a
workspace with no `.git` of its own sits inside (a `.git`, or a bare repository,
in any folder above it), and a `.git` folder, file or link below the root of a
repository workspace (a nested clone or a submodule). Neither is read, and a
capture with either is never complete. `node_modules` is not walked, so a `.git`
inside it (a package installed as a clone) is neither read nor named as a gap.

Ordinary repositories and plain folders are supported. A worktree's Git metadata
requires a matching backlink and verified common-directory relationship. Only
fixed metadata paths are read through that relationship. Arbitrary Git includes,
external hook locations, objects, refs and logs are not followed.

Reads are bounded and do not follow arbitrary external links. Unreadable or
invalid inputs, nonregular files, unsupported metadata and exhausted budgets are
explicit gaps. A complete report cannot be inferred from an empty hit list.
Observed file and directory dependencies are checked again before capture
completion; file changes during reading produce incomplete evidence.

Comparison requires complete captures from a compatible analysis runtime. It
lists source revision changes separately from capabilities added or removed.
An incomplete capture cannot establish that an earlier capability disappeared.
Reports describe their capture time; optional change watching repeats this bounded
capture rather than continuously observing every filesystem event.
The comparison inside a saved report retains the baseline that existed when the
check ran. The Protection queue compares the latest capture with the current
reviewed baseline. Recording review does not rewrite earlier reports.

The selected Stroq data directory is excluded when it is a strict descendant of
the workspace, with that exclusion declared in the report and bound to the
comparison scope. Retained reports and recovery copies are not treated as live
startup sources. Changing the excluded scope prevents a full comparison. Selecting
the Stroq data directory itself or one of its descendants is unsupported; the
check never excludes the whole workspace and calls the result complete.

## Local boundary

The browser can select only fixed check, cancel and review operations. Workspace
paths and runtime selection come from the local server context. Reports retain
bounded derived metadata and fingerprints, not raw commands or file contents.
Relative source labels remain local metadata and may identify project structure.

The baseline write checks the previously reviewed revision and current capture
under a server-held lock. Files are stored privately and verified after writing.
Uncertain writes require explicit reconciliation, never automatic retry. As with
other portable filesystem transactions, this is not an operating-system atomic
compare-and-swap against a malicious process running as the same user.

This workflow has been tested only with temporary local fixtures, not with a real
client. It does not establish a client trust change or host blocking.

## Change watch

Select **Watch changes**, review the preview and acknowledge local checks and
metadata retention. Stroq checks once, then waits five minutes after each attempt
finishes before checking again. A manual check already in progress causes a
skipped attempt; there is no catch-up burst. Protection refreshes the saved
reports while watching is enabled and compares them with the explicit reviewed
baseline. New versions are never approved automatically.

Watching runs in the local console service. Closing the browser does not stop it;
closing the service does. A service restart can resume a saved opt-in only when
the canonical project, selected user, storage identity and exact runtime match.
Identity or runtime changes require a fresh preview. A private per-workspace
lease prevents two consoles from owning the same watch. A second console reports
that the watch is in use and does not silently take over.

Manual checks in other consoles remain independent. Saved terminal reports are
merged under the configuration lock and refreshed on read. This console displays
its own active check; unfinished rows from another producer are omitted because
the retained format cannot establish their live ownership. Their completed
reports appear on refresh. Omission does not establish cancellation or failure.

**Pause** saves disabled intent before stopping future checks. A check already
accepted may finish, and completed reports remain available. The monitor does
not execute workspace code, call a provider, grant trust or establish host
blocking. It has the same coverage gaps and limits as a manual check.

The opt-in is stored privately at
`<STROQ_HOME>/console/workspace-monitor/<workspace identity hash>.json`.
It contains identity metadata, runtime binding, the last explicit configuration
time and enabled intent. There are at most 64 records, 8 KiB per record and 1 MiB
in aggregate; malformed or full storage is preserved and refused. Periodic
checks use the existing bounded history rather than appending unbounded opt-in
events. The last scheduling attempt is service-local and is not an archival log.

Opening or refreshing the page never enables watching. Changes use a one-use
two-minute preview bound to the exact intent revision and runtime. An uncertain
write requires an explicit state refresh before another action.

## Fixed local API

All operations use the existing authenticated loopback boundary. Actions require
same-origin JSON and accept no project path, executable, environment or Git ref.

| Route                                 | Input                                                                                                | Result                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/workspace-review`           | None                                                                                                 | Saved attempts and current reviewed baseline; no scan             |
| `POST /api/workspace-review/check`    | `{}`                                                                                                 | `202`, a fixed static-check job                                   |
| `POST /api/workspace-review/cancel`   | Exact run `id`                                                                                       | Terminal or already recorded run                                  |
| `POST /api/workspace-review/review`   | `runId`, `expectedCaptureSha256`, nullable `expectedReviewedRevision`, `acknowledgeReviewOnly: true` | Source-bound review receipt                                       |
| `GET /api/workspace-monitor`          | None                                                                                                 | Current saved intent and service scheduling state; no check       |
| `POST /api/workspace-monitor/preview` | Fixed `action` (`enable` or `pause`), nullable `expectedRevision`                                    | One-use preview; no check or saved intent                         |
| `POST /api/workspace-monitor/apply`   | `previewId`, `confirm: true`, `acknowledgeLocalChecks`, `acknowledgeRetention`                       | Exact enable/pause receipt; enable requires both acknowledgements |

Checks run in a worker with a 25-second deadline and 256 MiB heap limit. History
retains at most 32 attempts within 8 MiB; it may evict older reports. The reviewed
baseline is separate. Public captures are limited to 512 sources, 1,024 signal
groups and 1 MiB. Malformed, duplicate-key or unsafe retained history is refused
and preserved rather than replaced with an empty result.
