# Report queue and exact history

> **No screen of the console shows this any more.** The console has five screens (Check, Live, Agents, Rules, Skills & MCP: see `check.md`, `live-view.md`, `skills-mcp.md`). The service described here is still in `console/scripts/` with its tests and is not reached from any screen; it is to be removed.

The Protection queue reads existing inventory, incidents, agent configuration,
quarantine, MCP recovery, saved policy checks and credential reports. Opening it never starts a hook
check or credential scan. Attention items sort before ordinary history; evidence
and scope are disclosed within each row.

Credential rows retain older external-route, uncertain-destination and incomplete
reports even when a newer comparison is clean, narrower, failed or cancelled.
Counts belong to each report; they are not added across overlapping reports.
Recorded routes do not establish delivery, a live block or absence of exposure.

## Selection and retention

- Credential comparisons no longer have a screen: the card on Check says which keys left this
  machine, and `stroq sent` shows where each went. The server's job store for them (up to eight jobs
  in memory, no UI) is left over from the page that showed them and is not read by the console.
- Restarting the server clears the in-memory job history. Export a report to
  retain it. Canonical local links omit authentication and arbitrary search
  text; opening one still requires a connection to the original local server.
- The part **Undo: MCP changes** of Skills & MCP (`/skills/?part=registrations`) rechecks durable private recovery records. Reappeared registrations,
  changed recovery files and incomplete operations return to the queue; successful
  configuration changes are not counted as host protection. Project records from
  another workspace are not treated as current-workspace configuration findings.
  A configured strict proxy stays out of attention only when its recorded runtime
  matches; changed or unverified runtime links to the exact retained record.
  These records survive server restart; see [MCP recovery](mcp-containment.md)
  and [strict proxy configuration](mcp-protection.md).
- `/policies/checks/` reads durable expectations shared by every policy candidate using the same Stroq home, across workspaces. Each saved class combination has exact expected decisions for two session contexts. Its displayed current-policy results are recomputed by local class-only evaluation; they do not replay a command or establish host blocking. The stored source workspace identifies where the check was saved, not authenticated event attribution. Records survive restart without expiry or eviction, up to 64 checks; removal is explicit and weakens the regression gate.

Saved-check mismatches produce one attention row with check counts and the two contexts per check kept separate from bundled scenarios. A failed or foreign-workspace response produces one evidence gap, never zero passing checks. Matching results and a successfully read empty store are quiet. Candidate preview shows its own expected/actual mismatches; the Saved checks page evaluates the current policy, which may differ from that draft. See [the saved-check workflow](policy-workflow.md#saved-policy-checks).

## Updating evidence

The queue refreshes all report sources on mount, explicit refresh and a status
change of a check from Protection. While a known credential job is running,
it polls only the report sources that job can change. Three failed updates pause polling;
refresh reconnects. Partial refresh failures retain earlier inventory/investigation data with a visible
warning, while current configuration/recovery/saved-check snapshots are cleared. Job-only
poll failures keep earlier reports historical with a warning. Switching workspace immediately hides previous-workspace evidence and
aborts its reads.

The full refresh has a 45-second client bound for the existing bounded workers;
report polling has a 15-second bound and 1.5/3/4.5-second retry delay. The queue's
refresh timestamp describes the full report refresh, not a later inventory or
filesystem recheck.

Credential comparisons still require their local-access preview and acknowledgement. History navigation grants neither consent.
