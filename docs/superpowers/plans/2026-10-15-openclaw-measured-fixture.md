# Implementation Plan: Measured OpenClaw Plugin Contract Fixtures

Record empirical `before_tool_call` and `after_tool_call` wire contract fixtures for OpenClaw 2026.10.3 on macOS (`darwin-arm64`) to resolve Issue #230.

## User Review Required

> [!IMPORTANT]
> The measured capture uses an installed local OpenClaw 2026.10.3 release under Node 24 on `darwin-arm64` in an isolated throwaway workspace. All recorded sessions, timestamps, UUIDs, machine paths, and usernames are sanitized before committing.

## Proposed Changes

### OpenClaw Plugin Compatibility Fix
- Fix `packages/cli/openclaw-plugin/package.json` `openclaw.extensions` schema from `[{ "entry": "index.js" }]` to `["./index.js"]`, matching OpenClaw 2026's plugin loader contract.

### Capture and Cleaner Helpers
- Create `scripts/openclaw-capture-recorder.ts` generating the intermediary hook recorder shim forwarding stdin to `stroq hook openclaw <phase>`.
- Create `scripts/capture-openclaw-fixture.ts` setting up isolated throwaway workspaces, snapshots, and mock tool dispatcher.
- Create `scripts/clean-openclaw-fixture.ts` sanitizing paths to `/tmp/stroq-live-fixture`, anonymizing IDs, and generating `manifest.json` with SHA-256 digests.

### Live Host Capture
- Record hook contract interactions on `darwin-arm64`:
  1. Allowed shell execution (`exec`)
  2. Allowed file write (`write`)
  3. Allowed file read (`read`) with postToolUse result scan
  4. Blocked security self-tampering attempt (`write` targeting `.claude/settings.json`)
  5. Allowed file delete (`delete`)
  6. Control run with `before_tool_call` disabled demonstrating unmitigated write success.
- Record 7 disk snapshots establishing filesystem state before and after each step.

### Documentation
- Create `packages/cli/test/fixtures/hosts/openclaw/README.md` detailing release version, platform, observed payloads, and control outcomes.
- Update `docs/AGENTS.md` and `docs/GUIDE.md` confirming measured status for OpenClaw.

### Conformance Replay Test
- Add `packages/cli/test/adapters/openclaw-measured-replay.test.ts` replaying every measured hook input through `handleOpenClawHook` and asserting exact parity with recorded responses and audit entries.

## Verification Plan
- Run `pnpm vitest run packages/cli/test/adapters/openclaw-measured-replay.test.ts`.
- Run `pnpm format:check`.
- Verify clean working tree and exactly 5 atomic commits for PR.
