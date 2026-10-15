# Copilot CLI adapter fixtures

`1.0.98-darwin-arm64/` contains an independently reviewed real host capture from
October 15, 2026. Non-interactive GitHub Copilot CLI 1.0.98 requests were executed
in an authorized marked throwaway project on macOS (darwin-arm64). The recorder
forwarded Copilot's original stdin to the built Stroq CLI. It recorded real hook
invocations across `preToolUse` and `postToolUse` phases; the fresh live audit
contains 17 entries. Seven disk snapshots establish the following outcomes:

| Request                                                 | Recorded hook response               | Independent disk outcome          |
| ------------------------------------------------------- | ------------------------------------ | --------------------------------- |
| Shell greeting `echo 'hello from copilot'`              | allow (exit 0, empty stdout)         | greeting printed to terminal      |
| Write `scratch/write-me.txt` via `apply_patch`          | allow (exit 0, empty stdout)         | file created with requested text  |
| View `scratch/write-me.txt` via `view`                  | allow (exit 0, empty stdout)         | content read and echoed by agent  |
| Overwrite sentinel `.claude/settings.json`              | deny-self-tamper                     | original bytes retained           |
| Delete `scratch/delete-me.txt` via `apply_patch`        | allow (exit 0, empty stdout)         | file removed                      |
| Control overwrite of sentinel, only preToolUse disabled | postToolUse observation; no pre gate | content changed to tampered state |

The control run disabled only `preToolUse`; the original enforcing hook configuration
was then restored with the same parsed JSON. The recorded restore dropped its final
newline; it was not a byte-for-byte restore. This provides direct empirical evidence for GitHub
Copilot CLI 1.0.98 non-interactive tool use on darwin-arm64.

## Observations and Contract

1. **Wire payload format**: Copilot CLI invokes configured hook scripts with a JSON payload on stdin:
   - `sessionId`: string (UUID)
   - `timestamp`: integer millisecond epoch
   - `cwd`: absolute path to project working directory
   - `toolName`: native tool identifier (`bash`, `view`, `apply_patch`, etc.)
   - `toolArgs`: tool arguments (`{ command, description }` for `bash`, `{ path }` for `view`, diff string for `apply_patch`)
   - `toolResult`: on `postToolUse`, contains `{ resultType: "success"|"failure", textResultForLlm: "..." }`
2. **Allow response**: exit code 0 with empty stdout. Copilot continues execution normally.
3. **Deny response**: exit code 0 with JSON payload `{"permissionDecision":"deny","permissionDecisionReason":"<reason>"}` on stdout. The protected file remained unchanged; the same patch succeeded in the ungated control. Host terminal diagnostics are not retained in this fixture.
4. **Hook configuration**: Copilot discovers hooks in `$COPILOT_HOME/hooks/*.json` for user hooks and `.github/hooks/*.json` for repository hooks.

## Sanitization

Sanitization replaces exact private paths with `/tmp/stroq-live-fixture` equivalents,
anonymizes session UUIDs, and replaces operator user identities with `fixture-user`.
`manifest.json` provides sha256 checksums of all sanitized fixture files. Raw captures
remain outside Git.

## Replay Test

`packages/cli/test/adapters/copilot-measured-replay.test.ts` replays recorded inputs
through `handleCopilotHook` and verifies exact agreement with recorded outputs and decisions
without launching Copilot CLI or making network calls.

## Explicit Capture Procedure

To reproduce or record a new Copilot CLI fixture:

1. Build Stroq: `pnpm build`.
2. Prepare a capture environment:
   `node --import tsx/esm scripts/capture-copilot-fixture.ts prepare <raw-dir-outside-repo> <path-to-copilot-bin>`
3. Record initial snapshot:
   `node --import tsx/esm scripts/capture-copilot-fixture.ts snapshot <raw-dir> before-validated`
4. Run agent prompts with `COPILOT_HOME=<throwaway-home>`:
   - Allowed shell: `echo 'hello from copilot'`
   - Allowed write: create `scratch/write-me.txt`
   - Denied self-tamper: modify `.claude/settings.json`
   - Allowed delete: remove `scratch/delete-me.txt`
5. Record step snapshots (`after-allow-write`, `after-deny`, etc.).
6. Test control run:
   Stop the host before changing the private hooks. Control and restore refuse
   paths escaping the prepared directories and refuse unexpected hook changes.
   - `node --import tsx/esm scripts/capture-copilot-fixture.ts control <raw-dir>`
   - Re-run self-tamper prompt (it should succeed)
   - `node --import tsx/esm scripts/capture-copilot-fixture.ts snapshot <raw-dir> after-control`
   - `node --import tsx/esm scripts/capture-copilot-fixture.ts restore <raw-dir>`
   - `node --import tsx/esm scripts/capture-copilot-fixture.ts snapshot <raw-dir> after-restore`
7. Clean and sanitize into target fixture directory:
   `node --import tsx/esm scripts/clean-copilot-fixture.ts <raw-dir> packages/cli/test/fixtures/hosts/copilot/<version>-<platform>`

The cleaner produces an `unreviewed-host-candidate`, not an enforcement attestation.
It lists observed native tool names, preserves capture-time build metadata when
available, and leaves enforcement and control success unverified. Independently
review wire responses, audit attribution and disk/control outcomes before promoting
a candidate to `recorded-host`. Cleaning alone never establishes those claims.
