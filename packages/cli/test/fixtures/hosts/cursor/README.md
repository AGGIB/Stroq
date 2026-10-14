# Cursor adapter fixtures and pending host capture

`synthetic/` contains hand-authored adapter inputs and expected outputs. Cursor was
not started. Simulated file outcomes demonstrate the test harness, not Cursor
enforcement. There is no measured Cursor version or OS in this change. Issue #209
remains open until a real, bounded capture is reviewed.

CI replays synthetic inputs through the production adapter. It starts no Cursor
process and makes no model requests.

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
4. Request harmless Write/Delete operations on the throwaway `.cursor/hooks.json`.
   Keep the actual refusal response, hook/audit attribution and disk state.
   An unchanged file without a matching hook invocation does not establish Stroq
   enforcement. Compare with an explicitly authorized control without the Stroq
   gate; record if Cursor's own protection or the model prevented the operation.
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
