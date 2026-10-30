# Protection check

One explicit **Run protection check** action answers what was inspected, what
the current policy decides, which saved expectations still hold, and what the
workspace capture observed. It creates one saved report with useful next
actions, without needing a model subscription or making a provider request.
It covers local checks and their recorded evidence, not native-client
interception.

## Five stages, one report

The server owns this fixed sequence. The browser submits only the operation kind;
it cannot supply commands, paths, stage results or a caller-selected workspace.

| Stage            | Operation                                         | Evidence and limit                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation     | Existing `doctor` check                           | Inspect supported local setup and runtime diagnostics. Configuration presence is not proof that a native client loaded a hook or blocked an action.                                                                          |
| Policy           | Existing `policy-check`                           | Validate the selected local policy and report its source and findings. A valid file is not proof that an already-running agent adopted it.                                                                                   |
| Policy scenarios | Existing CLI `guard-test`                         | Evaluate the bounded bundled attack and ordinary-work scenarios. These are simulations; scenario commands are not executed.                                                                                                  |
| Saved checks     | Existing durable policy-case reader and evaluator | Re-evaluate saved expectations shared by the selected Stroq home across workspaces. Retain the case revision, policy fingerprint and finite results. No saved cases means zero evaluated, not a successful regression suite. |
| Workspace        | Existing workspace-review capture                 | Start one bounded static capture and reference that exact accepted run, capture fingerprint, profile and coverage. A different manual or watch run is never used as this stage's evidence.                                   |

Saved checks are a separate stage because the CLI `guard-test` operation does not
load the console's durable cases. Its result is not presented as if it did.
Neither simulation establishes a false-positive rate on production traffic.

The parent run ID identifies the report. Installation, policy and scenario
results are exact validated projections embedded in that parent, with individual
stage times and statuses; these stages have no run IDs of their own. Saved-check results are
embedded with their exact revision and policy identity. The workspace stage
contains its own real run ID and capture identity, so the link opens the capture
actually produced for this parent, not the newest capture at click time.

## Results and attention

Opening or refreshing the page only reads existing state. Start and cancel are
explicit authenticated actions. The report distinguishes queued, running,
completed, failed and skipped stages, and keeps completed evidence when a
later stage cannot finish. A completed stage can contain failing checks; a
finished workflow does not mean every protection passed.

The report shows compact outcomes with evidence links: installation issues,
policy findings, scenario failures, saved-check failures and workspace signals.
Configuration inspection, simulation and static capture stay distinct. There is
no combined security score, no count of prevented attacks and no universal
**Protected** badge. Native-client interception remains unverified by this
workflow.

## Failure, cancellation and context

- The parent pins the workspace identity, policy fingerprint and runtime
  identity, and rechecks that context between stages and before accepting later
  evidence. Drift stops the remaining work; earlier results stay as historical
  evidence and a fresh explicit run is required. A new context is never
  recaptured silently into the old report.
- An invalid policy skips dependent simulations. An independent workspace
  capture can still produce useful evidence. Process failure, malformed reports,
  unavailable evidence and partial coverage stay visible.
- All five offline check kinds are serialized across consoles under the same
  lease. Individual checks do not get separate permission to overlap the parent.
  A busy workspace stage is a visible
  failure, not permission to attach to, replace or cancel someone else's check.
- Cancellation aborts only work owned by this parent, waits for its termination
  or finalization, and skips later stages. It cannot stop a native agent or undo
  actions that already occurred. Nothing is retried automatically after
  cancellation, restart, ownership loss or an unknown result.
- A new run is refused when bounded history cannot be safely read. A persistence
  failure halts later stages and marks the report incomplete; an in-memory result
  is not described as saved. After service restart, a retained unfinished
  run has unverified ownership and is never resumed automatically. Only a new
  explicit admission after verified exclusive lease acquisition can record the
  earlier attempt as interrupted; opening a page cannot mark foreign work stopped.
  Running admission, progress and terminal publication require a fresh exact
  readback. An uncertain write or release latches new starts in that service;
  check local storage and restart to reread persisted evidence. GET does not
  clear an unsaved attempt or retry it. See [shared offline control boundaries](engine-capabilities.md#offline-control-service).

## Scope and retained data

Reports use the existing private, unencrypted control history: at most 32 runs
and 8 MiB, with no automatic expiry. This is bounded operational history, not an
enduring audit archive. The workspace capture retains its separate existing
bounds and can be evicted independently. An unavailable exact capture is shown
as unavailable rather than silently opening the latest one or claiming current
coverage.

The report keeps producer-owned typed facts: fixed diagnostic codes, finite
counts, scenario outcomes, case IDs, fixed action classes and revision,
fingerprints, stage times and the exact workspace run reference. It does not
copy raw CLI reports, policy YAML, submitted commands, prompts, transcripts,
arbitrary stderr or source-file contents into the parent. Existing detail workflows keep their own documented privacy limits;
local storage and hashes do not make sensitive data anonymous.

The check does not call a provider, run a native client, execute discovered
skills/MCP/task commands, install or change hooks, edit settings or policy,
enable a watch, record a baseline review, approve a tool, or change permissions.
It writes the reports and private coordination lease for these explicit checks. Findings remain
observations within captured scope; absence is not proof of remediation.

## Research behind the workflow

The sources below document vendor mechanisms. Stroq did not test any of those
platforms or runtimes.

[Lakera policy health](https://docs.lakera.ai/docs/policies/self-hosted-policies)
distinguishes the resolved custom/default policy. Its
[Policy Impact Simulator](https://docs.lakera.ai/docs/policies/saas-policies)
compares historical configurations with explicit time and detector coverage.
[OpenShell policy management](https://docs.nvidia.com/openshell/latest/how-it-works/policies/manage-policies)
separates base/effective policy and loaded revisions, and limits what a dry-run
proves. [Prisma agent discovery](https://docs.paloaltonetworks.com/prisma-airs/ai-inventory/agent-discovery)
separates configuration from runtime observations and correlates asset identity
with scan evidence.

The engineering transfer is one repeatable check with exact evidence identity,
visible coverage and honest results after changes to agent setup, skills or
policy. It is not an assertion of equivalent enforcement or detector quality.
