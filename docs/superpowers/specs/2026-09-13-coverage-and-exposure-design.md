# Coverage and exposure — design spec (2026-09-13)

**Goal.** Stop competing on rule count, which Stroq loses and which does not describe coverage, and take the three measurement axes no vendor in the field occupies: a false-positive rate on benign developer traffic, an evasion-robustness score, and a machine-generated coverage artifact against a canonical taxonomy. Shift detection weight from what the agent *reads* (unbounded natural language) to what the agent *writes* (a small, enumerable set of privilege-widening keys). Give an individual developer a reason to keep Stroq installed by showing them their own exposure instead of a silent hook.

**Occasion.** The 2026-09-10 and 2026-09-11 Show HN posts scored 2 and 3 points with no external commenter; Habr likewise produced no feedback. 741 npm downloads in the last month, 307 unique clones, 13 stars, 0 issues. Installs happen; engagement does not. This spec is the response, and it is grounded in measurements taken on 2026-09-13 against this repo and this machine rather than on the launch narrative.

**Scope note.** This is a program-level design covering four parts. Parts 2, 3 and 4 each get their own implementation plan under `docs/superpowers/plans/`; Part 1 is small enough to ride along with Part 2's plan.

---

## 1. Evidence

Every row was measured on 2026-09-13 against `packages/core/dist` at main `4bb1005`, on the author's machine. Probes lived in the session scratchpad and are not committed; each is reproducible from the description.

| # | Measurement | Result | What it establishes |
| --- | --- | --- | --- |
| E1 | `scanContent` over 4,824 markdown files under `~/.claude/{skills,plugins,agents,commands}` | 534 suspect (11.1%) | The content layer is noisy on legitimate developer text. |
| E2 | Distinct rules firing in E1 | 45 of 599; top 3 = 51% of all matches | The noise is concentrated, not diffuse, so it is fixable. `ATR-2026-00161` (MCP Tool Description — IMPORTANT Tag) alone hit 194 files of documentation it was never meant to read. |
| E3 | 21 hand-built mutations of one injection payload through `scanContent` | 17 caught, 4 missed | The misses are synonym rephrase, indirection ("read file X and follow it"), rot13, and polite framing — every one of them a *plausible-English* payload with no giveaway phrase. |
| E4 | `classifyCommand` over obfuscated shell forms | `c""url … \| s""h`, `eval "$(curl …)"`, `bash <(curl …)` all still classify `shell.exec_encoded` | The action-class layer is structurally mutation-resistant. Shell obfuscation buys the attacker nothing. |
| E5 | `classifyCommand` over `npx @sentry-tooling/report-fix --apply` and `pip install <pkg>` | no class at all | The exact shape of Sentry agentjacking and s1ngularity is unclassified. Known in memory as a classifier gap; now confirmed and quantified. |
| E6 | `evaluatePolicy(DEFAULT_POLICY, classes, taint)` over 18 commands at `clean` vs `suspect` | 6 commands allowed at `clean`, denied at `suspect` — `python3 -c urllib`, `curl -X POST -d @.env`, `ssh-keygen -y -f ~/.ssh/id_rsa`, `aws s3 sync`, `nc -e /bin/sh`, `npm publish` | The failure chain is real and complete: a scan miss leaves the session `clean`, and a third of the dangerous surface is then permitted. E3 supplies the scan miss. |
| E7 | `packages/core/src/engine.ts:304` | `extractAtoms` runs unconditionally; the verdict is passed to `recordProvenance` only as a flag | Provenance survives a scan miss. It is the one content-independent trust signal already shipping. |
| E8 | `tags.scan_target` across the bundled rules | declared in `packages/core/src/rules/atr-types.ts:22`, unset on 599/599, and dropped by the compiler (compiled rules carry only `id, title, severity, category, condition, tests`) | The surface dimension that would fix E2 exists as a schema stub and was never wired. |
| E9 | Fresh `npx @stroq/cli@0.10.1` in an empty repo | `--version`, `-v` and `version` all print help; `doctor` shows 6 red `✘` of 11 lines for agents the user does not have installed | The first two screens a new user sees are broken and alarming. |
| E10 | Agent surface on the author's machine | 5 agent config dirs present, Stroq installed in none; 4,824 instruction files from third-party marketplaces; `MEMORY.md` live | `stroq exposure` has real findings to report on a real machine, including the author's. |

### External findings that shape the design

Cited because they change what we build. Marked ✔ where verified against a primary source during research, ⚠️ where single-source.

- **The highest-impact public attacks use no obfuscation.** GhostCommit (ASSET, 2026-06), GitInject (arXiv:2606.09935), NVIDIA's indirect `AGENTS.md` injection (2026-04-20), Clinejection (2026-02-09) and TrustIssues (GHSA-wpqr-6v78-jr5g) all deliver clean prose. Rehberger's note on CVE-2025-53773 records that invisible-Unicode concealment made his exploit *"very unreliable"* — obfuscation costs the attacker. ✔ **Therefore:** invisible-character detection covers the cheapest attacks, not the best ones; it must not be the headline of a coverage number.
- **Structural preconditions are near-zero-FP where content is not.** GitInject's paired control is decisive: the identical payload delivered through a PR body fails, and through `GEMINI.md` succeeds. The file's trust tier is load-bearing, not the words. ⚠️ **Therefore:** predicates ("an instruction file arrived from a fork", "an `AGENTS.md` is untracked", "an instruction file cites a binary asset as a source of procedure", "a shell command appears in an issue *title*") belong in the engine alongside content rules.
- **Writes are enumerable where reads are not.** Cisco's persistent memory compromise of Claude Code (2026-04-01, fixed in v2.1.50) planted a `UserPromptSubmit` hook in the global `settings.json` and an alias re-enabling auto-memory. The privilege-widening key set is small: `UserPromptSubmit` in user-level settings, `enableAllProjectMcpServers`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `chat.tools.autoApprove`, `"runOn":"folderOpen"`, a `hooks` key in workspace config. ✔ **Therefore:** this is the strongest single addition to the policy, and the clearest argument for an action firewall over a content filter.
- **Local ML classifiers do not solve this.** `onnxruntime-node` is 282 MB unpacked; Meta PromptGuard scores 2.65% on NotInject (arXiv:2410.22770), i.e. ~97% false positives on benign trigger-word text; emoji smuggling achieves 100% evasion against all six systems in arXiv:2504.11168; Meta deleted the "indirect injection" label in Prompt Guard 2 as *"too broad to be useful"* — the label matching our threat model. ✔ **Therefore:** no classifier in core.
- **Scanning only `U+E0000–E007F` is a generation behind.** Sneaky Bits (2025-03-12) uses Variant Selectors VS1–VS256 and `U+2062`/`U+2064` binary encoding; Microsoft (2026-09-03) documents single-character `U+E0020` insertion *inside* words, which defeats run-length thresholds; AWS (2025-09-30) documents UTF-16 surrogate re-formation, where single-pass stripping creates new tag characters. ⚠️ **Therefore:** normalization must be recursive and cover the full invisible range.
- **A CLI coverage matrix is already occupied.** `luckyPipewrench/pipelock` (Apache-2.0, 842★, open-core) compiles one in, covering OWASP MCP 8/2/0, OWASP Agentic 4/5/1 and "ATLAS" 9/5/0. ✔ But it uses invented IDs (`ATLAS01…ATLAS14`) against ATLAS's real technique set, does not vendor its denominator, and its `docs/owasp-mapping.md` disagrees with its own `owasp_agentic.go` on 6 of 10 categories. **Therefore:** we beat it on canonical IDs, a vendored versioned denominator, and CI generation so docs cannot drift from code — not by printing a matrix at all.
- **Nobody maps coding-agent controls to any taxonomy.** promptfoo shipped 14 coding-agent plugins on 2026-04-10 and has zero framework entries for them. ⚠️ This is the sharpest open position and it is exactly where Stroq sits.
- **OWASP has no machine-readable ID list.** The Top 10 repo is ten markdown files under `NOASSERTION`. MITRE ATLAS ships auditable, versioned YAML. ⚠️ **Therefore:** ATLAS is the spine; OWASP ASI is a secondary, hand-maintained, version-pinned layer.
- **AgentDojo disclaims comparability** in its own results page. ✔ **Therefore:** we publish no comparative ASR figure; we run `RepoGuardBench` and `RedCode` ourselves and say so.
- **Hooks are not an enforcement boundary.** Anthropic's own hooks documentation states hooks *"are not a permission enforcement mechanism"* and are disable-able via `disableAllHooks` or `bypassPermissions`. ✔ This applies to the entire hook-based category, Stroq included, and must be disclosed by us rather than discovered by a commenter.

---

## 2. Positioning

Stroq does not win a rule-count contest: `destructive_command_guard` (5,964★) and `cc-safety-net` (1,536★) own the destructive-command surface and evaluate each command independently, which is both their strength and their ceiling. What remains genuinely thin across the ~40 tools surveyed is content-derived taint (Pipelock has session taint but "no formal provenance graph"; open-edison taints from the tool *name*, not the result), string-level provenance attribution (the one OSS project with the right shape, `invariantlabs-ai/invariant`, has been stale since 2026-01 and its org was absorbed into Snyk, which kept the static scanner and dropped the runtime engine), and secret-*value* egress matching (Pipelock and Docker's `--block-secrets` are both pattern-based).

Those three are already built. The gap is not capability; it is that no number on the box describes them, and nothing shows an individual developer that the problem is theirs.

---

## 3. Part 1 — First-run repair

**Files.** `packages/cli/src/index.ts`, `packages/cli/src/commands/doctor.ts`.

- `stroq --version`, `-v` and `version` print the CLI version and exit 0. The version is read from the package manifest at build time so it cannot drift from the published artifact.
- `doctor` reports only agents whose config directory is present on the machine. An agent that is not installed produces no line at all. An installed agent without a Stroq hook is the only thing that may render `✘`. A `— not installed` neutral line is available behind `doctor --all` for support cases.
- `doctor` gains a first line: `stroq <version>`.

**Why it is Part 1.** E9 says these are the first two screens after `npx @stroq/cli init`, and E10 says the red wall appears on a correctly configured machine. 678 downloads in the last week passed through them.

---

## 4. Part 2 — `stroq exposure`

**New files.** `packages/cli/src/exposure/{surface,findings,report,redact}.ts`, `packages/cli/src/commands/exposure.ts`.
**Reused.** `commands/{doctor,mcp-config,init,cursor-hooks,codex-hooks,copilot-hooks,windsurf-hooks,openclaw-plugin}.ts` for discovery; `attack/run.ts` for the replay; `engine-factory.ts` for the user's real policy; `@stroq/core` `scanContent` and `loadBundledRules`.

### 4a. What it inventories

| Block | Source of truth | Finding classes |
| --- | --- | --- |
| A. Agents | config dir presence + the existing per-agent `isStroq*` checks | `agent-unprotected` |
| B. MCP | `mcpConfigPath` × 4 clients; `countWrapped` | `mcp-unwrapped`, `mcp-http-unreachable` |
| C. Instruction supply chain | `~/.claude/skills/**/SKILL.md`, `.claude/skills/**`, `~/.claude/plugins/**`, `{~/.claude,.claude}/agents/*.md`, `{~/.claude,.claude}/commands/*.md`, `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, `GEMINI.md`, plus non-Stroq hook handlers in every agent config | `context-flagged`, `hook-foreign` |
| D. Privilege-widening keys | the enumerated key set from §1 | `privilege-widened` |
| E. Reality check | `attack/run.ts` against the user's real policy, each scenario gated by whether the agent it targets is actually protected | `incident-reaches-you` |

Block C scans with `scan_target` scoping (Part 4a) so it does not reproduce E1's 11%. Until Part 4a lands, block C reports counts and the flagged-file list behind `--verbose` only, and does not put flagged files in the headline — an honest ordering, because shipping E1's noise as a headline finding would be the exact false-positive failure this spec exists to fix.

### 4b. MCP probing

Default is files only: nothing is executed. `--probe` additionally starts each stdio server through the existing proxy machinery, issues `tools/list`, scans the returned tool descriptions, and shuts the server down. `--probe` is never implied by any other flag. The report states plainly, in both modes, which mode produced it, because a tool-poisoning finding is only possible under `--probe` and its absence must not read as a clean bill.

### 4c. Output

Two modes. The default prints the full report with real paths, server names and file names. `--share` prints the same structure through a **whitelist** redactor: only counts, finding classes, agent product names, rule ids and taxonomy ids survive. Paths, server names, file names, hostnames, usernames and any content excerpt are dropped by construction rather than by pattern — `redact.ts` builds the shareable record from typed fields, so a new field is absent from `--share` until someone adds it deliberately. `--json` emits the full record; `--json --share` emits the redacted one.

Every finding carries a `fix` string that is a runnable command where one exists (`stroq init --agent cursor`, `stroq init --agent mcp --client cursor`).

### 4d. Exit code

`0` when there are no findings, `1` when any finding is present. This makes `stroq exposure` usable in CI and in a pre-commit hook without a wrapper.

---

## 5. Part 3 — Scenario matrix, mutation fuzzer, coverage artifact

### 5a. Corpus

`packages/cli/src/attack/scenarios/corpus.json` grows from 13 recorded incidents into a matrix over three axes — **origin** (web fetch, repo file, dependency content, MCP result, MCP tool description, skill/subagent markdown, instruction file, command output, image, PDF, issue/PR body, issue/PR *title*, CI log, filename), **encoding** (plain, base64, hex, rot13, homoglyph, invisible, bidi, HTML comment, markdown link title, split, non-English, code comment, format-mimicry), and **effect** (exec, credential exfil, source exfil, supply-chain persistence, self-tamper, destructive, silent policy weakening, data poisoning of future sessions).

Each scenario keeps its existing shape and gains two fields: `atlas` (an array of canonical `AML.T####[.###]` ids) and `asi` (an array of `ASI01`–`ASI10`). Recorded incidents keep their `incident` citation; matrix cells with no public incident carry `incident: null` and a `class` description, and are counted separately in every report so a synthetic cell can never be presented as a documented attack.

### 5b. Mutator

New `packages/cli/src/attack/mutate.ts`. Deterministic, seeded, no network. Each transformation is a pure `(text) => text` with a stable id. The initial set is the 21 from E3 plus, from the research: Variant Selectors VS1–VS256, `U+2062`/`U+2064` binary encoding, single invisible character inserted *inside* a word, UTF-16 surrogate re-formation, emoji smuggling, and nesting the payload at directory depth 2 (⚠️ arXiv:2608.14876 reports attack success peaking at 38% there versus 8.5% at depth 4 — single-source, unverified, but the design consequence holds regardless of the exact figures: scanning only the repo root is a gap).

A transformation may declare itself **semantics-preserving** or not. Only semantics-preserving mutations are asserted against; the rest are recorded and reported but do not fail the suite, because a mutation that destroys the payload proves nothing.

### 5c. `stroq attack --fuzz`

Runs every scenario through every applicable mutation and reports the shape below. The counts are illustrative of the format, not a target — the real numbers are whatever the corpus and mutation set produce.

```
stroq attack --fuzz: 41 scenarios x 28 mutations = 1148 variants, policy default
survived:  1131 / 1148   (98.5%)
escaped:     17
  09-polite-postinstall      rephrase-synonym      allow    (no rule, no class)
  09-polite-postinstall      polite-framing        allow    (no rule, no class)
  …
```

The escaped list is the deliverable, not the percentage. Exit 1 on any escape unless `--allow-escapes` is passed, so the number becomes a regression gate the moment Part 4 closes a gap.

### 5d. `stroq bench` — the false-positive number

Runs the rule set against a benign corpus and reports the false-positive rate. The corpus is vendored, Apache-2.0-compatible, and consists of real developer text of the kind E1 showed to be the failure distribution: documentation that talks *about* credentials, prompts, instructions and shell commands. `stroq bench --corpus <dir>` points it at the user's own files so anyone can reproduce the number on their machine rather than trusting ours.

This is the axis no vendor in the survey publishes. E1's 11.1% is the motivating measurement, not the published number: it was taken on a third-party skill library that we cannot vendor. The published figure is whatever `stroq bench` reports against the committed corpus, measured before Part 4a and again after, with both numbers and the method stated.

### 5e. `stroq coverage`

Emits the mapping as data, never as prose.

- `packages/cli/src/coverage/atlas-2026-08.yaml` — the vendored denominator, version-stamped, committed.
- `stroq coverage` prints a table of `covered | partial | not_covered` per technique with a `limitation` string on anything not fully covered, and prints uncovered items in the same summary line as covered ones.
- `stroq coverage --format=navigator` emits an ATT&CK-Navigator layer.
- The headline in README and on the site is a **depth** number we fully control — scenarios shipped — not a percentage. Readers derive any ratio themselves from the artifact. Atomic Red Team's practice: asked directly for a coverage percentage it declines and hands over a Navigator layer; its badge counts atomics and is rewritten by a bot on every push.
- A CI job regenerates the table and fails if the committed copy differs. No human types a coverage number anywhere in the repo. Pipelock's docs disagreeing with its own code on 6 of 10 categories is the failure mode this rule exists to prevent.

---

## 6. Part 4 — Structural gap closure

Ordered by the leverage the evidence assigns, not by difficulty.

### 6a. Wire `scan_target` (fixes E2, E8)

`tags.scan_target` survives compilation and gains a closed vocabulary: `tool_description`, `tool_result`, `instruction_file`, `repo_content`, `command_output`, `any`. `scanContent` takes the surface as part of `MatchContext` and skips rules whose `scan_target` excludes it. Every bundled rule is assigned a surface; `any` is the migration default only for rules where a reviewer confirms it. `ATR-2026-00161` becomes `tool_description`, which removes that rule's 194 file hits — an upper bound on the reduction in E1's 534 suspect files, since a file tripping it may trip another rule too.

### 6b. Privilege-widening writes as action classes (the primary bet)

New classes for writes to the enumerated key set of §1, in the existing `config.self` family, with deny/ask rules in both default policy copies. This is where the asymmetry pays: the key set is finite and near-zero-FP, while the injection text that motivates the write is unbounded.

### 6c. Package-install classes (fixes E5)

`npx <pkg>`, `pip install`, `uv add`, `gem install`, `cargo install`, `go install` and friends gain classes. With E7's provenance already recording the package name as an atom from the tool output that suggested it, the Sentry agentjacking shape becomes an `ask` with a named source at `clean` taint, not an `allow`.

### 6d. Precondition predicates (addresses E3's misses)

Engine-level predicates that do not look at prose: an instruction file that is untracked; an instruction file modified by a PR from a fork; an instruction file citing a binary asset as a source of procedure; a shell or package-install command appearing in an issue *title*. Each is a near-zero-FP structural signal for an attack class where content matching is provably blind.

### 6e. Recursive normalization

`normalizeText` becomes recursive (re-running until stable, so surrogate re-formation cannot survive it), strips orphaned surrogates, applies a Unicode confusables skeleton before matching, and covers Variant Selectors and `U+2062`/`U+2064` rather than the Tags block alone. Per the research FP table, the flagging policy differs by class: Tags and bidi controls are flagged unconditionally; ZWJ/ZWNJ require mid-ASCII-word position or a run threshold; VS15/VS16 and a leading BOM are excluded; base64 is decode-and-rescan enrichment only and never a standalone finding; HTML comments are not themselves a finding, only instruction-shaped content inside one from an untrusted origin.

### 6f. Re-tighten the clean-taint policy (fixes E6)

With 6a lowering the false-positive cost of tainting, revisit the six classes that are `allow` at `clean`. Each either moves to `ask` at `clean` or stays `allow` with the reason recorded in the policy file. This decision is made *after* `stroq bench` produces a number, so it is taken against measured noise rather than intuition.

---

## 7. What we deliberately do not build

An ML classifier in core; a gateway or proxy beyond the existing MCP stdio proxy; a Stroq-invented framework in place of ATLAS/OWASP; a coverage *percentage* on the box; any comparative AgentDojo figure; any telemetry — `stroq exposure`, `attack`, `bench` and `coverage` all run fully offline, and `--share` output is produced locally for the user to paste, never transmitted.

---

## 8. Limits to state publicly

- Hooks are not an enforcement boundary. Anthropic documents that hooks are not a permission enforcement mechanism and can be disabled with `disableAllHooks` or `bypassPermissions`. Stroq raises the cost of an attack and makes it auditable; it does not make an agent immune. This goes in README and SECURITY.md, not in a footnote.
- `--probe` executes the user's own MCP server commands. It is opt-in, it is named in the report, and its absence is never rendered as a clean result.
- The coverage artifact is a control mapping with evidence, not a compliance claim.
- Synthetic matrix cells are counted separately from documented incidents everywhere they appear.
- `stroq bench`'s number is ours, measured by a method we publish, on a corpus we vendor. It is not a third-party audit.

---

## 9. Sequencing

| Part | Working days | Why here |
| --- | --- | --- |
| 1 — first-run repair | 0.5 | Cheapest fix to the screens every installer sees. |
| 2 — `stroq exposure` | 4 | Visible user value early; reuses discovery that already exists. |
| 3 — matrix, fuzzer, coverage | 6 | Produces the escape list that tells Part 4 what to build. |
| 4 — structural closure | 5 | Closes what the fuzzer found; the fuzzer then becomes its regression gate. |

Part 3 before Part 4 is deliberate: the fuzzer's escape list is the specification for Part 4, and running it first means Part 4's work is measured rather than assumed.

---

## 10. Test strategy

**Part 1.** `--version`/`-v`/`version` print the manifest version and exit 0; `doctor` on a machine with one agent renders one agent line; `doctor --all` renders every agent; the version line is present.

**Part 2.** Surface discovery against fixture home and project directories for each agent and MCP client, including a machine with none installed (empty report, exit 0). Redaction: a property test asserting that no `--share` record contains any absolute path, home directory, MCP server name or file name drawn from the fixtures, plus a compile-time test that the shareable type is built field-by-field from the full record. `--probe` against a fixture stdio server that returns a poisoned tool description. Exit code 1 with findings, 0 without.

**Part 3.** Every mutation is a pure function with a round-trip or invariant test. Semantics-preserving mutations assert the scenario's expected outcome is unchanged; non-preserving ones assert only that they are excluded from the pass/fail tally. The corpus schema rejects a scenario with an ATLAS id absent from the vendored YAML, and rejects a synthetic cell that carries an `incident`. `stroq bench` is deterministic over the vendored corpus. `stroq coverage` output is regenerated in CI and the job fails on any diff against the committed copy.

**Part 4.** Each of 6a–6f gets rule-level and engine-level tests. 6a: a `tool_description` rule does not fire on `instruction_file` content, and the E1 corpus false-positive count drops measurably — asserted as a bound in `stroq bench`, not as an exact figure. 6b: each privilege-widening key is denied or asked, and a benign edit to the same file is not. 6c: `npx <pkg>` at `clean` taint with a matching provenance atom is `ask` naming the source; without an atom it follows the package-install rule. 6d: each predicate fires on its fixture and not on its negative control. 6e: recursive normalization converges, surrogate re-formation does not survive, and each FP-class rule from the table behaves as specified. 6f: the six E6 commands get their recorded decision at `clean`, with the policy reason asserted.

**Regression.** After Part 4, `stroq attack --fuzz` must exit 0 with no escapes, and that becomes a CI gate.
