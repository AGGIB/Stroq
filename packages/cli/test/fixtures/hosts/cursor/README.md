# Cursor adapter fixtures

`synthetic/` contains hand-authored adapter inputs and expected outputs. Cursor was
not started. Simulated file outcomes demonstrate the test harness, not Cursor
enforcement. Its measured version, OS and date remain null.

`3.24.18-win32/` contains an independently reviewed real desktop capture from
October 14, 2026. The operator manually submitted three bounded Agent requests
(model reported as `grok-4.6`) in a marked throwaway project. The recorder forwarded
Cursor's original stdin, including its UTF-8 BOM, to the built Stroq CLI. It
recorded ten hook invocations and their actual responses; the fresh live audit
contains fourteen entries. Six disk snapshots establish the following outcomes:

| Request                                                      | Recorded hook response                 | Independent disk outcome             |
| ------------------------------------------------------------ | -------------------------------------- | ------------------------------------ |
| Write `scratch/write-me.txt`                                 | explicit allow                         | file created with requested text     |
| Delete `scratch/delete-me.txt`                               | explicit allow                         | file removed                         |
| Write harmless `.claude/settings.json` sentinel              | deny-self-tamper                       | original bytes retained              |
| Delete the same sentinel                                     | deny-self-tamper                       | original bytes retained              |
| Control Write to the same sentinel, only preToolUse disabled | afterFileEdit observation; no pre gate | content changed to control-succeeded |

The control retained all observation hooks; the original enforcing hook config
was then restored byte for byte. No independent ungated Delete control was run.
Two actual `afterFileEdit` events cover the allowed scratch Write and the control
Write. Four incidental `beforeReadFile` events are retained. This is evidence for
one desktop release on Windows, not Tab, CLI, other OS/releases, shell/MCP live
enforcement or multi-root coverage.

The capture exposed two adapter problems: a silent allow was rejected by Cursor's
`failClosed` gate, and Windows workspace roots use `/C:/...` alongside native
`C:\...` file paths. The adapter now emits an explicit allow for blocking hooks
and normalizes the Windows workspace root. Recorder startup/BOM failures occurred
before these successful measurements; their diagnostics remain with the private
raw evidence, not in the measured fixture.

Sanitization replaces exact private paths, email and IDs while retaining path
forms and cross-file session relationships. `inputHadBom` preserves BOM metadata;
JSON whitespace is normalized. Audit hashes are the original recorded values:
redaction invalidates their chain, so these are attribution fixtures, not a
cryptographic audit-chain proof. `manifest.json` hashes the reviewed sanitized
files. Raw captures remain outside Git.

CI replays both fixture sets through the production adapter and compares measured
responses, paths, decisions and audit attribution. It checks recorded disk
outcomes without manufacturing host writes. It starts no Cursor process and makes
no model requests.

## Explicit real capture procedure

Use an installed Cursor release and an authorized throwaway project. Review model
usage/cost before starting editor requests. Never use an owner's project or real
credential files as sentinels.

1. Build Stroq, then run `pnpm exec tsx scripts/capture-cursor-fixture.ts prepare <new-raw-directory-outside-repo> <Cursor-executable>`.
   The executable's `--version` supplies metadata. For Windows `Cursor.exe`, the
   script uses the Electron CLI entry from `resources/app/out/cli.js`, as the
   installed `cursor.cmd` does. This only prepares hooks; it
   does not launch Cursor or claim a successful measurement.
2. Open the printed throwaway project in that exact Cursor installation. Run
   `pnpm exec tsx scripts/capture-cursor-fixture.ts snapshot <raw-directory> before`.
3. In Cursor, request a write to `scratch/write-me.txt` and a deletion of
   `scratch/delete-me.txt`. Keep the real `preToolUse` and `afterFileEdit` inputs
   received by the installed recorder. Missing events remain a coverage gap.
4. Request harmless Write/Delete operations on the prepared throwaway
   `.claude/settings.json` sentinel (never the owner's settings).
   Keep the actual refusal response, hook/audit attribution and disk state.
   An unchanged file without a matching hook invocation does not establish Stroq
   enforcement. Take an `after-deny` snapshot. For an explicitly authorized
   control, run `pnpm exec tsx scripts/capture-cursor-fixture.ts control <raw-directory>`.
   This disables only the private recorder's `preToolUse` gate and retains the
   other hooks. Snapshot `before-control`, request a Write to the same sentinel,
   then snapshot `after-control`. Restore immediately with
   `pnpm exec tsx scripts/capture-cursor-fixture.ts restore <raw-directory>` and
   snapshot `after-restore`. The helper refuses unmarked projects, unexpected
   gates or intervening changes to the control config. Record if Cursor's own
   protection or the model prevented the control operation.
5. Take an `after` snapshot with the same command. Preserve separate snapshots
   after each operation when needed to correlate individual outcomes. Copy the
   throwaway Stroq audit log alongside the raw records for independent review.
6. Run `pnpm exec tsx scripts/clean-cursor-fixture.ts <raw-directory> <new-candidate-directory>`.
   The cleaner requires actual hook records and disk snapshots, rejects common raw
   credentials/private paths, and labels output `unverified-host-capture`.
7. Review event/path relationships, response attribution, allow/deny/control file
   outcomes and cleaned bytes before committing a versioned measured fixture.
   Only then update agent coverage documentation for that exact version/OS/events.

Keep raw captures outside Git. Remove the throwaway directory only after checking
its marker and resolved path; preserve evidence needed for review first.
