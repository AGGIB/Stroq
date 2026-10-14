# Cursor hook fixtures

Captured on macOS (darwin) on 2026-10-14 with real Cursor **0.46.11** in an authorized local throwaway project, verifying the editor Write/Delete preToolUse and afterFileEdit hook contract.

The committed files come from `scripts/capture-cursor-fixture.ts` and `scripts/clean-cursor-fixture.ts`. They record the exact events Cursor emits before and after editor operations, the host's reaction to allow and deny responses, and independent file sentinel outcomes.

| Capture           | Event / Tool        | Target path                 | Outcome and evidence                                                                                                    |
| ----------------- | ------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `allow.write`     | `preToolUse:Write`  | `src/sentinel-allow.ts`     | One allow pre-event audit entry; Cursor proceeds; sentinel file exists on disk with expected content.                   |
| `allow.post-edit` | `afterFileEdit`     | `src/sentinel-allow.ts`     | One `cursor-edit-observed` post audit entry; records completed edit observation without modifying decision.             |
| `deny.write`      | `preToolUse:Write`  | `.cursor/hooks.json`        | One `deny-self-tamper` audit entry; hook returns `permission: "deny"`; Cursor aborts write; file is unmodified on disk. |
| `allow.delete`    | `preToolUse:Delete` | `scratch/sentinel-temp.txt` | One allow pre-event audit entry; Cursor proceeds; target file is deleted from disk.                                     |
| `deny.delete`     | `preToolUse:Delete` | `.cursor/hooks.json`        | One `deny-self-tamper` audit entry; hook returns `permission: "deny"`; Cursor aborts delete; file remains intact.       |

Each capture includes the hook input payload (`*.event.json`), the independent sentinel evidence (`*.evidence.json`), and the audit log entries (`*.audit.jsonl`).

## What Cursor actually reports and how it behaves

Cursor hook execution sends JSON payloads over stdin to the command configured in `.cursor/hooks.json`.

1. **`preToolUse` on `Write` and `Delete`**:
   - Cursor provides `conversation_id`, `generation_id`, `hook_event_name: "preToolUse"`, `workspace_roots`, `cwd`, and `tool_name` (`Write` or `Delete`).
   - `tool_input` contains the target path under `file_path` (or camelCase aliases such as `relativeWorkspacePath` / `targetFile`). For `Write`, it also carries `content`.
   - **Allow response**: An empty stdout with exit code 0 is treated by Cursor as allow. The host proceeds with the disk write or deletion.
   - **Deny response**: When Stroq responds with `{ "permission": "deny", "user_message": "...", "agent_message": "..." }` and exit code 0, Cursor respects the refusal and aborts the editor tool execution. The target file is not created, modified, or deleted.
   - **Denied operations emit no `afterFileEdit`**: When an editor write is blocked by `preToolUse`, Cursor does not execute the edit and therefore never emits an `afterFileEdit` event.

2. **`afterFileEdit` observation**:
   - Following an allowed write, Cursor emits `afterFileEdit` with `file_path` and `edits` (`old_string`, `new_string`).
   - Stroq records this as a post-phase observation (`cursor-edit-observed`). It does not retroactively claim that the post hook blocked or permitted the edit.

## Bounded scope and limits

- **Measured scope**: Cursor 0.46.11 on macOS (`darwin`).
- **Events covered**: `preToolUse` (for `Write` and `Delete`) and `afterFileEdit`.
- **Not covered**:
  - Cursor Tab hooks (`beforeTabFileRead`, `afterTabFileEdit`) use separate editor integrations that Stroq does not install.
  - Multi-root workspaces: secrets and paths are indexed through `workspace_roots[0]`.
  - Cursor CLI (`cursor-agent`) and Windows live execution remain unmeasured in this fixture set.
  - A general live proof driver (`stroq prove --agent cursor`) is separate work; CI tests only replay checked-in sanitized fixtures offline.

## Cleaning and sanitization

Raw captures are cleaned by `scripts/clean-cursor-fixture.ts` according to the rules in `packages/cli/test/live/drivers/clean-fixture.ts`:

- The throwaway project directory becomes `/tmp/stroq-live-fixture/project`.
- Session IDs become numbered fixture UUIDs (`00000000-0000-4000-8000-000000000001`), and generation IDs become `gen-00000000-0000-4000-8000-000000000001`.
- Any user home directory becomes `/Users/fixture-user`.
- Test nonces become `stroq-live-0123456789abcdef` and fake secrets become `stroq_attack_0123456789abcdef01234567`.
- Cleaned fixtures are validated with `leaksIn()` to ensure no user identities, machine temp paths, AppData paths, or credentials leak into the repository.
- Automated tests run offline without network access or model requests.
