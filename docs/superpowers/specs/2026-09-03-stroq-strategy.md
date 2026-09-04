# Stroq — Strategy and MVP Plan (research summary, September 2026)

*Working document written on 2026-09-03 from primary-source research; numbers are as of that date.*

## Context

The source document ("Prompt Firewall — Market & Competitive Analysis 2026") reflects early 2026. Checking it against primary sources (SEC filings, Gartner, vendor docs, the GitHub API, arXiv; roughly 200 searches and roughly 300 page loads across three agents, plus manual verification) shows the market has moved on:

- **The standalone prompt-firewall-for-chatbots category is over.** Every pure-play vendor has been acquired and folded into a platform as a module: Protect AI → Palo Alto ($634.5M per the 10-K), Lakera → Check Point ($201.8M per the 20-F, not "$300M"), Prompt Security → SentinelOne ($180M per the 8-K, not "$250M"), CalypsoAI → F5 ($180M), Aim → Cato, Invariant → Snyk, Pangea → CrowdStrike, Acuvity → Proofpoint (Feb 2026), Enkrypt → Anaconda (Aug 2026), Virtue AI → Fortinet (17 Aug 2026), Promptfoo → OpenAI (Mar 2026), Koi and Portkey → Palo Alto (Apr-May 2026). In its AppSec Hype Cycle 2026, Gartner **removed the "AI Gateways" category** and introduced "AI Runtime Defense" and "MCP Cybersecurity" instead.
- **Prompt detection costs approximately zero.** Google Model Armor is $0.10 per million tokens (2M free), OpenAI Moderation is free, AWS prompt-attack detection is $0.08 per 1,000 units, Azure is $0.38 per 1,000 records, and Meta Prompt Guard 2 is free. A bootstrapped team cannot sell a "detector per request" business.
- **The market has shifted to agents and their actions.** Gartner (26 Aug 2026): spend on "securing AI" goes from $2.835B (2026) to $4.783B (2027, +68.7%) to roughly $7.7B (2028); 2027 segment breakdown: AI application security $851M, AI usage control $749M (+73%), AI gateway $429M (+70.9%). In a single week in September 2026: HiddenLayer raised $100M (focused on coding agents), Lasso raised $30M, AIR raised $50M (vetting MCP servers and skills); Zenity raised $125M (Aug 2026); Runlayer raised $30M (Jun 2026).
- **Incidents flow through tools, not through chat.** OpenClaw (145k+ stars, 100k+ developers with credits connected): ClawHavoc (335+ malicious skills), Moltbook (1.5M tokens), CVE-2026-25253. Snyk ToxicSkills (5 Feb 2026): 36.8% of 3,984 skills had vulnerabilities, 76 were malicious, targeting OpenClaw/Claude Code/Cursor. Cursor: prompt injection → RCE, CVSS 9.8 (CVE-2026-50548/9, Jul 2026). Claude Code: 28 CVEs in a year. MCP: 40+ CVEs in the first 4 months of 2026, the postmark-mcp backdoor, NSA guidance published (May 2026). OWASP MCP Top 10 v1.0 shipped in Oct 2026.
- **Existing protection is weak and noisy.** LivePI (Jun 2026): frontier agents fall for indirect injection 10.7-29.6% of the time. USENIX Sec 2026: "controlled-release prompting" bypasses 14 open-source guard models. YARA/regex matching on MCP descriptions produces roughly 78% false positives (AppSec Santa, Apr 2026). NeMo shows a 16% FPR and multi-second latency. Prompt Guard 2 covers 8 languages, none of them Russian, and is trained on user prompts, not tool outputs. Only 27% of CISOs have any injection filtering at all (NeuralTrust, Jun 2026).
- **But LivePI demonstrated a working architecture:** two layers, content filtering plus pre-execution tool-call authorization, intercepted 100% of malicious targets without loss of utility. The NSA makes the same point: "every request in an MCP system should be checked against rules."
- **A critical technical fact:** in Claude Code, Cursor, Codex, Copilot, and Windsurf, a PreToolUse hook timeout is **fail-open**. Any guard that thinks for longer than tens of milliseconds, or makes a call to the cloud, silently stops protecting. This kills cloud-API detectors in this niche and hands the advantage to a local engine.

**Conclusion: we are not building a "prompt firewall," we are building a local "action firewall" for agents.** Working name: Stroq (after the directory).

---

## 1. Product (in one paragraph)

**Stroq is an open-source local firewall for AI agents (Claude Code, Cursor, Codex, Copilot CLI, Windsurf, OpenClaw, any MCP client, plus LLM gateways).** It installs with a single command, with no proxy and no code changes, through the agents' native hooks. It does three things: (1) it **scans everything the agent reads** (files, the web, MCP responses, command output, skills) for indirect prompt injection using a local semantic model with a low false-positive rate (FPR) and Russian-language support; (2) it **applies a taint-aware policy to actions**: after reading untrusted content, dangerous actions (shell commands with network access, git push to an external remote, access to secrets, deletion, sending email, payments) are blocked or require confirmation, deterministically, in under 50ms, using rules from the ATR standard; (3) it keeps a **tamper-evident audit** log of the agent's actions. Monetization is a team control plane: fleet-wide policies, aggregated audit, alerts, SSO, and SIEM export.

**What we are not building:** our own LLM/MCP gateway (Obot $35M, Runlayer $42M, Docker, Kong, Cloudflare), a cloud detector billed per request (priced at roughly zero), an enterprise sales-led motion from day one, or a compliance product (the EU AI Act's high-risk obligations have been pushed to 2 Dec 2027).

## 2. Positioning

- Tagline: **"A firewall for agent actions, not for prompts. Local, under 50ms, no cloud in the hot path."**
- Who we compete against, and how we win:
  - **Enterprise platforms** (HiddenLayer Agent Harness, Zenity Runtime Boundaries, Noma for Cursor, Snyk Agent Guard, private preview, Endor Labs hooks, TrueFoundry hooks API, Straiker): a SaaS backend in the hot path, sales-led, expensive, not built for SMBs or individuals. We are local-first and self-serve.
  - **Microsoft Agent Governance Toolkit** (OSS, MIT license, 6,180 stars, deterministic policies under 0.1ms, a Claude Code plugin, consumes ATR): covers _policy_ but not the semantics of what the agent reads, not taint, not multilingual support. **We do not compete: we integrate.** Stroq acts more as a "sensor" alongside AGT policies, with ATR-compatible rules.
  - **Solo OSS projects** (Pipelock, 829 stars, regex + receipts; GoPlus AgentGuard, 458 stars; Falco prempti, 201 stars; AgentWall, 38 stars; Lasso claude-hooks; Agent Control, 32 stars): regex/YAML, a single maintainer, no ML detection, no team layer, no public FPR benchmarks.
  - **APort** (Free / Team $499 / Enterprise $4,990; deterministic pre-action authorization for Claude Code/Cursor, signed decisions): the closest commercial analog to our model. We win on semantic detection, taint, OpenClaw/MCP-output coverage, price ($299 for 10 seats), and multilingual support.
  - **Native protections**: the Claude Code auto-mode classifier (Sonnet-based, cloud, 0.4% FPR / 17% miss rate; the server-side probe only _warns_; Anthropic itself calls it "best-effort, not a security guarantee," and a bypass was published on 26 Aug 2026); Cursor has hooks but no runtime classifier; OpenClaw has `before_tool_call`, but skills "run with OpenClaw's own permissions, with no sandbox." We are cross-platform, deterministic, and feed the native classifier through `classifierContext`.
- Required, verifiable differentiators (each one a confirmed gap in a competitor):
  1. **Semantic scanning of tool outputs and MCP responses** (not just commands), with **FPR under 1%** on real README/MCP descriptions, backed by a public benchmark in the repo.
  2. **Taint-aware policy** (the LivePI/ClawGuard architecture): we block "a dangerous action following an untrusted read," not "suspicious-looking text."
  3. **A hard local latency budget** (under 50ms p99) and **fail-closed for high-impact actions**, the only way to avoid becoming fail-open.
  4. **One install covers every agent** (Claude Code, Cursor, Codex, Copilot, Windsurf share one binary and config; OpenClaw gets a plugin; everything else goes through the MCP stdio proxy).
  5. **Russian and Kazakh language support**, where Prompt Guard 2 has no Russian and the Lakera/Azure/LLM Guard public APIs are text-only and English-first.
  6. **A warn-to-block tuning cycle** with a local log of triggers (exactly what developers ask for on HN/GitHub).
- Who we sell to: teams of 5-200 developers running Claude Code/Cursor in production (Anthropic has 1,000+ customers at $1M+/year, and Claude Code business subscriptions are up 4x since Jan 2026; Cursor has 50k+ enterprise teams), OpenClaw operators, and security teams that need an audit trail of agent actions. The second channel is Kazakhstani banks and telecoms under Kazakhstan's AI Law (in force since 18 Jan 2026), where cloud detectors are not viable and no INFERA-like local solution exists in Kazakhstan.

## 3. Market and problem

- **TAM (Gartner, 26 Aug 2026):** $2.835B (2026) → $4.783B (2027) → ~$7.7B (2028) → $16.4B (2030). Our segment is "AI usage control" ($749M in 2027) plus "AI Runtime Defense" (Gartner: 5-20% adoption, peak of the hype cycle).
- **Bottom-up:** Claude Code run-rate is $2.5B+ (Feb 2026, per Anthropic; the "$8B" figure comes from unverified aggregators); Cursor is at $2B+ ARR; 41% of software companies have MCP in production (Stacklok, Jan 2026); security is the #1 problem in MCP adoption (50%) and a blocker for 38% (Zuplo). Plan: converting 0.1-0.3% of active OSS teams to Team ($299) → ~$10k MRR at ~30 teams; reaching ~$1M ARR within 12-18 months is a realistic bootstrap target.
- **The problem is confirmed** by the incidents cited above (see Context) and by the fact that more than 20% of organizations have already reported a breach through AI applications, 92% of which had no AI access controls in place (IBM, Jul 2026).
- **Sober facts against us:** there is no verified, independent, profitable prompt-security company; every growth story so far has ended in an acquisition within 12-30 months (Invariant in under a year, Promptfoo in ~2.5 years). That is both a risk and an exit path: we are building a capital-efficient SaaS business on a permissively licensed core.

### Competitive landscape (verified, September 2026)

| Layer                              | Players                                                                                                                                                                                                                               | What matters to us                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat firewalls for LLM applications | Check Point (Lakera), Prisma AIRS, SentinelOne, Cisco, CrowdStrike AIDR (Pangea), Azure Prompt Shields, Bedrock Guardrails, Model Armor, Cloudflare (Enterprise add-on), Prompt Guard 2 (OSS)                                        | commodity, not our core product; available to us as a guardrail provider                                                                               |
| LLM/MCP gateway                     | Obot, Runlayer, MintMCP, Docker MCP Gateway (interceptors), agentgateway (Solo.io), Kong, TrueFoundry, LiteLLM, Portkey (→ PANW), Bifrost                                                                                            | we do not build this; we integrate instead: LiteLLM Generic Guardrail API (32 vendors listed in the docs, a PR-based path in), Portkey BYO webhook, Traefik external guard, Docker interceptor |
| Enterprise agent runtime security   | HiddenLayer ($100M, Agent Harness, 3 Aug 2026), Zenity ($125M, Runtime Boundaries + taint), Noma (Cursor hooks), Snyk Agent Guard (preview), Endor Labs (29 policies, SaaS), TrueFoundry hooks API, Straiker, INFERA (Russia)         | confirm demand; cloud in the hot path, sales-led                                                                                                        |
| OSS policy and rules                | **Microsoft AGT** (6,180 stars, MIT), **ATR** (683 rules, MIT; used by AGT, Cisco, MISP, SigmaHQ, FINOS), GoPlus AgentGuard (458 stars), Falco prempti (201 stars), Pipelock (829 stars), AgentWall (38 stars), Lasso claude-hooks, Agent Control, Fence | policy/regex is well covered already, so we consume ATR, stay friendly with AGT, and differentiate on semantics, taint, and the team layer              |
| Commercial self-serve                | APort ($499/$4,990), MCP Manager ($135-668), Enkrypt ($149/$1,499), Qualifire ($550), SafePrompt ($29)                                                                                                                               | a $100-1,500/month per-team price corridor; seat-based, not token-based                                                                                 |
| Supply-chain scanning                | Snyk agent-scan (2,999 stars), Cisco Skill Scanner, Koi (→ PANW), AIR ($50M)                                                                                                                                                         | a feature (`stroq scan`), not a product                                                                                                                 |
| Guard models                        | Prompt Guard 2 (22M/86M, 8 languages), Qualifire Sentinel v2 (0.6B, F1 0.964, 38ms, Elastic License), Qwen3Guard (119 languages, Apache), Granite Guardian 4.1 (agentic checks, 8B), gpt-oss-safeguard (20B)                          | we start with PG2 86M + ATR; our own Russian-language mDeBERTa fine-tune under Apache-2.0 becomes both an asset and a channel (via Hugging Face)        |

## 4. Model: open-core, seat-based pricing

| Tier                       | Price                                 | What's included                                                                                              | Anchor                                            |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **OSS core** (Apache-2.0)  | $0                                     | engine, adapters, local model, taint, file-based audit log, CLI                                               | Gitleaks/Trivy-style ubiquity                     |
| **Free cloud**              | $0                                     | 1 org, 3 seats, 7 days of audit history                                                                       | Langfuse Hobby                                    |
| **Team**                    | **$299/month** (10 seats, +$20/seat)  | cloud/self-hosted fleet-wide policies, 90-day signed audit log, Slack alerts, SSO-lite                        | Semgrep/Snyk $25-30/dev, APort $499, Aikido $300  |
| **Business**                | **$1,500-2,500/month**                 | SSO/SCIM, RBAC, 1 year of audit history, evidence export (SOC2 CC7 / ISO 42001 A.6.2.8 / AI Act Art. 12), BYOC | TrueFoundry $2,999, Langfuse $2,499               |
| **Enterprise**               | **$25-60k/year**                       | self-hosted/air-gapped control plane, SIEM, custom rules, regional requirements (Kazakhstan/EU), Marketplace  | Snyk $15-40k, LiteLLM ~$30k                       |

Principles: we never price by token or request; we gate the things enterprises already pay for everywhere (SSO/SCIM, retention, compliance export, self-hosting); distribution runs through marketplaces and gateways, not against them.

## 5. MVP architecture (as simple as possible)

A TypeScript monorepo (pnpm); Python only for offline ML. One local daemon, thin adapters.

```
stroq/
├── packages/
│   ├── core/            # normalizer (zero-width stripping, homoglyph folding, base64/hex/url decoding up to 2 levels deep),
│   │                    # ATR-compatible rules engine, taint store, policy (deny→allow→ask), verdict with confidence and a time budget
│   ├── daemon/          # Fastify on 127.0.0.1:7777, onnxruntime-node (PG2 22M/86M), SQLite hash-chained audit log,
│   │                    # warm start, hard 40ms deadline → deterministic fallback
│   ├── cli/             # npx stroq init|status|scan|log|report|doctor|bench
│   ├── adapter-claude-code/   # HTTP hooks (native "http" type) + plugin manifest for the marketplace
│   ├── adapter-cursor/        # .cursor/hooks.json + curl client, failClosed for high-impact actions
│   ├── adapter-codex-copilot-windsurf/  # config only, using the same curl client
│   ├── adapter-openclaw/      # before_tool_call plugin (+ tool_result scanning)
│   ├── mcp-proxy/             # stdio wrapper for any MCP server (Claude Desktop, Windsurf, others)
│   └── guard-endpoint/        # one HTTP service: LiteLLM Generic Guardrail API + Portkey BYO webhook
├── ml/                  # dataset (injections plus a benign corpus of hard negatives drawn from real README/MCP descriptions,
│                        # with RU/KZ translations), mDeBERTa-v3-base fine-tune → ONNX int8, eval
├── rules/               # ATR import + our own rules in ATR format
└── bench/               # public eval: recall / FPR / p50, p99; CI gate
```

Key mechanisms:

- **Interception points** (native, no proxy): Claude Code `PreToolUse` (deny/`updatedInput`), `PostToolUse` (`updatedMCPToolOutput`, `additionalContext`, `classifierContext`, our verdict feeds into the native classifier), matcher `mcp__.*`; Cursor `beforeShellExecution` / `beforeMCPExecution` / `afterMCPExecution` (MCP output substitution) / `beforeReadFile`; Codex/Copilot/Windsurf use the same JSON contracts; OpenClaw `before_tool_call` (allow/cancel/modify); MCP stdio proxy; LiteLLM/Portkey via webhook.
- **Detection (3 layers, all local, 40ms budget):** normalization → ATR rules (683, MIT) → ONNX classifier (starting with PG2 22M at roughly 10-20ms, 86M for borderline cases; phase 2 is our own Russian-language mDeBERTa, Apache-2.0). Thresholds: "warn" by default, "block" only with high confidence **and** taint. If the deadline is exceeded, only the deterministic layer runs, and it is fail-closed for high-impact classes.
- **Policy engine:** YAML, deny → allow → ask; action classes: `shell.network`, `shell.destructive`, `fs.secrets`, `git.push_external`, `mcp.<server>.<tool>`, `email.send`, `payment`. Decision time under 1ms. AGT/Cedar compatibility at the export level comes later.
- **Taint:** a session is marked when it reads from an untrusted source (web_fetch, an MCP response, a file outside the repo, an email, command output from external hosts); after that, high-impact actions → ask/deny; we record chains such as "read a secret → made a network call."
- **MCP:** a snapshot of tool descriptions on first connection, drift/rug-pull detection, description scanning; `stroq scan` for skills (ClawHub/skills.sh) before installation.
- **Audit:** hash-chained JSONL + SQLite; `stroq report` → HTML; in Team, signed decisions and aggregation.
- **Fail-open for reads, fail-closed for high-impact actions** (configurable); the daemon starts on `SessionStart`.

Implementation note: the shipped MVP runs the hook in-process (no daemon yet); the daemon arrives together with the ONNX classifier.

## 6. Work plan (2-3 people, roughly 8 weeks to public release)

1. **Weeks 1-2, core + Claude Code.** `core` (normalizer, ATR loader, policy, taint), `daemon`, Claude Code HTTP hooks, audit log. Demo: a poisoned MCP server / a README with a base64 instruction → blocks an outbound `curl`.
2. **Week 3, detection and benchmark.** ONNX PG2, a benign corpus of hard negatives (500+ real README/MCP descriptions/docs), threshold calibration, `bench/` with an FPR/recall/p50/p99 report in the README.
3. **Week 4, Cursor, Codex/Copilot/Windsurf (configs), OpenClaw plugin, MCP proxy.** `npx stroq init` with auto-detection.
4. **Week 5, MCP drift, skills scan, `stroq report`, guard endpoint (LiteLLM Generic API + Portkey webhook).**
5. **Week 6, launch.** README with the benchmark; Claude Code community marketplace; Cursor Marketplace; ClawHub; a PR to the LiteLLM docs (provider page); Homebrew/npm; Show HN + Habr (RU) + one responsible disclosure on a poisoned MCP server/skill (the channel that worked for Aim/Noma/Pillar/Koi). Metric: 1k stars and 100 active installs within 30 days.
6. **Weeks 7-8, Team control plane (minimum viable).** Policies from repo/cloud, aggregated audit, Slack alerts, Stripe, pricing page. Goal: 5 paying teams drawn from early users.

In parallel (low-cost): apply to SecureIQLab (an independent AI Firewall testing methodology, running since Apr 2026); publish the multilingual model on Hugging Face; phase 2 is a self-hosted control plane plus an on-prem gateway mode for Kazakhstani banks.

## 7. Risks and mitigations

- **Agent vendors build this natively** (Claude Code auto mode has been the default since 14 Aug 2026; PANW is doing the same inside Codex). Response: cross-platform coverage, determinism, and locality (their classifiers are cloud-based, non-deterministic, and locked to their own agent), fleet-wide taint and audit; we integrate through `classifierContext` rather than compete head-on.
- **Microsoft AGT / ATR absorb "policy."** We do not compete: we consume ATR and export to AGT; our value is the semantics of what the agent reads, taint, multilingual support, and the team layer.
- **APort/HiddenLayer/Zenity outpace us on the control plane.** We win on price ($299 vs. $499), an OSS core, OpenClaw and MCP-output coverage, and a public FPR benchmark.
- **False positives kill adoption.** Default to "warn," block only with taint plus high confidence; hard negatives run through a false-positive gate in CI; a local log plus a `/feedback` loop.
- **Latency forces fail-open.** A hard 40ms deadline, a warmed-up daemon, ONNX int8, and a deterministic fallback.
- **Model licensing.** PG2 uses the Llama 4 Community license (fine up to 700M monthly active users (MAU), requires attribution); Sentinel v2 uses the Elastic License (we do not use it in the core); our own Apache-2.0 fine-tune is a phase 2 priority.
- **Scope.** The MVP is Claude Code plus a single scenario (poisoned content → blocks a dangerous action). Everything else comes after the first installs.

## 8. Verification

- Unit tests: normalizer (9 encodings, nesting depth 2), policy (deny/allow/ask ordering, wildcards, action classes), taint (chains), ATR loader (all 683 rules parse).
- ML eval (`bench/`): recall on injection cases (an AgentDojo subset plus LivePI-like scenarios plus ToxicSkills patterns), FPR on a benign corpus of 500+ real README/MCP descriptions, p50/p99 on CPU. Release gate: recall ≥90% direct, ≥70% indirect, FPR ≤1%, p99 ≤40ms.
- E2E: Claude Code hook fixtures (JSON stdin → JSON decision) and HTTP hooks; Cursor hooks.json; the OpenClaw plugin in a test instance; an MCP proxy in front of a deliberately poisoned server: (a) a tool description with an exfiltration instruction → block; (b) a README with a base64 instruction → warn, then an outbound `curl` to an external host → deny; (c) a description drift after the first connection → alert; (d) a detector timeout → the high-impact action is still blocked by the deterministic layer.
- Manual check: `npx stroq init` on a clean machine (macOS/Linux) reaches the first block in under 2 minutes; `stroq report` shows the full chain.

## Assumptions

- The target market is the global developer-first audience (English-speaking), with the CIS/Kazakhstan channel second. If the priority were Kazakhstani banks on-prem instead, the sequencing would flip: self-hosted gateway mode and the multilingual model would come first, with sales-led selling.
- The stack is TypeScript (the hooks/plugins ecosystem, OpenClaw plugins are written in TS, and the web rules), with ML training offline in Python. Go is the fallback for single-binary distribution if npx turns out to be a barrier.
- The team is 2-3 people with no dedicated ML engineer: the plan starts from off-the-shelf models and ATR rules, with an in-house fine-tune as a phase 2 priority.

## 10. Key sources

- Gartner PR, 26 Aug 2026 (reprinted by ARN/SecurityBrief)
- Gartner Hype Cycle for AppSec 2026 (via NeuralTrust/F5)
- PANW 10-K FY2025 R72
- Check Point 20-F FY2025 R52
- SentinelOne 8-K, 8 Sep 2025
- TechCrunch, HiddenLayer $100M, 2 Sep 2026
- SiliconANGLE, Lasso, 2 Sep 2026
- Zenity $125M, 4 Aug 2026
- Fortinet-Virtue AI, 17 Aug 2026
- Snyk ToxicSkills, 5 Feb 2026
- Adversa OpenClaw guide
- Practical DevSecOps MCP stats 2026
- NSA CSI on MCP, 20 May 2026
- OX Security, MCP supply chain, 15 Apr 2026
- Cato, CVE-2026-50548/9
- Phoenix, Claude Code CVEs
- LivePI, arXiv 2605.17986
- ClawGuard, arXiv 2604.11790
- USENIX Sec 2026, arXiv 2510.01529
- AppSec Santa, MCP audit, Apr 2026
- Anthropic, auto-mode engineering post, 25 Mar 2026, and docs/hooks
- Cursor docs/hooks
- Codex hooks docs
- Copilot hooks reference
- LiteLLM Generic Guardrail API
- Portkey BYO guardrails
- Microsoft AGT repo
- ATR repo/spec
- Pipelock, AgentGuard, prempti, AgentWall, APort pricing pages
- AWS/Azure/Google/Cloudflare pricing pages
- Semgrep/Snyk/Langfuse/TrueFoundry pricing
- Morgan Lewis, EU AI Act Omnibus, Jun 2026
- EY/Forbes.kz on Kazakhstan's AI Law
