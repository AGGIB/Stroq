# Exact activity handoff and recorded evidence

An Activity event can open the authoritative investigation for the same exact journal line. The investigation explains the finite evidence that was recorded, independently of its current-policy comparison, current session state and operator assessment. No source text or model-generated explanation is needed.

## One investigation for a local finding

The existing bounded Activity snapshot adds an optional `evidenceSha`, calculated from the exact raw UTF-8 line without its LF delimiter. Whitespace and CRLF differences are preserved in the digest. A binding is exposed only when the original journal hash fields have the supported shape. This is a content binding, not authenticated evidence or hash-chain verification.

New Activity event links retain `id=audit-N` and add `evidence=SHA`. The event view refuses a malformed, ambiguous or mismatching digest; it never falls back to a replacement event with the same sequence. The existing sequence-only URLs remain usable as explicitly unbound current-window views. Snapshots without the optional digest remain readable.

For a digest-bound local deny, approval requirement or suspect content observation, **Open investigation** in the page heading links to `status=all` and the exact `incident-SHA`. This also reaches an already Reviewed finding. Missing or rotated evidence remains unavailable rather than opening another finding. Allows have no incident handoff. Opening Activity adds no new scan or mutation. Local events do not show the illustrative Event trace or Next steps; the demo keeps its illustrative workflow.

Local Activity no longer writes or reads its old browser-only Reviewed state, and local event export schema `stroq-activity-event-export/2` omits `reviewed`. Old source/sequence localStorage values are not migrated into durable review: they were not bound to a source version. Demo retains its separate synthetic browser review. Actual review and assessment remain in Investigations.

## Recorded evidence

Opening one selected finding performs one read-only `POST /api/incidents/evidence`, with only `{id, expectedEvidenceSha}`. There is no per-table-row request, automatic polling, retry, CLI command or model inference. An explicit refresh reads that same binding again. Authentication, exact origin, closed scalar grammar, decoded duplicate rejection, 4096-byte body and selector-free URL gates apply.

The service reselects the exact finding from the existing **1-MiB journal tail / 500-finding window**, then parses its raw line with duplicate-aware JSON, a **512-KiB line**, **32-depth** and **65,536-node** bound. Unsupported raw grammar refuses the explanation. A normal append can retain the original selection; changed bytes, missing history or loss from the bounded window cannot be matched by sequence.

`stroq-incident-recorded-evidence/1` contains the exact ID/digest/sequence/time/kind binding, capture time, recorded deny/ask effect or content-scan kind, and a bounded journal-window description. Its fields are:

| Field          | Projection                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Action classes | The 20 supported finite classes, deduplicated in canonical order                               |
| Task scope     | One of the seven recorded scope kinds, with private rule/fingerprint fields withheld           |
| Origin matches | Counts by six finite atom kinds, including recorded suspect-match counts                       |
| Origin gaps    | Counts by the same atom kinds, separate from known matches                                     |
| Content scan   | Recorded score and a true/false/not-recorded trust exemption; malformed scan stays unavailable |

Each collection inspects at most **128 elements** and reports unsupported or excess elements as omitted. No missing field becomes a recorded zero. Missing, unavailable, partial and a valid empty list have separate states; malformed task evidence is unavailable. Closed public validation checks canonical order, count consistency, exact binding and the fixed limitations before the result can reach the interface or export.

Commands, content, tool names, source/excerpt text, arbitrary rule IDs/reasons, paths, raw session/call/task IDs and secret labels stay private. Origin counts describe recorded matches, not unique sources, proof of causation or why a model chose an action. A scanner score is not attack probability. Task labels establish neither a valid/current permit nor native enforcement. Historical taint, historical policy revision and host outcome are not reconstructed from current state.

The compact panel shows classes and useful recorded counts; the detailed projection and limits are disclosed on demand. Current-policy simulation and current-session inspection keep their own labels and actions. Export schema `stroq-investigation-export/4` includes only the currently accepted recorded-evidence report, or null. Assessment history remains its separately scoped projection.

## Lifecycle and retention

The endpoint is observational and creates no store. It never edits the journal, review, assessments, policy, trust, session taint, native settings or permits. Selection and connection generations invalidate accepted evidence immediately; close, unmount and a 25-second timeout abort the read and fence late responses. A failed refresh clears the accepted export report. Retained server annotations and current read results remain independent.

Local records remain unauthenticated claims unless independently checked; this endpoint does not verify the hash chain, native adoption, blocking, remediation or hostile-same-user isolation.
