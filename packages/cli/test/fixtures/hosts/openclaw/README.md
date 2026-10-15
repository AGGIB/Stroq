# OpenClaw adapter replay fixtures

`2026.10.3-darwin-arm64/` contains a synthetic harness sequence from October 15,
2026, targeting the Stroq OpenClaw adapter. The version and platform are target
labels. These artifacts do not establish that a native OpenClaw Gateway loaded the
plugin, dispatched the tools, or enforced a returned block.

The ten records in `hooks.jsonl` contain plugin-normalized CLI inputs and Stroq CLI
JSON responses. The plugin constructs this payload from an event, its context, and
trusted plugin configuration before invoking `stroq hook openclaw pre|post`.
Original Gateway event/context pairs and the plugin's returned values are not
retained. The eight audit entries and seven filesystem snapshots support the
following replay checks:

| Harness request                               | Recorded CLI response     | Recorded result or disk state                            |
| --------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `exec` with `echo 'hello from openclaw'`      | `{ "decision": "allow" }` | post input contains greeting output                      |
| `write` to `scratch/write-me.txt`             | allow                     | snapshot contains requested text                         |
| `read` of `sample.txt`                        | allow                     | post result is scanned clean                             |
| `write` to `.claude/settings.json`            | deny-self-tamper          | snapshot retains original bytes; no matching post record |
| `delete` of `scratch/delete-me.txt`           | allow                     | snapshot shows the file absent                           |
| Final protected `write`, without a pre record | post observation only     | snapshot shows the requested tampered content            |

This establishes adapter response and audit parity, plus the recorded harness disk
transitions. It does not establish native host enforcement or native wire schemas.
The adapter classifies the harness's `delete` name as `mcp__openclaw__delete`; the
fixture does not establish that `delete` is a native OpenClaw tool.

## Payload and response boundary

The recorded CLI input includes `sessionId`, `agentId`, `runId`, `toolCallId`,
`toolKind`, `toolName`, `params`, and trusted top-level `cwd`; post inputs also carry
`result` and `durationMs`. These are the normalized fields present in this fixture,
not a complete native event schema. In the shipped plugin, `sessionId` comes from
context, and `cwd` comes from plugin configuration or its working directory.

The recorded pre stdout is CLI JSON: `{ "decision": "allow" }` or a deny with
`ruleId` and `reason`. The shipped plugin maps allow to `undefined` and deny to
`{ block: true, blockReason: "..." }`. Those plugin return values and the Gateway's
handling of them are outside this recording.

## Evidence limitations

- No snapshot contains plugin source or configuration bytes. The records cannot
  prove that only the pre gate was disabled or that the plugin was restored byte
  for byte.
- `after-restore` changes the protected sentinel back to its original content, but
  there is no corresponding write record. This is a harness reset, not proof that
  restoring the plugin resets user files. The capture helper's `restore` operation
  restores the plugin entry, not project files.
- The final control result says `Wrote 33 bytes`, whereas its content and the disk
  snapshot contain 32 UTF-8 bytes. Replay preserves this supplied result text
  without treating it as an accurate byte count.
- The supplied CLI build hash has no capture-time provenance retained in these
  files. Offline replay uses the current checkout, not that historical binary.

## Sanitization

Private paths use `/tmp/stroq-live-fixture` equivalents; session, run, and tool ids
use deterministic aliases. `manifest.json` provides SHA-256 checksums of all
fixture data files. The hook, audit, and snapshot bytes remain as supplied.

## Offline replay

`packages/cli/test/adapters/openclaw-measured-replay.test.ts` replays every supplied
input through `handleOpenClawHook`, verifies exact CLI response and audit parity,
and correlates the harness sequence with its disk snapshots. It launches neither
OpenClaw nor a model and makes no native host enforcement assertion.

## Preparing a future host capture

The opt-in helpers prepare an isolated marked throwaway project and record the
plugin-to-CLI boundary:

1. Build Stroq with `pnpm build`.
2. Prepare a new raw directory outside the repository:
   `node --import tsx/esm scripts/capture-openclaw-fixture.ts prepare <raw-dir> <path-to-openclaw-bin>`.
3. Independently configure a private Gateway to load the prepared plugin with the
   throwaway project as its trusted workspace. Preparing the directory alone does
   not start or verify a Gateway.
4. Record snapshots around allowed execution/write/read/delete calls and a denied
   write to the protected sentinel. Keep native event/context and host outcome
   evidence separately if claiming native dispatch or enforcement.
5. Record `before-control`, run `control <raw-dir>`, repeat the protected write,
   record `after-control`, run `restore <raw-dir>`, and record `after-restore` using
   the same helper. Retain plugin bytes before control and after restore to verify
   exact restoration. Project sentinel resets must be recorded separately.
6. Sanitize with
   `node --import tsx/esm scripts/clean-openclaw-fixture.ts <raw-dir> <fixture-dir>`.
   Cleaner output is an unreviewed candidate. Review provenance and scope before
   making any host claim; records and snapshots alone do not attest Gateway use.
