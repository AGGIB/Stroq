# Tested policy recovery

**Policies → Change history** closes the recovery path after changing a protection rule. Select a recorded change, inspect and test its retained prior policy, then explicitly restore it. Opening history or refreshing never prepares or applies a change.

## What a recorded change establishes

Existing console writes retain a private intent record before replacing `policy.yaml`. Its timestamp, before/after byte hashes and semantic fingerprint describe the intended change. They are not proof that the write completed or that a running host adopted it. The interface therefore uses **Recorded changes**, not an application-success ledger.

For a retained file, recovery requires the exact bounded backup bytes to match the record's prior hash. Restoration preserves those bytes, including comments, BOM and line endings. It keeps the current file's permissions; older records did not retain historical permissions. A newly created policy uses private permissions. No metadata rollback is claimed.

When a record says the prior policy file was absent, the selectable target is explicitly **Current bundled default**. This removes the override after confirmation and uses the default from the currently bound runtime. It does not reconstruct or claim the historical default from an older Stroq installation. The current file is backed up before removal, so its retained bytes can be restored again.

## Review before restoring

The fixed worker parses and validates the current and candidate policies, compares both through the real bundled attack and ordinary-work corpus, and evaluates the candidate against the current saved policy checks. Invalid input, unknown fields, aliases, unavailable evidence, failed saved checks, allowed attack fixtures, unmet expectations or unjudged scenarios prevent restoration. Repair of an invalid current policy is outside this workflow; it cannot silently become a comparison against the default.

The comparison shows current/candidate detection thresholds, default effects and rule counts, including threshold-only changes that do not change class decisions. It also lists changed decisions for individual known action classes under clean and suspect taint assumptions. These are class-only comparisons; they are not complete tool invocations, all class combinations or observed host behavior. Saved checks retain their separate exact class combinations. Raw YAML, custom rule names, reasons and policy paths are not returned to the browser.

The owner explicitly acknowledges reduced protection, the shared Stroq-home scope and private unencrypted recovery copies. New ordinary-work interruptions require their own acknowledgement. A passing bundled corpus is not proof that every desired restriction is preserved. A saved-check conflict stays blocked until the owner separately changes that check; restore never deletes checks automatically.

## Exact change and readback

The transient preview binds the selected intent and backup, exact current file, current runtime, candidate byte and semantic hashes, saved-check revision and expiry. Apply reselects server-owned files and repeats those checks under the existing saved-case and policy-write locks. A same-byte file substitution, permission change, modified record, runtime change or changed saved check requires a fresh preview.

Before publication, the writer retains the current source and a new private intent record. It checks the staged file before publishing and verifies the resulting exact bytes and actual semantic fingerprint. Removing an override uses a versioned intent whose after-byte hash is null. Legacy intent records remain readable without rewriting them.

If a write may have happened but the final result cannot be verified, the response is **unconfirmed**. The client requires an explicit successful current-state read before another change. It never automatically retries or rolls back an uncertain restore. Portable Node filesystem operations still leave a narrow check-to-rename or check-to-unlink window against uncooperative external writers; these checks are not OS compare-and-swap.

New hook invocations resolve the policy anew. Existing tasks keep their launch policy, and running MCP proxies need a restart. A restored file and passing tests establish local configuration and simulation evidence; they do not establish native-client blocking, process termination or remediation of an incident.

## Fixed local API

All routes require the existing local bearer-token and same-origin boundary. The browser cannot submit a path, YAML, executable, command or environment.

- `GET /api/policy/history` reads current policy metadata and bounded intent/recovery metadata.
- `POST /api/policy/restore/preview` accepts only `entryId`, `recordSha256` and `expectedRawSha`.
- `POST /api/policy/restore/apply` binds the preview, entry, record, current raw hash and candidate fingerprint, plus the explicit acknowledgements.

History exposes at most 32 records, examines at most 256 directory names and reads at most 8 MiB. Individual policies are capped at 256 KiB and intents at 4 KiB. Partial, limited and unavailable history remain distinct from an empty readable history. Source data is not silently pruned. Previews are private, transient and invalidated by restart, with at most eight plans, an 8 MiB combined budget and two-minute expiry. Restore uses the existing worker memory and deadline limits. No project command, provider request, native trust setting, agent launch or signing key is involved.
