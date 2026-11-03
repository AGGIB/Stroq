# Stroq console

The Stroq console is a private page on your own machine, with five screens. Start it with `npx @stroq/cli console [--workspace <dir>] [--port <n>]` and open the whole link it prints; from a source checkout, run `pnpm platform --workspace <dir>`. Diagnostics and policy checks run on the actual Stroq engine, and the console keeps configuration evidence, policy simulations and recorded decisions separate. It says what Stroq recorded and read; it does not say that a page blocks or secures anything it cannot show.

**Check** (`/`) is the card that `stroq` prints in a terminal, made by the same code: the console's engine runs `stroq card --json` over your Claude Code and Codex sessions (same cache, same `stroq show` file) and words it with the CLI's own `cardView`. Hoo, the owl, shows the result (alert, happy or idle; `pnpm owl:svg` writes the pictures from the same sprites the terminal draws). A moment opens in place with the evidence `stroq show N` prints. Under the card: one line for each agent, the fix line `npx @stroq/cli init`, the settings-check strip and the older installation, rule-file and scenario checks (Setup checks, read only when opened). **Check again** makes a new card; the last one stays on screen while it runs. Keys that left this machine and repositories that run code when an agent opens them are rows of the card (`/#keys`, `/#autorun`); to look inside a folder, run `stroq inspect <folder>`.

**Live** (`/live/`) is the audit journal as it happens: counts on top, and a feed with the filters all / denied / asked / flagged, a session, a day and a search over the rows on screen, all in the address. A row opens into its chain (what the agent read, what it did, the decision, the rule) with the recorded evidence of a finding, a comparison with the current policy (and the saved checks it can make), and `stroq why` and `stroq untaint` to copy. Counts and rows hold a coarse tool kind, action classes, a bundled rule id and a pseudonymous session; commands, paths and reasons stay in the journal.

**Agents** (`/agents/`) connects and removes Stroq's hooks (with a preview and a receipt), tests the hook, shows when Stroq was last asked and which of each agent's settings weaken it (the settings check, at `/agents/#settings`), and keeps the workspace / user switch.

**Rules** (`/policies/`) puts four things in one order: Try an action; the rules you can turn on, with a preview and a test before anything is written; History, where a recorded change can be undone; and the rules reference with a search (`?find=<rule id>`). The saved policy checks that gate a write are at `/policies/checks/` and are linked from the rules you can change.

**Skills & MCP** (`/skills/`) lists every skill and MCP server by agent: where it came from, what the rules matched in it, and what changed since you last looked. It is checked when the screen opens and when you press **Check again**; nothing watches it. A row opens the changes that can be made to it: route an MCP server through Stroq, pause or resume its calls, move a skill out of discovery, and mark a version reviewed, each as preview, apply and (under the part for it below the list) undo. Below the list are four parts, closed until asked for: undo for skills moved aside, undo for MCP changes with pause and resume, approval of MCP tool versions, and a check of a skill's text. Their deep links are `/skills/?part=quarantine|registrations|tools|check`.

The older addresses (Protection, Activity and its event page, Sessions, Overview, Investigations, Secret exposure, Settings check, Try an action, the history and reference pages of Policies, the Skills pages, Settings) lead to the screen that took their place; `scripts/console-redirects.mjs` is the list, and carries only a session, a filter, a rule or a record that the destination reads back through its own guard. The menu is these five screens and a theme switch.

## Run

From the published package, `npx @stroq/cli console` starts the console for the current folder. `--workspace /path/to/repo` selects another project and `--port <n>` another local port (the default is 47815).

From a source checkout, the console requires Node.js 22+ and pnpm. Run from this directory:

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm dev                 # http://127.0.0.1:47813 — shows "not connected"; real data needs the private link of pnpm serve:local
pnpm build               # local engine adapters + static export in out/
pnpm serve:local         # private loopback URL printed at startup
```

From the repository root, `pnpm platform:build` builds the core/CLI and platform; `pnpm platform --workspace /path/to/repo` starts it for a selected existing project. Install console dependencies separately with `pnpm --dir console install --ignore-workspace --frozen-lockfile` after the root frozen install. The selected workspace is named in the sidebar and setup previews.

Open the **full private URL** printed at startup. Its fragment token authenticates the browser without putting the token in HTTP request URLs. The browser removes the fragment and keeps the token in session storage. The console shows only what Stroq recorded on this machine; with no private link every screen says that nothing is connected and how to connect (`npx @stroq/cli console`). The source server can be configured with `STROQ_CONSOLE_PORT` and `STROQ_HOME`.

Build the core and CLI from the repository root (`pnpm build`) before starting local checks. The server verifies that the built CLI version matches the package version. `pnpm serve:local` uses this repository as its workspace by default. Every screen operates on the local engine. The home screen is Check.

## What works

- Check, Live, Agents, Rules and Skills & MCP as above; state of a view (filters, selection, the part of a screen) survives reload in the address.
- [Recorded installation diagnostics](../docs/platform/installation-diagnostics.md) retain typed reasons and scope and distinguish absent agents from configured peers.
- [Isolated hook checks](../docs/platform/hook-checks.md): from an agent's row, preview a source-bound check, run two fixed events without an agent or provider request, and see the last record in the row.
- Hook setup for Claude Code, Cursor and Codex (Windsurf is not offered: it became Devin, which reads other files): choose workspace or user scope, review a fixed-target preview, add missing exact templates and preserve unmanaged entries.
- Guarded hook removal: preview exact current-runtime hooks in the selected source, preserve other registrations, acknowledge weaker protection and full-copy retention, then inspect the receipt.
- The settings check reads the settings files of Claude Code, Codex, Cursor and Windsurf and lists the settings that switch off or loosen an agent's own checks. It shows the setting, never its value.
- Skills from fixed Claude, shared agents, Codex, Cursor, Windsurf and Devin folders, plus supported JSON MCP configurations: source coverage, digest-bound rule matches, file fingerprints, static capabilities and an explicit reviewed baseline.
- Reversible skill quarantine for complete isolated direct or nested skill folders in all six fixed project and user sources; reversible MCP registration removal for the supported sources; exact-entry **Route through Stroq** with the strict stdio proxy; [MCP launch-policy continuity](../docs/platform/mcp-policy-continuity.md); [MCP governance](../docs/platform/mcp-governance.md); [MCP call control](../docs/platform/mcp-call-control.md) and [MCP tool contracts](../docs/platform/mcp-tool-contracts.md).
- Active policy settings: deny selected action categories, strengthen unmatched-action behavior, lower the detection threshold and promote approval rules to deny. Preview validates and replays the candidate against the current policy and saved checks.
- Recorded policy changes: inspect retained intent and backup metadata, test a prior version against the current policy and saved checks, then explicitly restore exact bytes or select the current bundled default.
- Saved policy checks: capture an exact recorded class combination's current clean and suspect decisions, recheck them locally and gate every policy candidate that uses the same Stroq home.
- Recorded evidence for a finding: finite historical classes, origin matches and gaps, task-scope kind and scan and trust evidence ([recorded evidence](../docs/platform/recorded-evidence.md)).
- Global search (⌘K / Ctrl+K), accessible dialogs and keyboard navigation; dark, light and system themes; mobile navigation; reduced motion.

## Local data and limits

Offline-check history is private, unencrypted and bounded to 32 runs / 8 MiB, without automatic expiry. All five check kinds share exclusive workspace ownership and verified durable publication. Parent reports retain typed diagnostics, finite results, fixed saved action classes, case IDs/revision and exact capture references rather than raw commands, policy YAML or subprocess output. Workspace captures retain their separate existing bounds; an unavailable selected run never silently opens a newer capture. See [scope and cancellation](../docs/platform/protection-check.md) and [queue boundaries](../docs/platform/engine-capabilities.md#offline-control-service).

`/api/snapshot` projects a bounded tail of `~/.stroq/audit.jsonl`, supported `last-hook` stamps, and historical `live` proofs. It reads no credential files or cloak dictionaries, returns no raw commands or tool content, and hashes session identifiers. Host attribution is not present in the audit schema and is shown as unknown. A policy deny is not proof that a host stopped an action. Historical verification is not presented as current protection.

Operations the console does not support keep their terminal commands. Team accounts and remote fleets are outside this local console.

**Save regression check** preserves the comparison's exact current decisions for both session-taint assumptions. The server reselects the immutable evidence and derives the classes/effects; the browser supplies neither. `/policies/checks/` and its refresh perform only local class evaluation. These expectations are shared by all candidates using this Stroq home, independently of workspace selection. Preview/apply bind the check-store revision, and any mismatched expectation blocks apply even when the bundled scenarios pass. Current-policy results and candidate results remain separate; neither establishes host adoption, live blocking or remediation.

Saved checks persist privately in `<STROQ_HOME>/console/policy-cases.json`, retaining fixed classes, expected effects, timestamps and source fingerprints without raw commands, content or credentials. They survive restart with no automatic expiry or eviction, up to 64 checks. Explicit removal acknowledges the weaker gate and shared scope. Identical expectations preserve their first source; conflicting expectations for the same class set require removal first. Unavailable storage is not an empty passing result. See [retention and security limits](../SECURITY.md#local-data-retention).

Hook setup currently requires macOS/Linux and the default user Stroq directory. Runtime paths must remain available after installation. Setup previews hold private candidates in memory for five minutes, bounded to eight plans / 8 MiB, and expose only the projected change summary. Changes retain complete prior configuration and advisory-record bytes under `~/.stroq/backups/console-setup/`, which may include credentials or unrelated settings, with no automatic expiry or eviction. Missing consent does not consume a preview. Already-current configuration writes no files or lock and does not adopt an installation record. See [connection and recovery](../docs/platform/agent-setup.md). Policy previews expire after ten minutes. Policy changes affect new hook invocations; MCP engines require restart, with current-runtime dispatch held by the continuity control above. Content review uses bundled rules with threshold 0.6, independently of the runtime policy setting.

Hook removal also requires POSIX and the default user Stroq home. Its five-minute, single-use previews remove only exact current-runtime registrations in one fixed source. Complete original settings and recovery metadata remain unencrypted under `<selected-user-home>/.stroq/backups/console-disconnect/`, with private permissions, no automatic expiry and a 32-record limit. User/home-alias scope needs separate consent. The writer shares the harden lock with native filters. Hook removal has not been tested against a real host. See [hook removal](../docs/platform/agent-disconnect.md).

The server binds only `127.0.0.1`, requires a Bearer token for every API, rejects foreign Host/Origin/Fetch-Site headers, and refuses static path traversal and symlinks. `POST /api/runs` accepts five fixed diagnostic/content-scan actions; setup, policy, comparison and review routes have closed typed request shapes. Every action requires a same-origin bounded JSON request and accepts no executable, path or environment arguments. Diagnostic jobs run serially with deadlines, output caps and a separate scanner worker. The latest 32 derived runs persist privately under `<STROQ_HOME>/console/runs-<workspace-sha256>.json` using a workspace-bound version 2 envelope; legacy unscoped `runs.json` remains untouched and is not imported as current evidence. Jobs carry fingerprints of workspace identity, policy source bytes and runtime, observed before and after execution. Missing or changed bindings keep results historical. Current work-queue configuration comes from `/api/agents`, separately from doctor diagnostics. Opening another console or reading history never declares a retained worker stopped. Unowned unfinished checks remain state-unverified; only a new explicit admission under verified exclusive ownership can mark an earlier attempt interrupted. No check resumes on read. All five kinds require verified history publication before work and completion; storage failures remain visible, refuse new work and never overwrite malformed history. Raw CLI output and submitted text are not retained.

Reviewed inventory baselines are workspace-specific and contain only projected metadata and fingerprints. A review records a revision; it does not grant engine trust, pin a server or enable protection. Atomic writes recheck the previewed file identities and exact bytes. As with the CLI's existing hardening transactions, portable check/rename cannot provide an OS-level compare-and-swap against malicious processes running as the same user.

MCP configuration actions keep complete original and edited configuration files under `<selected-user-home>/.stroq/console/mcp-containment/`, including any embedded credentials and unrelated entries. This fixed user location is independent of a custom `STROQ_HOME`. New v2 records use `changed.json`; legacy v1 removals retain `removed.json` without migration. Retention is unencrypted, private (`0700` directories / `0600` files), capped at 32 records and 17 MiB, and has no automatic expiry or deletion after restore. Explicit preview acknowledgements precede a write. Windsurf/Devin and Windows mutation remain unsupported; rejected custom MCP config locations remain source-specific gaps. See [MCP containment](../docs/platform/mcp-containment.md).

The server serves a self-only Content Security Policy. Next's static bootstrap and styles currently require `unsafe-inline`; a nonce-based server is a separate hardening step. The token authenticates the browser against remote web origins, not against malicious processes running as the same OS user. A content scan with no detections does not certify a safe skill; a completed policy replay does not prove live blocking.

## Checks

```sh
pnpm typecheck
pnpm test                # filtering, command safety, snapshot validation
pnpm test:local          # real engine, HTTP journey, transactions, privacy and failure recovery
pnpm build
```

The fonts are bundled locally; their licence files are in `public/fonts`. Claude and Codex logos are the vendors' own app assets; Cursor and Windsurf logos are unmodified light/dark SVGs from their official brand kits. `public/brands/SOURCES.txt` records where each asset came from. The interface uses Radix primitives and Lucide icons.
