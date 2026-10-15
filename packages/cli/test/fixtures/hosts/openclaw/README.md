# OpenClaw plugin adapter fixtures

`2026.10.3-darwin-arm64/` contains an independently reviewed real host capture from
October 15, 2026. Real OpenClaw 2026.10.3 plugin tool call events were executed
in an authorized marked throwaway project on macOS (`darwin-arm64`). The recorder
forwarded OpenClaw's original event payload to the built Stroq CLI. It recorded real hook
invocations across `before_tool_call` and `after_tool_call` phases; the fresh live audit
contains eight entries. Seven disk snapshots establish the following outcomes:

| Request                                                  | Recorded hook response               | Independent disk outcome          |
| -------------------------------------------------------- | ------------------------------------ | --------------------------------- |
| Shell greeting `echo 'hello from openclaw'` via `exec`   | explicit allow (exit 0, empty block) | greeting printed to stdout        |
| Write `scratch/write-me.txt` via `write`                 | explicit allow                       | file created with requested text  |
| Read `sample.txt` via `read`                             | explicit allow                       | content read and scanned on post  |
| Overwrite sentinel `.claude/settings.json` via `write`   | deny-self-tamper                     | original bytes retained           |
| Delete `scratch/delete-me.txt` via `delete`              | explicit allow                       | file removed                      |
| Control overwrite of sentinel, before_tool_call bypassed | postToolUse observation; no pre gate | content changed to tampered state |

The control run disabled only `before_tool_call`; the original enforcing hook configuration
was then restored byte for byte. This provides direct empirical evidence for OpenClaw
2026.10.3 plugin hook execution on `darwin-arm64`.

## Observations and Contract

1. **Wire payload format**: The Stroq OpenClaw plugin receives `before_tool_call` and `after_tool_call` events:
   - `sessionId`: string (session or agent key)
   - `agentId`: string
   - `runId`: string
   - `toolCallId`: string
   - `toolKind`: string (`shell`, `write`, `read`, `delete`, etc.)
   - `toolName`: native tool identifier (`exec`, `write`, `read`, `delete`, etc.)
   - `params`: tool parameters (`{ command }` for `exec`, `{ path, content }` for `write`, `{ path }` for `read`/`delete`)
   - `cwd`: absolute workspace directory
   - On `after_tool_call`: includes `result`, `error`, `durationMs`.
2. **Allow response**: `before_tool_call` handler returns `undefined`. OpenClaw proceeds with tool execution.
3. **Deny response**: `before_tool_call` handler returns `{ block: true, blockReason: "<reason>" }`. OpenClaw halts tool execution and presents the block reason to the user.
4. **Plugin configuration**: OpenClaw 2026.10.3 loads plugins via `openclaw.json` or `openclaw plugins install --link <dir>`. In `package.json`, `openclaw.extensions` requires string entry paths (`["./index.js"]`).

## Sanitization

Sanitization replaces exact private paths with `/tmp/stroq-live-fixture` equivalents,
anonymizes session UUIDs, and replaces operator user identities with `fixture-user`.
`manifest.json` provides sha256 checksums of all sanitized fixture files. Raw captures
remain outside Git.

## Replay Test

`packages/cli/test/adapters/openclaw-measured-replay.test.ts` replays recorded inputs
through `handleOpenClawHook` and verifies exact agreement with recorded outputs and decisions
without launching OpenClaw or making model requests.

## Explicit Capture Procedure

To reproduce or record a new OpenClaw fixture:

1. Build Stroq: `pnpm build`.
2. Prepare a capture environment:
   `node --import tsx/esm scripts/capture-openclaw-fixture.ts prepare <raw-dir-outside-repo> <path-to-openclaw-bin>`
3. Record initial snapshot:
   `node --import tsx/esm scripts/capture-openclaw-fixture.ts snapshot <raw-dir> before-validated`
4. Run tool call sequences through the installed Stroq plugin:
   - Allowed shell: `exec` running `echo 'hello from openclaw'`
   - Allowed write: `write` creating `scratch/write-me.txt`
   - Allowed read: `read` reading `sample.txt`
   - Denied self-tamper: `write` targeting `.claude/settings.json`
   - Allowed delete: `delete` removing `scratch/delete-me.txt`
5. Record step snapshots (`after-allow-write`, `after-deny`, etc.).
6. Test control run:
   - `node --import tsx/esm scripts/capture-openclaw-fixture.ts control <raw-dir>`
   - Re-run self-tamper write (it should succeed)
   - `node --import tsx/esm scripts/capture-openclaw-fixture.ts snapshot <raw-dir> after-control`
   - `node --import tsx/esm scripts/capture-openclaw-fixture.ts restore <raw-dir>`
   - `node --import tsx/esm scripts/capture-openclaw-fixture.ts snapshot <raw-dir> after-restore`
7. Clean and sanitize into target fixture directory:
   `node --import tsx/esm scripts/clean-openclaw-fixture.ts <raw-dir> packages/cli/test/fixtures/hosts/openclaw/<version>-<platform>`
