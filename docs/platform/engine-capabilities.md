# Local control platform: engine boundaries

The console must distinguish configuration checks, content analysis, synthetic policy tests,
and live host evidence. A completed job is not proof that a host enforces a decision.

[Recorded evidence](recorded-evidence.md) adds a read-only exact-finding projection of historical action classes, task-scope kind, origin/gap counts and scan/trust fields already present in the journal. `POST /api/incidents/evidence` takes only the finding ID and expected raw-line SHA; it starts no CLI, native client or model. Activity's digest-bound link reaches the same investigation and durable review. Missing original taint, policy revision and host outcome remain unknown; current-policy comparison and current-session inspection stay separate.

## Existing engine entry points

Investigations also provides [stored-session taint control](session-taint.md). An exact verified finding resolves the native session privately; preview and consent precede a guarded taint-only publication under the native session lock. Provenance is retained, independent rules remain active, and later observations can taint again. Durable historical results, fresh state and native-host adoption are separate. Recovery is private/unencrypted, bounded to 32 records plus 32 opaque staging slots within 8 MiB, without automatic cleanup.

The separate [workspace task control](workspace-task-controls.md) changes only the fixed captured `.vscode/tasks.json` source. Its one-use two-minute preview, guarded writer, durable recovery, explicit interruption recheck and owned static capture distinguish a confirmed file publication from unavailable later evidence or native editor adoption. Recovery/staging is private, unencrypted and bounded globally within the selected Stroq home to 32 entries / 8 MiB, with no automatic eviction.

| Operation                   | Source and API                                                                                                                                         | Meaning and limits                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check installation          | `packages/cli/src/commands/doctor.ts`: `doctorReport`, `runDoctor`; CLI `doctor --json --all`                                                          | Reads host configuration, stored proof/liveness, pins, skill integrity, and secret-index statistics; runs a synthetic scanner self-test. A check's `ok` is not a host-installed/protected flag. Raw details may contain local paths and config-derived names.                                                    |
| Check policy                | `packages/cli/src/policy/check.ts`: `checkReport`; `policy/load.ts`: `readPolicyFile`; CLI `policy check --json`                                       | Schema and lint of current policy, with builtin fallback only when missing. Read errors are not a passing check. YAML loading has size/depth/alias bounds.                                                                                                                                                       |
| Test policy                 | `packages/cli/src/policy/test-command.ts`: `testPolicies`; `policy/replay.ts`: `replay`, `BUNDLED`; CLI `policy test --json`                           | Current policy and builtin baseline replayed over inert attack and ordinary-work corpora in scratch folders. Counts interruptions, escaping attacks, and unjudged cases separately. No real hostile command runs.                                                                                                |
| Scan pasted text            | `packages/core/src/scan/scanner.ts`: `scanContent`; `rules/bundle.ts`: `loadBundledRules`                                                              | Use a separate worker and an external deadline. Internal time budget is checked between regexes; it cannot interrupt a single regex. Skill text uses `instruction_file`; tool output uses target `tool_result` with the `tool_response` field mirrored. A clean scan does not certify safe code or installation. |
| Attack regression           | `packages/cli/src/attack/run.ts`: `runAttack`; CLI `attack --json`                                                                                     | Synthetic engine regression, not live blocking proof. Timeout, unsupported, error, and asked-by-limit are distinct from detection. Policy test already includes the attack corpus.                                                                                                                               |
| Inspect local skill/archive | `packages/cli/src/install/skill-confirm.ts`: `inspectSkillSource`; `install/inspect/index.ts`: `inspectTree`; CLI `vet --from ... --kind skill --json` | Static analysis, no unpacked code execution. Complete report does not mean safe. `--probe` is a separate execution operation and is not enabled by a static scan.                                                                                                                                                |
| Inspect repository          | `packages/cli/src/commands/inspect.ts`: `runInspect`; `exposure/repo-surface.ts`: `repoSurface`, `folderSurface`                                       | Preflight of repository execution surfaces; reports can include command/config text. Project IDs must resolve to server-selected roots.                                                                                                                                                                          |
| Install hooks               | `packages/cli/src/commands/init.ts`: `runInit`; `init-agent.ts`: `runInitCommand`                                                                      | Explicit agent/scope only. Dry-run output contains merged host config and must not be forwarded. OpenClaw can run an installer and requires a separate operation boundary.                                                                                                                                       |
| Harden agent settings       | `packages/cli/src/commands/harden-plan.ts`: `prepare`; `harden/apply.ts`: `applyPlan`; `harden/recheck.ts`: `assertUnchanged`                          | Existing plan/apply transaction supports `claude-read-deny` and `cursor-ignore`. Preserve before-state checks and required acknowledgements. Undo weakens a control.                                                                                                                                             |
| Install skill/MCP           | `packages/cli/src/install/skill-install.ts`: `addSkill`, `removeSkill`; `mcp-prepare.ts`: `prepareMcp`; `mcp-install.ts`: `addMcp`, `removeMcp`        | Existing interactive digest confirmation, target/source checks, backups, and compare-before-write must be preserved. Extract an explicit prepare/commit API; do not fabricate a terminal or auto-answer it. `prepareSkill` is currently private.                                                                 |
| Live proof                  | `packages/cli/src/commands/prove.ts`: `runProve`; `prove-flow.ts`                                                                                      | Explicit launch and request-budget disclosure. Default max 3 requests, ceiling 6. Claude driving supports non-Windows; Codex driving supports Windows. Dry-run exits zero without establishing proof.                                                                                                            |
| Secret exposure             | `packages/cli/src/commands/sent.ts`: `runSent`                                                                                                         | Deliberate scoped action: reads actual local credential values and transcripts in memory to match them. No values may reach browser, logs, or exported results. Not an automatic dashboard refresh.                                                                                                              |
| Audit integrity             | `packages/core/src/audit/audit-log.ts`: `AuditLog.verify`; CLI `verify`                                                                                | Chain integrity is not authenticity or protection against tail truncation. Use structured verify result, not terminal text.                                                                                                                                                                                      |

There are no `scan`, `skills`, or `install` CLI commands. The corresponding routes are
`vet`/`inspect`, `add`/`remove`, `init`, and the core scanner. `mcp`, `run`, and exposure
probing can launch supplied programs and must never be exposed as a general browser runner.

## Offline control service

The snapshot remains `stroq-console/1`. New authenticated routes add bounded, serial jobs:

- `GET /api/control`: engine availability, observed history and current service ownership.
- `POST /api/runs`: closed union of `doctor`, `policy-check`, `guard-test`, `content-scan`, `protection-check`.
- `GET /api/runs/:id`: one run. No arbitrary binary, argument, environment, or path fields.
- `POST /api/runs/cancel`: cancellation of an exact Protection check owned by this service.

`guard-test` invokes policy test against the builtin baseline, including the attack corpus.
`content-scan` accepts only pasted text and an enumerated surface. The backend retains
derived results, never the submitted text. The [Protection check](protection-check.md) adds
five fixed recorded stages, including separate Saved checks and an exact workspace capture.
None of these operations starts an agent or provider request.

The configured service retains at most 32 derived runs within 8 MiB in one private,
workspace-bound history file. All five kinds share the existing private per-workspace
owner lease and short history-writer lock. Admission must durably record and reread the
running row before starting work; a terminal result must also pass persistence/readback.
Unreadable or invalid history refuses new work rather than returning an ephemeral success.
An uncertain write, failed readback or lost release latches this service against further
starts, retaining its incomplete local report. After checking storage, restart the service
to reread durable history. An automatic GET cannot clear that latch or claim unsaved evidence
was recorded.
The no-home injected service remains a memory-only development/test mode, with history
explicitly disabled; the production console always selects a Stroq home.

Starting or reading a second console does not mark another console's running check as
stopped. `activeRunId` identifies only a running check owned by the responding service;
`activeProtectionCheckId` is its compatible parent-only subset. A foreign retained running
row has unverified ownership in this response and may still be live elsewhere. An explicit
new start must acquire the exclusive lease before it can classify an older unfinished row
as `interrupted`; that classification never proves process termination or resumes the old
operation. A live or unverified lease refuses duplicate work. Existing servers from before
leaf leasing do not acquire this new guarantee retroactively.

CLI paths and the project directory come from server configuration. CLI execution uses
the current Node executable, a fixed built entry path and fixed arguments, with `shell:false`.
Only allowlisted environment names are inherited. Bounded stdout is parsed into closed,
derived result objects. Raw stdout/stderr and arbitrary report text never reach the browser.
External deadlines kill work; CLI close and scanner-worker termination precede completion
or shutdown acknowledgement. Failed, malformed, truncated, and timed-out runs are not successes.

Every API requires bearer authentication and exact Host validation. Writes also require exact
same Origin, JSON media type, a bounded request body and allowed fields. The startup URL
fragment holds the token; HTTP queries and histories do not. Existing static path protections
and security headers remain in force.

## Apply architecture for later operations

Checks and static analysis can run on request without an additional approval prompt.
Enabling hooks or hardening needs a concrete preview and an explicit Apply action. Disabling,
unwrapping, uninstalling, undoing hardening, trusting content, clearing taint, or loosening
policy requires deliberate review of the specific weakening change. Cloaking is opt-in because
it introduces a reversible on-disk dictionary.

A server-held plan should bind operation, target, source digest, before-state digest, safe
diff summary, capability changes, required acknowledgements, expiry, and a one-use random ID.
Apply accepts the plan ID and required confirmation only; it cannot change the planned target.
Recheck source/config immediately before atomic commit, retain existing rollback semantics,
return conflict if either changed, and serialize mutations. Idempotency must prevent retry
from repeating an installation. No raw host config or backup contents should leave the server.

## Tests and evidence

Use temporary homes and synthetic host configurations; do not inspect real credentials to test
the platform. Relevant existing suites are `packages/cli/test/policy`, `test/attack`,
`test/install`, `test/live`, `test/sent`, and `test/commands`. `ProveDeps`, `VetDeps`, and
`HardenDeps` already support injected dependencies. The console's `scripts/*.test.mjs` cover
authentication, Host/Origin, traversal, bounded reports and redaction. Tests using fabricated
host data establish parser and transaction behavior only, never actual host enforcement.
