# Secret scan window — design spec (2026-09-08)

**Goal.** Close the padding bypass of the secret egress guard for every adapter: today `candidateTokens` looks at only the first 256 KiB of a tool input, so an agent can exfiltrate a known secret through an allowed egress action by placing 256 KiB of padding before it. After this change the guard scans the whole input in windows up to a hard bound, and an egress-shaped action whose input exceeds that bound is denied by policy as unscannable instead of being forwarded half-scanned.

**Found by.** The MCP proxy whole-branch review (2026-09-08), probe `probe-pad-e2e.ts`: a `tools/call` with 300 KiB of padding before a `.env` value was forwarded, allowed. The proxy shipped a local guard (`mcp-proxy-arguments-too-large`, 256 KiB); the hook adapters (Claude Code, Cursor, Codex, Copilot CLI, Windsurf, OpenClaw) still have the bypass for `Bash`, `WebFetch` and every `mcp__*` call. Recorded in memory as the top-priority core debt.

## 1. Where the clip lives

| Item | Today |
| --- | --- |
| `packages/core/src/secrets/candidates.ts` | `textOf(toolName, toolInput)` picks the text (`Bash` → `command`; `WebFetch` → `url` + `prompt`; `mcp__*` → `JSON.stringify(toolInput)`; anything else → `''`); `candidateTokens` slices it at `MAX_INPUT_CHARS = 262_144` and tokenises; `MAX_CANDIDATES = 200_000` is a memory guard (~0.19 candidates/char at the densest measured padding, so ~50k per 256 KiB). |
| `packages/core/src/engine.ts` | `findSecrets` runs only when a class in `EGRESS_CLASSES` (`shell.network`, `network.fetch`, `mcp.call`, `mcp.side_effect`, `git.push_external`, `shell.exec_encoded`) is present; a hit adds the class `secret.egress`; the policy decides (`deny-secret-egress`, `taint: any`). |
| Policy | Two copies of the default policy: `policies/default.yaml` and `packages/core/src/policy/default-policy.ts`; classes enumerated in `packages/core/src/types.ts` (`ActionClass` union + list, 13 today). |
| Cost (measured 2026-09-08, this machine) | One 256 KiB window: ~32 ms for the densest padding, ~19 ms for prose; 8 windows (2 MiB): ~260 ms dense; hashing ≤ 50k candidates per window in `lookup` adds up to a few hundred ms in the worst case. Hook budgets: 15 s (Claude Code, Cursor, Codex, Windsurf installs), 30 s fail-open (Copilot), 10 s (OpenClaw plugin default). |
| Proxy | `packages/cli/src/mcp/judge.ts` refuses a `tools/call` whose serialised record exceeds `MAX_INPUT_CHARS` (`mcp-proxy-arguments-too-large`) — the only place the bypass is closed today. |

## 2. Design

### 2a. Core: scan in windows, bound the total (`packages/core/src/secrets/candidates.ts`)

- `MAX_INPUT_CHARS` (262 144) keeps its name and value but becomes the **window** size. New `MAX_SCAN_CHARS = 2 * 1024 * 1024` (2 MiB, 8 windows) is the total bound, and `SCAN_OVERLAP = 4_096` the overlap between consecutive windows, so a value that straddles a window boundary is still seen whole (no real secret is longer than 4 KiB; `MIN_SECRET_LENGTH` is far below it).
- `candidateTokens(toolName, toolInput)` keeps its signature and return type. It now tokenises every window of `textOf(...)` up to `MAX_SCAN_CHARS` — window `i` covers `[i·MAX_INPUT_CHARS − SCAN_OVERLAP, (i+1)·MAX_INPUT_CHARS)` clamped to the text — dedupes across windows (the same `token\nraw` key), keeps `MAX_CANDIDATES` as the overall memory guard, and, when the text is longer than `MAX_SCAN_CHARS`, scans exactly the first `MAX_SCAN_CHARS` and ignores the rest (the engine denies the action anyway, see 2b, so nothing past the bound is ever forwarded on trust).
- New `export function exceedsSecretScan(toolName, toolInput): boolean` — true when `textOf(...).length > MAX_SCAN_CHARS`. Same `textOf` as the tokeniser, so the two can never disagree about what counts.
- Cost stays bounded: ≤ 8 windows, ≤ ~300 ms tokenisation for the densest padding plus the lookup's hashing; an input above the bound costs one `length` check plus the first 2 MiB.

### 2b. Engine and policy: an unscannable egress is denied (`packages/core/src/engine.ts`, `types.ts`, both default policies)

- New action class `secret.unscannable` (the 14th; `ActionClass` union and `ACTION_CLASSES` list in `types.ts`, and the policy schema's class list if it enumerates them). It is added by `pre` when the action is egress-shaped (a class in `EGRESS_CLASSES`) AND `exceedsSecretScan(event.toolName, event.toolInput)`; `findSecrets` still runs on the scanned prefix, so `secret.egress` can appear alongside it when the padding failed to push the value past the bound.
- Default policy (both copies, byte-for-byte equivalent) gains, right after `deny-secret-egress`: `id: deny-secret-unscannable`, `effect: deny`, `reason: Arguments are larger than the secret scan window (2 MiB), so Stroq cannot check them for secret values; outbound use is blocked`, `when: { classes: [secret.unscannable], taint: any }`.
- Every adapter renders a policy deny already (Claude Code/Cursor/Codex/Copilot/Windsurf/OpenClaw all print `Stroq blocked this action (<rule>): <reason>`), so **no adapter changes**. The audit line carries the class and the rule id like any other decision; the summary stays redacted.
- A custom `~/.stroq/policy.yaml` that lacks the new rule would allow an unscannable egress (policy is `default: allow`). That is the same contract every other default rule has, and the acceptance test is `stroq attack` (2c): a weakened policy fails CI.

### 2c. `stroq attack` scenario 13 (`packages/cli/src/attack/scenarios/`)

- `13-padded-secret-exfil`: the shape of the 2026-09-08 review probe — a session whose throwaway `.env` holds a fake value, then an `mcp__github__create_issue` call (or `Bash` `curl -d`) whose arguments carry 2 MiB + 1 of filler before that value. Expected: `blocked` by `deny-secret-unscannable`. Source line: this spec and the review (no public incident; state that it models the padding bypass class). The suite header becomes `13 recorded incidents`, the README/site counts and the badge (`stroq attack: 13/13 stopped`) follow, the expected tally `9 blocked, 4 asked, 0 passed through`.
- The existing secret-egress scenarios keep passing: a value inside the first window still hits `deny-secret-egress`.

### 2d. Proxy alignment (`packages/cli/src/mcp/judge.ts`)

- `mcp-proxy-arguments-too-large` keeps refusing before the engine, but at `MAX_SCAN_CHARS` (imported) instead of `MAX_INPUT_CHARS`, with the reason naming 2 MiB; it remains defence-in-depth (the engine would deny the same call through 2b; the proxy's refusal is cheaper and keeps the audit summary free of a 2 MiB serialisation). Tests and the docs' 256 KiB figures move to 2 MiB; the boundary tests move to `MAX_SCAN_CHARS` / `+1`.

### 2e. Docs

- README: the limits under `### MCP proxy` (2 MiB instead of 256 KiB, and the statement that the secret guard now scans the whole input up to 2 MiB in windows), the Policy section's class list (14 classes, `secret.unscannable` described), the attack table (13 rows, `9 blocked`), the badge; `packages/cli/README.md` the same where it repeats them; SECURITY.md scope (the padding bypass is closed for every adapter; an unscannable egress is denied); CHANGELOG under `[Unreleased]` (Changed/Fixed: the scan window, the new class and rule, the proxy threshold); the MCP proxy spec §3 numbers; `docs/site` policy figure if it lists classes (regenerate by hand if so).

## 3. Limits to state

- The bound is 2 MiB of scanned text per egress action; above it the action is denied, not partially scanned. Legitimate inline payloads above 2 MiB (an MCP `write_file` of a huge file, a shell command embedding a huge here-doc) are refused; the workaround is a file path instead of inline content.
- `WebFetch` still scans `url` and `prompt` only (headers etc. are a separate, pre-existing limit).
- The post-scan of tool RESULTS keeps its own 200 000-character clip (`scanner.ts` `DEFAULT_MAX_CHARS`) — a different concern (a poisoned result padded past it is not scanned beyond the clip); unchanged here and documented already for the proxy's 8 MiB line rule.
- Index building keeps `MAX_TEXT_CHARS` (256 KiB per credential file); unchanged.

## 4. Out of scope

Windowed scanning of post results, header scanning for `WebFetch`, the per-adapter timeouts, any change to what `textOf` reads per tool.

## 5. Test strategy

Core: `candidates.test.ts` — a value at 256 KiB + 1, at 1 MiB, straddling a window boundary (last 10 chars of window 1 + first 10 of window 2), at exactly `MAX_SCAN_CHARS` − length (found) and just past the bound (not found, and `exceedsSecretScan` true); dedupe across windows; `MAX_CANDIDATES` still bounds; timing test: 2 MiB of the densest padding tokenises under 2 s. Engine tests: an egress action with a 2 MiB + 1 input → classes contain `secret.unscannable`, decision `deny-secret-unscannable`, audit summary redacted; a non-egress action (`Write`) with the same input → no class, allowed; an egress input with the secret at 1 MiB → `deny-secret-egress`. Policy: both default copies load and are equal; the schema accepts the class. Attack: scenario 13 blocked; the suite's expected tally updated; a policy without the rule makes `stroq attack` exit 1. Proxy: the too-large tests moved to 2 MiB; a 1 MiB call with a secret at 900 KiB is `deny-secret-egress` through the real engine (proves the window scan end-to-end). Demos unaffected (small inputs).
