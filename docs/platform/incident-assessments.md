# Local operator assessments

An investigation can retain an operator's assessment and finite reason for one exact recorded finding. **Reviewed** remains an independent acknowledgement. An assessment does not change the journal, policy, trust, session taint, learned provenance, permits, native settings or host outcome. A marked issue is an operator judgement, not proof of an attack; accepting risk does not remediate it.

## Workflow

1. Open a recorded finding in **Investigations**, then **Assess finding**.
2. Choose an assessment and a compatible reason. **Save assessment** internally obtains a short-lived preview and applies it once.
3. **Assessment history** retains earlier decisions and reasons. To reassess, change the selection or explicitly reopen the finding.
4. If completion is uncertain, **Recheck save · Journal #n** checks that exact candidate. Saving again stays unavailable until explicit matching recheck resolves it. No action is replayed.

| Assessment            | Permitted reasons                                                |
| --------------------- | ---------------------------------------------------------------- |
| Marked false positive | Incorrect match; benign content                                  |
| Risk accepted         | Needed for this workflow; controlled test; compensating controls |
| Marked as issue       | Unintended action; suspicious content; sensitive-data risk       |
| Reopened              | New evidence; reassess this finding                              |

There is no free-text note field. A controlled test is accepted risk rather than a false positive. The same latest assessment/reason pair cannot be appended again. Reopening requires an earlier non-reopened assessment. The current Reopened option stays visibly selected and disabled until the operator chooses another outcome.

Protection considers all findings in its bounded captured journal window, including Reviewed findings. Unassessed, reopened, marked-issue and uncertain-save findings remain in attention. An exact false-positive or accepted-risk assessment removes only that finding's assessment follow-up; independent evidence and coverage rows remain. Its Investigate link prioritizes an uncertain save, then a marked issue, then a reopened finding, then the newest unassessed finding. Missing or malformed history produces an explicit evidence gap, not an inferred assessment. Full history stays readable and contributes a capacity row.

## Binding and scope

The scope is the **selected Stroq home's local journal across workspaces**. Historical workspace attribution and an authenticated individual actor are unavailable. Each record binds the finding ID, SHA-256 of its exact raw journal line, sequence, recorded timestamp and kind, plus the previous assessment ID for that exact finding. A later same-session event inherits nothing. Append order defines the chain; records are not sorted into authority by timestamps.

The server reselects the exact evidence and physical source. A normal journal append is compatible while the selected line and captured identity remain unchanged. Same-byte source replacement refuses an old preview. Rechecking an already retained assessment does not require the journal still to exist. This establishes the annotation's presence, not the current existence or authenticity of its source evidence.

Recorded source timestamps are claims and may be slightly ahead of local time under existing journal validation. Assessment timestamps must be nondecreasing and not later than the generated state; a backwards local clock refuses an append.

## Durable storage and concurrency

The fixed private file is `<STROQ_HOME>/console/incident-assessments/history.json`. Directories are 0700 and files 0600, with owner, regular-file, link, no-follow and physical-identity checks. A strict closed JSON envelope rejects duplicate keys and broken chains. The retained bound is **512 records / 512 KiB**, with at most **32 opaque stages** and **1 MiB** physical storage including publication reserve. Reads never create, lock, repair, adopt or remove storage. There is no automatic expiry, eviction or migration; reaching the bound refuses new writes while preserving readable history.

Explicit apply obtains the shared local lease and compares the whole-store revision, physical store/source identities, latest chain and exact evidence. Publication synchronizes the temporary file, performs a guarded rename, synchronizes the directory and independently reads the result back. A failure after possible publication is **write-unconfirmed**, not an assertion of rollback. Two consoles cannot append using the same captured revision after one has advanced it. Filesystem checks are not a hostile-same-user isolation boundary or a power-loss proof.

At most eight server-owned previews live for 120 seconds. Recognized apply consumes its preview even when extra fields make the request invalid. An expired, stale or already used preview is not retried automatically.

## HTTP and browser boundaries

- `GET /api/incident-assessments` returns one bounded, validated summary. It performs no write and avoids one request per table row.
- `POST .../preview` accepts only finding ID, expected evidence SHA, expected latest assessment ID, assessment and reason.
- `POST .../apply` accepts only the preview ID.
- `POST .../recheck` accepts only candidate record ID and expected evidence SHA.

Existing authentication, same-origin, method, body-size, decoded-duplicate and closed-field gates apply. Browser requests supply no file path, raw event, actor, executable or note. Error codes are finite; arbitrary message text cannot authorize a retry or release uncertainty.

The page owns one assessment summary. Selection/connection generations ignore late and unmounted responses. A transport-bound in-memory list retains at most eight unresolved writes across component remounts and client navigation; ordinary summary refresh cannot acknowledge them. This is not persistence of browser uncertainty across a hard reload or browser restart. The durable server history is independent. Only a complete, matching explicit recheck releases the matching pending candidate. A not-present receipt describes that observation, not a guarantee that no delayed write can ever appear.

Individual export schema `/3` and list export `/2` include an `operatorAssessments` projection (`stroq-operator-assessments-export/1`). It contains only history bound to selected exact findings and sanitized pending candidates. The single-use preview capability and raw/private source fields are excluded. Uncertainty and incomplete projection remain explicit.

## Verification and limits

Assessments have been tested only as local annotations, without a model, a native agent or a real user's files. That verifies the annotations and their workflow, not Claude or editor interception, native adoption, attack efficacy or remediation. Native enforcement has not been measured.
