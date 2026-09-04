# Stroq killer-feature research (2026-09-04)

**Question.** Stroq 0.1.0 works (scan → taint → policy → audit) but has no single capability that makes a developer install it *today*. What should that be?

**Answer.** Ship **Provenance**: every high-impact action Stroq gates comes with proof of *where the instruction came from* ("this `npx` command was copied from the Sentry MCP result you read 40 s ago"), and every outbound call is checked for *which secret is leaving* ("the request body contains the value of `aws_secret_access_key` from `~/.aws/credentials`"). Deterministic, local, explainable, and — per four independent research tracks — **shipped by nobody** for coding agents: not by Anthropic, Cursor, OpenAI, GitHub, Microsoft AGT, Snyk, Pipelock, or any of the 40+ tools surveyed. The third piece, `stroq attack`, replays real 2026 incidents through the user's own policy and prints a shareable score; it is the launch vehicle.

Sections 1–4 are evidence, 5 is the decision, 6 the MVP spec, 7 what we deliberately do not build.

---

## 1. Method

Four parallel research tracks on 2026-09-04, ~300 searches and ~300 primary-source page reads (advisories, vendor docs, GitHub API, arXiv, HN/Reddit/forums), plus a read-through of Stroq's own engine for feasibility. Claims marked *unverified* by the researchers were dropped or flagged. Key facts below were re-checked against primary sources by hand (Claude Code docs, Rehberger's post, Tenet's post, GitHub API star counts).

## 2. Demand: what developers actually complain about

Ranked by breadth × acuteness (May–Sep 2026 evidence; links in the appendix).

1. **Destructive host actions** — `rm -rf` of a home directory (1,500+ upvotes on Reddit, HN 197 pts), `drizzle-kit push --force` wiping a production DB (claude-code #27063, closed "not planned"), Cursor agents wiping C:/D: drives (four forum incidents Apr–Aug 2026), PocketOS `volumeDelete` on prod + backups. Native coverage: Claude Code hard-blocks only `rm -rf /`-class critical paths; nothing native covers `--force` migrations, SQL, or cloud-API deletes.
2. **Permission fatigue → YOLO** — Anthropic's own numbers: users approve 97% of prompts, humans catch 13.6% of dangerous commands vs the auto-mode classifier's 89%. Feature requests with 206/176/125 👍 for deterministic allowlists; "I block destructive actions with hooks, other than that yolo." OpenClaw flipped host-exec to YOLO by default after an approval revolt.
3. **Auto mode is opaque, non-deterministic, and bypassable** — default since 2026-08-14; Rehberger (2026-08-26) achieved 60–80% injection success against Opus 5 auto mode; Anthropic: "a convenience feature backed by a best-effort classifier, not a security guarantee." The docs state the classifier **never sees tool results** ("Tool results are stripped") and explicitly accept a PostToolUse hook's `classifierContext` as application-provided context — i.e. the taint signal Stroq produces is an input Anthropic left for hooks to supply.
4. **Indirect injection through tool output / repo content** — jqwik protestware printing "delete all tests" to stdout (May 2026), Sentry "agentjacking" via MCP (85% success, 100+ executions, 2,388 orgs exposed; Sentry declined to fix), Comment-and-Control (PR titles → `ps auxeww` → secrets posted to the PR, bypassing Copilot's three runtime layers).
5. **Secrets read, echoed, exfiltrated** — claude-code #32733 (191 👍), #44868 (`grep` leaked a token despite CLAUDE.md rules and a hook with gaps), `.env` copied into `~/.claude/file-history`.
6. **Hooks are fragile and fail open** — #81458: 11 guard hooks failed 6,865 times silently; Cursor honours only `deny`, empty response = allow; Codex hooks stop after updates.
7. Sandboxes are opt-in and leaky (Pillar's "week of sandbox escapes", Wiz GhostApproval); project config as attack vector (Check Point CVE-2025-59536, CVE-2026-33068); malicious skills (ToxicSkills 36.8% flawed, SkillCloak beats static scanners >90%); no trustworthy after-the-fact record ("Claude doesn't remember what it did").

**What people build themselves (stars, 2026-09-04):** destructive-command regex guards — `Dicklesworthstone/destructive_command_guard` 5,912★ (created Jan 2026, 13 agents), `kenryu42/cc-safety-net` 1,523★ (14 agents); sandboxes — Anthropic `sandbox-runtime` 5,138★, `fence` 949★; network gateway — Deno `clawpatrol` 1,034★; egress proxy — `pipelock` 833★. All are **content-blind**: they judge the command string, not what the agent read. dcg's own README: "the model can still write scripts to disk to bypass hook-based blocking."

## 3. Incidents: which mechanism would have stopped them

25 incidents/CVEs (Mar 2025 – Sep 2026) were scored against nine defensive mechanisms. Counts of incidents each mechanism stops:

| Mechanism | Stops | Shipped today by |
| --- | --- | --- |
| (b) session taint + high-impact action policy | ~17 | **Stroq**; Pipelock (proxy mode), Zenity (SaaS, behavioural), FIDES (Microsoft Agent Framework, not coding agents) |
| (f) protect the agent's own config/hooks/rc files | ~11 | Claude Code protected paths + `ConfigChange`, Kiro, Codex, two OSS hook repos, **Stroq** (`config.self`) |
| (d) outbound **secret-value** check on tool arguments | ~9 | nobody at the hook boundary (Pipelock: 65 shape regexes on proxy traffic; Claude Code: `mask` only for pre-configured creds inside the sandbox) |
| (g) egress allowlist | ~6 | Claude Code / Cursor / Codex sandboxes (opt-in), clawpatrol, fence |
| (e) MCP tool pinning / drift | 4 | mcp-context-protector (223★), agentsh, MCP Manager (hosted) |
| (c) **instruction provenance** (proposed action copied from earlier untrusted output) | 3 (always paired with b) | **nobody** — papers only (ARGUS, ProvenanceGuard, AuthGraph, CaMeL) |
| (a) content scan of tool output | 2 alone | Anthropic server-side probe (flags, many FPs), Lasso hooks (warn-only, dormant), **Stroq** |
| (i) skill pre-install scan | 1 | Snyk agent-scan 3,007★, Cisco skill-scanner 2,496★, Socket, Semgrep |

Two conclusions. First, every incident that mattered ended in an **action** (shell exec, config write, a tool call carrying secrets); content filtering alone is provably bypassable (controlled-release prompting, SkillCloak, adaptive attacks >85% against 18 defences). Second, the incidents that no shipped tool stops — Sentry agentjacking (`npx <attacker-pkg>` copied from an MCP result), Comment-and-Control (secret values posted into a PR), RoguePilot (token inside a `$schema` URL), s1ngularity (secrets enumerated then pushed) — are exactly the ones caught by *origin* (c) and *effect* (d) checks rather than by command patterns.

## 4. Competitors: the gaps

Four tracks (OSS hook/firewall tools, OSS scanners/sandboxes, commercial vendors, native agent features) produced a 60-product matrix. The cells that matter:

- **Instruction provenance:** zero products. Closest: Zenity's "post-ingestion anomaly detection" (SaaS, behavioural, undisclosed), agentsh's 30-second `read_then_send` rule for MCP only, Pipelock's "taint context" envelope. Certiv (pre-seed) markets "lineage from prompt to executed command" as roadmap.
- **Taint after suspicious tool output:** Pipelock (only in MCP-proxy mode; its Claude Code hook is PreToolUse-only), tiny repos (CyVisGuard 55★, Aigis 54★). Snyk Agent Guard does tool-output injection scanning — as a cloud round-trip per tool event that **fails open** on network error, in "open preview".
- **Secret-value egress check at the hook:** nobody. Native agents strip `KEY/SECRET/TOKEN` env vars (Codex) or mask pre-configured credentials (Claude Code sandbox); none compares outgoing tool arguments against the secrets on disk.
- **Tamper-evident local audit:** agentsh (optional HMAC chain), Pipelock (Ed25519 receipts), Rampart (82★), APort (hosted, $499/mo). Every native agent: "no local audit log" (Claude Code), metadata-only (OpenClaw), admin events only (Cursor).
- **Deterministic taint at all:** no native agent changes its permission state after reading untrusted content. Claude Code's classifier is model-based and blind to tool results; Codex's Guardian is model-based and sees them; Cursor's auto-review is "best-effort guardrails rather than a hard security boundary."
- **Money and momentum:** HiddenLayer $100M (Agent Harness Security, Aug 3), Zenity $125M, AIR Security $50M seed out of stealth Sep 1 ("The Context Firewall for AI Agents" — filters inputs into context; the most direct conceptual overlap with Stroq's scanning), Lasso $30M, Straiker $64M. All SaaS, all with a network round-trip in or beside the hot path. Traction pattern among OSS leaders: **one-sentence deterministic promise + a GIF + many agents**.

## 5. Decision

**Killer feature: Provenance.** Stroq becomes the tool that answers, deterministically and locally, "why is the agent about to do this?"

1. **Instruction provenance.** PostToolUse records *actionable atoms* from everything the agent reads (URLs/hosts, package specs like `npx X` / `pip install X`, pipe-to-shell commands, encoded blobs, absolute paths outside the repo) with their source. PreToolUse checks whether the proposed action contains any of them. A hit escalates the decision and attaches the evidence: *"`npx @tenet-…-diagnose` appeared in the `mcp__sentry__get_issue` result (40 s ago). Tool results are data, not instructions."* Sources already scan-`suspect` → deny; otherwise → ask. This catches injections whose wording no rule matches (Sentry: 85% success against every agent) and makes today's session-wide taint precise instead of blunt.
2. **Secret egress guard.** A salted-hash index of secret *values* found in the usual locations (`.env*`, `~/.aws`, `~/.ssh`, `~/.npmrc`, `~/.netrc`, kube/gcloud configs — the path list Stroq already classifies) plus optional planted canaries. Any outbound tool argument (Bash command incl. heredocs, WebFetch URL, MCP arguments, Write outside the repo) containing one of those values is denied, naming the variable and file, never the value. Exact-match ⇒ near-zero false positives; catches the *effect* of an undetected injection. The feasibility review rated this High (all building blocks exist: `SECRET_PATTERNS`, token-shape extraction in the audit redactor, 0600 storage, locking).
3. **`stroq attack`.** Deterministic replay of recorded hook sequences modelled on real 2026 incidents (Sentry agentjacking, Comment-and-Control, jqwik protestware, s1ngularity, RoguePilot, ContextCrush, Opus 5 auto-mode chain, ClawHavoc skills…) through the engine with the user's actual policy; output a table and a score. The engine already accepts injectable rules/policy/stores, so this is 3–5 days and doubles as our regression suite. Shareable output is the marketing loop (Lighthouse for agent security).

Why this and not the alternatives:

| Candidate | Value | Unique? | Feasibility | Verdict |
| --- | --- | --- | --- | --- |
| Provenance (A) | high: explains every block, catches zero-day phrasing, feeds `classifierContext` | **yes, nobody** | medium (5–7 d + tuning) | **build** |
| Secret egress guard (B) | high: stops 9/25 incidents by effect | yes at hook level | high (6–8 d) | **build** |
| `stroq attack` (C) | high for GTM, medium for security | partial (AGT has offline `red-team scan`) | high (3–5 d) | **build** |
| Forensic report (E) | medium | partial | high (3–4 d) | after C |
| Taint-aware destructive gate | high demand but crowded (dcg 5.9k★, cc-safety-net 1.5k★) | no | high | table stakes, not headline |
| MCP lockfile (D) | medium | partial (mcp-context-protector) | low (hooks expose no descriptions; needs daemon) | later |
| ML classifier / daemon | medium | no (Anthropic probe, PG2, Sentinel, AIR) | medium | not now |

**Positioning line:** *"Stroq is the local firewall that knows where your agent's instructions came from — and where your secrets are going."* Tagline for the README stays; this becomes the first bullet and the first GIF.

## 6. MVP specification

### 6.1 Provenance

- **Store.** `~/.stroq/sessions/<id>.prov.jsonl` (0600, separate from the taint blob so a parse failure cannot break taint). Entry: `{seq, ts, tool, source, atomHash, atomKind, excerpt}`; `excerpt` ≤ 120 chars, passed through the existing `redact()`. Bounded to the last 2,000 atoms / 1 MB per session, oldest dropped.
- **Atoms (PostToolUse).** After `normalizeText`/`expandVariants`: URLs and bare hosts; package specs (`npx|pnpm dlx|uvx|pipx run <name>`, `npm i|pip install|cargo install <name>` with a *named* third-party package — bare `npm install` is not an atom); pipe-to-shell and `sh -c` segments; base64/hex blobs ≥ 24 chars; absolute paths outside the repo; `git remote`/`push` targets. Deliberately **not** plain build commands (`pnpm test`, `make`) — those are copied from READMEs constantly and are not high-impact.
- **Match (PreToolUse).** Extract the same atoms from `tool_input` (Bash `command` via `splitSegments`; WebFetch `url`; MCP arguments as JSON strings; Write `content` when the path is outside the repo) and look up hashes. Latency: hashing a few dozen atoms, well under 5 ms on top of today's process start.
- **Decision.** New policy dimension `origin: untrusted` usable in rules. Default policy additions, above the existing rules: `deny` any high-impact class with `origin: untrusted` when the source's scan verdict was `suspect`; `ask` any high-impact class with `origin: untrusted` otherwise; `ask` a Bash/MCP call with no class whose *package-spec* or *pipe-to-shell* atom is untrusted (this is the Sentry case). Reason string carries source, age, excerpt; the same text goes to `classifierContext` on the PostToolUse that produced the atom ("contains 3 instruction-like atoms: …") so Claude Code's auto mode finally sees the taint.
- **User loop.** `stroq why <audit-seq>` prints the chain; `stroq trust <path|host|server>` marks a source trusted for the project (stored in `.stroq/trust.yaml`, itself a `config.self` file). Audit entries gain a `provenance` field.
- **Known limits (state them in the README).** Provenance is text-level: an agent that *reads* a poisoned page and then *writes its own* command is not caught by (c) — that is what taint (b) and the secret guard (d) are for. Paraphrased commands are out of scope for v1.

### 6.2 Secret egress guard

- **Index.** Built lazily at first high-impact PreToolUse, cached by file mtime under `~/.stroq/secrets.idx` (0600): `sha256(salt ‖ value)` for every value extracted from the secret-location list using the token-shape families already in the audit redactor (long tokens, vendor prefixes, PEM bodies). Salt is per-install, random, never transmitted. Values shorter than 12 chars are ignored (FP guard).
- **Check.** For `shell.network`, `network.fetch`, `mcp.side_effect`, `git.push_external`, and Writes outside the repo: hash every token-shaped substring of the arguments and compare. Match ⇒ `deny` with reason "argument contains the value of `<KEY_NAME>` from `<file>`". Never log the value; the audit line stores the key name and file only.
- **Canary (opt-in).** `stroq canary add` plants a fake credential in a decoy file the user chooses; a match is a certain-positive and additionally raises the session to `suspect`.
- **Privacy note for the README.** Stroq reads secret files it already knows the paths of, stores salted hashes only, entirely offline; the code is open.

### 6.3 `stroq attack`

- Scenario = ordered list of recorded hook events (`examples/demo/events/*.json` is the existing shape) + expected outcome per step; 12 scenarios for launch, each citing the incident it models. Runs through `StroqEngine` with the user's real policy (via `engine-factory`) against throwaway session/audit stores. Prints `blocked / asked / passed` per scenario, a total, and `--json` for badges. Live mode (driving `claude -p`) is explicitly out of scope for v1.

### 6.4 Table stakes to fix alongside (cheap, from probing the current classifier)

Currently unclassified: `npx <pkg>` (Sentry vector), `terraform destroy`, `drizzle-kit push --force`, `prisma migrate reset --force`, `gh repo create --public --push` (s1ngularity), `rm -rf ~/Documents` (tilde is not expanded, so a home-directory target is not seen as outside the repo). Add these to `shell.destructive` / `git.push_external` / a new `pkg.exec_unknown` class; consider vendoring cc-safety-net's MIT rulebook for coverage parity on the destructive list.

### 6.5 Sequence (one engineer + Claude, ~3 weeks)

1. Week 1 — Provenance core, `stroq why`, `classifierContext`, README bullet + GIF of the Sentry-style block.
2. Week 2 — Secret egress guard + canary; classifier table stakes; second GIF.
3. Week 3 — `stroq attack` with 12 incident scenarios + `stroq report`; CHANGELOG; 0.2.0; Show HN ("a local firewall that tells you where your agent's command came from"), referencing Rehberger's auto-mode break and the Sentry disclosure; Claude Code plugin marketplace listing; then the Cursor adapter (hooks expose `beforeShellExecution` and `afterShellExecution` output, enough for both features).

## 7. What we deliberately do not build now

- **An ML/ONNX content classifier.** Anthropic already runs a server-side injection probe on tool results; Prompt Guard 2, Sentinel, AIR and every SaaS vendor sell detection; and the literature shows content filters are bypassable by construction. Our moat is origin and effect, not detection accuracy. Revisit after Provenance ships.
- **A gateway/proxy.** Pipelock, clawpatrol, Docker MCP Gateway, Obot, Runlayer, Tailscale Aperture own it; native hooks are the cheaper integration and the only one without a hot-path round-trip.
- **Static skill/MCP scanners.** Snyk 3.0k★, Cisco 2.5k★, Socket, Semgrep — crowded and beaten by packing (SkillCloak). `stroq attack` scenarios can *include* a poisoned skill, which is the runtime answer.
- **MCP lockfile.** Hooks expose neither tool descriptions nor schemas; needs the daemon. Later.
- **A plain destructive-command list as the headline.** dcg and cc-safety-net own that story with 7k+ combined stars; we match it as table stakes and differentiate on provenance.

## Appendix: key sources

- Claude Code permission modes (classifier input, `classifierContext`, "does not guarantee safety"): https://code.claude.com/docs/en/permission-modes · hooks: https://code.claude.com/docs/en/hooks · sandboxing: https://code.claude.com/docs/en/sandboxing · auto-mode engineering: https://www.anthropic.com/engineering/claude-code-auto-mode · auto mode default: https://claude.com/blog/auto-mode-default-in-claude-code
- Rehberger, Breaking Claude Code Opus 5 auto mode (2026-08-26): https://embracethered.com/blog/posts/2026/breaking-claude-code-opus-5-and-automode/ · HN: https://news.ycombinator.com/item?id=49506819
- Tenet, Agentjacking coding agents with fake Sentry errors (2026-06-17): https://tenetsecurity.ai/blog/agentjacking-coding-agents-with-fake-sentry-errors/
- Comment-and-Control (2026-04): https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/ · RoguePilot: https://orca.security/resources/blog/roguepilot-github-copilot-vulnerability/ · s1ngularity: https://www.wiz.io/blog/s1ngularity-supply-chain-attack · jqwik protestware: https://nesbitt.io/2026/05/28/protestware-for-coding-agents.html · ContextCrush: https://www.noma.security/blog/contextcrush-context7-the-mcp-server-vulnerability · Check Point CVE-2025-59536: https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/ · Pillar sandbox escapes: https://www.bleepingcomputer.com/news/security/cursor-codex-gemini-cli-antigravity-hit-by-sandbox-escapes/ · ToxicSkills: https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/
- Demand threads: claude-code #27063, #28240, #16561, #30519, #32733, #44868, #81458, #85588; codex #3085, #2860; Docker rm -rf write-up: https://www.docker.com/blog/coding-agent-horror-stories-the-rm-rf-incident/ · Cursor forum drive wipes: https://forum.cursor.com/t/cursor-agent-completely-wiped-my-c-drive-and-deleted-everything/164675
- Competitors: dcg https://github.com/Dicklesworthstone/destructive_command_guard · cc-safety-net https://github.com/kenryu42/claude-code-safety-net · Pipelock https://github.com/luckyPipewrench/pipelock · Microsoft AGT https://github.com/microsoft/agent-governance-toolkit · clawpatrol https://github.com/denoland/clawpatrol · fence https://github.com/fencesandbox/fence · agentsh https://github.com/canyonroad/agentsh · Snyk agent-scan https://github.com/snyk/agent-scan · mcp-context-protector https://github.com/trailofbits/mcp-context-protector · APort https://aport.io/ · HiddenLayer Agent Harness: https://www.prnewswire.com/news-releases/hiddenlayer-unveils-agent-harness-security-to-protect-ai-powered-software-development-at-runtime-302841271.html · Zenity Runtime Boundaries: https://www.helpnetsecurity.com/2026/07/27/zenity-exposure-management-runtime-boundaries/ · AIR Security: https://techcrunch.com/2026/09/01/air-raises-50m-to-help-companies-vet-the-skills-and-add-ons-ai-agents-use/ · Certiv: https://certiv.ai/coding-agents/
- Research: LivePI https://arxiv.org/abs/2605.17986 · CaMeL https://github.com/google-research/camel-prompt-injection · FIDES https://arxiv.org/abs/2505.23643 · ARGUS https://arxiv.org/abs/2605.03378 · ProvenanceGuard https://arxiv.org/abs/2607.01236 · AuthGraph https://arxiv.org/abs/2605.26497 · controlled-release prompting https://arxiv.org/abs/2510.01529 · SoK adaptive attacks https://arxiv.org/abs/2601.17548 · "AI agents may always fall for prompt injections" https://arxiv.org/abs/2605.17634
