<!--
  GENERATED FILE. Do not hand-edit.
  Produced by `pnpm generate:reports` from `stroq bench --corpus vendor/bench-corpus/files`'s own output.
  Refresh it with `pnpm generate:reports`; `pnpm check:reports` fails CI if
  this file and the command's live output disagree.
-->

# Stroq bench

Stroq's false-positive rate against real, benign developer documentation. This number is ours — measured by a method we publish, on a corpus we vendor. It is not a third-party audit.

```text
stroq bench: 121 files, 2307 KB, 639 rules
flagged:   29 / 121   (24.0%)

  STROQ-2026-00005   Remote script piped into a shell                 19 files
  ATR-2026-00113     Credential File Theft from Agent Environment     4 files
  STROQ-2026-00002   Hidden directive addressed to the AI assistant   2 files
  ATR-2026-00060     MCP Skill Impersonation and Supply Chain Attack  2 files
  STROQ-2026-00004   Instruction to read and send credentials         1 file
  ATR-2026-00523     Claude Code Hooks SessionStart Pre-Trust RCE (CV 1 file
  ATR-2026-00567     MCP stdio server config command injection via un 1 file
  ATR-2026-00568     Agent SSRF to cloud metadata / file inclusion vi 1 file
  ATR-2026-00030     Cross-Agent Attack Detection                     1 file
  ATR-2026-01463     im_end / im_start System Prompt Injection Format 1 file
  ATR-2026-00148     Multilingual Prompt Injection via Language Switc 1 file
  ATR-2026-00120     SKILL.md Prompt Injection                        1 file
  ATR-2026-02002     Instruction-Set Probe or Supplant                1 file
  ATR-2026-00114     OAuth and API Token Interception                 1 file
  ATR-2026-00150     Credential Data Leaked in Tool Response          1 file
  ATR-2026-00161     MCP Tool Description — IMPORTANT Tag Cross-Tool  1 file
  ATR-2026-00163     Hidden Override Instructions in Skill Content    1 file

Flagged files:
  vendor/bench-corpus/files/ClickHouse-ClickHouse/README.md
  vendor/bench-corpus/files/Graphify-Labs-graphify/README.md
  vendor/bench-corpus/files/HKUDS-CLI-Anything/README.md
  vendor/bench-corpus/files/ReactiveX-RxJava/README.md
  vendor/bench-corpus/files/TauricResearch-TradingAgents/README.md
  vendor/bench-corpus/files/Yuan1z0825-nature-skills/README.md
  vendor/bench-corpus/files/aaif-goose-goose/README.md
  vendor/bench-corpus/files/apache-apisix/README.md
  vendor/bench-corpus/files/astral-sh-uv/README.md
  vendor/bench-corpus/files/coollabsio-coolify/README.md
  vendor/bench-corpus/files/exo-explore-exo/README.md
  vendor/bench-corpus/files/headroomlabs-ai-headroom/README.md
  vendor/bench-corpus/files/huggingface-huggingface_hub/README.md
  vendor/bench-corpus/files/jingyaogong-minimind/README.md
  vendor/bench-corpus/files/mlabonne-llm-course/README.md
  vendor/bench-corpus/files/nexu-io-open-design/README.md
  vendor/bench-corpus/files/openai-codex/README.md
  vendor/bench-corpus/files/openinterpreter-openinterpreter/README.md
  vendor/bench-corpus/files/prometheus-prometheus/configuration.md
  vendor/bench-corpus/files/pulumi-pulumi/README.md
  vendor/bench-corpus/files/rtk-ai-rtk/README.md
  vendor/bench-corpus/files/sharkdp-bat/README.md
  vendor/bench-corpus/files/sharkdp-fd/README.md
  vendor/bench-corpus/files/skylot-jadx/README.md
  vendor/bench-corpus/files/thedotmack-claude-mem/README.md
  vendor/bench-corpus/files/unionlabs-union/README.md
  vendor/bench-corpus/files/unslothai-unsloth/README.md
  vendor/bench-corpus/files/usestrix-strix/README.md
  vendor/bench-corpus/files/zylon-ai-private-gpt/README.md

corpus: vendor/bench-corpus/files
```

Every file the list above names is unmodified, ordinary documentation belonging to its own project. Appearing in it means a Stroq rule fired in error on that file — it is not a statement that the file, or the project it comes from, did anything wrong.

## Method

The bench declares the surface it is scanning — `repo_content`, because the corpus is documentation — and rules scoped to a different surface are not counted against it. **This changed what the number means.** Before the surface was declared, every rule the bundle ships was measured against documentation, including any rule written to read something else; now the rate is a rate for the rules that read documentation. Compare this figure with one published before 2026-09-15 and you are comparing two slightly different denominators, so don't. Declaring the surface did not itself move the rate — it was 40.0% before and after — because every rule this corpus convicts reads every surface. What moved the rate afterwards was narrowing six of those rules, described below.

None of the rules named above is scoped away from documentation, and that is still a deliberate choice rather than an oversight: every rule this corpus convicts is a loose pattern rather than a rule reading the wrong surface — a pattern that would be just as wrong on a tool description or a command line, so declaring a surface for it would remove it from this measurement while leaving it exactly as wrong everywhere else. What changed is that six of them stopped being loose. The measurement said tighter patterns, not narrower surfaces, and six patterns were tightened: the transition-word list in `ATR-2026-00142` no longer reads the "ps" inside "https"; `ATR-2026-00113` no longer takes an HTTP method table row for a command; the framing `ATR-2026-00117` exists to detect is no longer optional, so the bare phrase "system command" is not a match; the final word of `ATR-2026-00030`'s "on behalf of" clause is no longer optional; `run` in `STROQ-2026-00002` no longer matches the `RUN` in `RE-RUN`; and `email` in `STROQ-2026-00004` now needs a direct object, which the noun on every service account never has. Each was verified against the rule's own documented true positives before and after, and each pair is pinned in [`packages/core/test/rules/pattern-regressions.test.ts`](../packages/core/test/rules/pattern-regressions.test.ts) so a later edit cannot quietly widen it back. The four vendored rules are patched through [`rules/atr-overrides.yaml`](../rules/atr-overrides.yaml) rather than by editing rules/atr, which is imported verbatim from upstream.

The corpus grew on 2026-09-25, and the rate rose with it: 16.0% on the first 25 files, 24.0% on the 121 that replaced them. The first 25 were chosen by hand and weighted toward the documents most likely to trip a credential- or token-shaped rule. The 96 added are chosen by a rule instead of by us — the root README of each of the 100 most-starred Apache-2.0 repositories on GitHub that are not archived, less the four already here — so they are the documents an agent most often actually reads rather than the ones we expected to be hard. Compare this figure with one published before that date and you are comparing two corpora, so don't.

The largest single source of false positives on the wider corpus is `STROQ-2026-00005`, `curl … | sh`: an install line in a README is byte-identical to the same line in an injected instruction, so no pattern separates them, and scoping the rule to command output cost two recorded attack scenarios. What can change is what a match does — whether reading an install line should taint the session at all, when running `curl … | sh` is denied on its own — and that is a decision about the rule, not about this measurement. `ATR-2026-00150` matches a bare `-----BEGIN PRIVATE KEY-----` header, and its own documented true positives are bare headers too, with no key body — exactly like the TLS configuration example it flags. The difference between those two is the surface the text arrived on, which is a scan_target question rather than a regex one, and it is open.

Production scans under a 4,000 ms wall-clock budget (`DEFAULT_BUDGET_MS`, [`packages/core/src/scan/scanner.ts`](../packages/core/src/scan/scanner.ts)) and fails closed the moment it runs out — verdict: 'suspect' plus a synthetic STROQ-SCAN-BUDGET match — because a slow scan must never hang a tool call. This bench deliberately uses a far larger budget, 60,000 ms (`BENCH_BUDGET_MS`, [`packages/cli/src/bench/run.ts`](../packages/cli/src/bench/run.ts)): it is measuring which rules match real documentation, not how fast the machine producing this report happens to be, and a timeout-induced verdict is not a rule false positive — folding one into the count above would both overstate the rate and make it depend on the runner rather than the rules. If a scan still exceeds even the 60 s bench budget, it is reported as a `timedOut` line above rather than folded silently into a rule's hit count.

The corpus is vendored, unmodified, third-party developer documentation — README, CONTRIBUTING, SECURITY and configuration files pulled from real Apache-2.0-licensed projects, 25 chosen by hand and 96 by the rule above — fetched at an exact resolved commit and pinned by sha256 for every file in [`vendor/bench-corpus/sources.json`](../vendor/bench-corpus/sources.json); `pnpm check:bench-corpus` fails CI if a committed file no longer matches the hash the manifest recorded for it. See [`vendor/bench-corpus/PROVENANCE.md`](../vendor/bench-corpus/PROVENANCE.md) for why each source was chosen.

This corpus is deliberately disjoint from `rules/fixtures/benign`, a separate, much smaller corpus that `stroq bench` never reads: `scripts/build-rules.ts` runs every ATR rule against those fixtures at build time and disables any rule that fires on one, which is where the disabled rules in the shipped bundle come from. Measuring the false-positive rate against that same corpus would report a number close to zero by construction — the rules were tuned on it — regardless of how they behave on text they were never checked against, so the number above would be measuring the build gate rather than the rules. `packages/cli/test/bench/corpus.test.ts` enforces the two corpora share no file by hashing both directories, rather than relying on nobody copying a file across.

`stroq bench --corpus <dir>` reproduces this measurement on your own files. The vendored corpus this document measures ships with the repository, not with the published npm package — `stroq bench` with no `--corpus` looks for it next to the installed CLI and, not finding it there, tells you to pass `--corpus` yourself, which is always the case for an installed CLI.
