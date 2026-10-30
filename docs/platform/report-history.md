# Report queue and exact history

The Protection queue reads existing inventory, incidents, agent configuration,
quarantine, MCP recovery, native file filters, saved policy checks, live checks and credential reports. Opening it never starts a host
check or credential scan. Attention items sort before ordinary history; evidence
and scope are disclosed within each row.

Live rows keep the selected agent, compare retained attempts with newer stored
proof, and keep a running attempt visible. A passing isolated check does not
establish enforcement by the installed workspace configuration. An unchecked host
version means unknown freshness, not proof that the host changed.

Credential rows retain older external-route, uncertain-destination and incomplete
reports even when a newer comparison is clean, narrower, failed or cancelled.
Counts belong to each report; they are not added across overlapping reports.
Recorded routes do not establish delivery, a live block or absence of exposure.

## Selection and retention

- `/agents/checks/` lists up to **24 attempts in server memory**. An exact attempt
  link includes `workspace=workspace-<24 hex>` and `job=<UUID>`. Missing, invalid,
  ambiguous and foreign-workspace requests do not substitute another attempt.
- The separate **Stored proof** list shows the latest retained proof for each
  agent. Its `agent=` selector opens the latest stored slot, not an immutable
  attempt snapshot. The current host version is not rechecked by this read.
- `/keys/` selects a credential report through the same workspace-bound `job=`
  contract. The server retains up to **eight jobs in memory**. Without an explicit
  selection the newest job is chosen and the URL is made canonical; an explicit
  missing selection never falls back to it.
- Restarting the server clears both in-memory job histories. Export a report to
  retain it. Canonical local links omit authentication and arbitrary search
  text; opening one still requires a connection to the original local server.
- `/skills/mcp/` rechecks durable private recovery records. Reappeared registrations,
  changed recovery files and incomplete operations return to the queue; successful
  configuration changes are not counted as host protection. Project records from
  another workspace are not treated as current-workspace configuration findings.
  A configured strict proxy stays out of attention only when its recorded runtime
  matches; changed or unverified runtime links to the exact retained record.
  These records survive server restart; see [MCP recovery](mcp-containment.md)
  and [strict proxy configuration](mcp-protection.md).
- `/policies/checks/` reads durable expectations shared by every policy candidate using the same Stroq home, across workspaces. Each saved class combination has exact expected decisions for two session contexts. Its displayed current-policy results are recomputed by local class-only evaluation; they do not replay a command or establish host blocking. The stored source workspace identifies where the check was saved, not authenticated event attribution. Records survive restart without expiry or eviction, up to 64 checks; removal is explicit and weakens the regression gate.

Saved-check mismatches produce one attention row with check counts and the two contexts per check kept separate from bundled scenarios. A failed or foreign-workspace response produces one evidence gap, never zero passing checks. Matching results and a successfully read empty store are quiet. Candidate preview shows its own expected/actual mismatches; the Saved checks page evaluates the current policy, which may differ from that draft. See [the saved-check workflow](policy-workflow.md#saved-policy-checks).

Native file-filter rows stay quiet for optional missing rules and clean explicit rules, including user-owned settings. Known retained applications with an incomplete fixed rule set produce **recorded filter setup incomplete**. The manifest records intent before replacing the source, so this does not prove a previously completed install or later removal. Unreadable sources and unknown ownership/history are verification gaps; placeholder zero counts are not missing-rule evidence. These rows do not claim credential exposure or live blocking.

A filter link uses `/agents/?workspace=workspace-<24 hex>&filter=<fixed target>#<agent>` and derives Workspace/User scope from that fixed target. Malformed, duplicate, scope-ambiguous and foreign-workspace selections are refused. Plain scope navigation uses `/agents/?scope=user` without retaining an earlier target. Opening a valid link selects read-only review; a new preview and explicit consent are still required to change settings.

## Updating evidence

The queue refreshes all report sources on mount, explicit refresh and a live-job
status change from Protection. While a known live or credential job is running,
it polls only those two report sources. Three failed updates pause polling;
refresh reconnects. Partial refresh failures retain earlier inventory/investigation data with a visible
warning, while current configuration/recovery/filter/saved-check snapshots are cleared. Job-only
poll failures keep earlier reports historical with a warning. Switching workspace immediately hides previous-workspace evidence and
aborts its reads.

The full refresh has a 45-second client bound for the existing bounded workers;
report polling has a 15-second bound and 1.5/3/4.5-second retry delay. The queue's
refresh timestamp describes the full report refresh, not a later inventory or
filesystem recheck. Completing a check also rereads the separate stored proof.

New live checks still require their explicit preview, capped provider budget and
subscription consent. Credential comparisons still require their local-access
preview and acknowledgement. History navigation grants neither consent.
