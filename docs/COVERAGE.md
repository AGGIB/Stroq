<!--
  GENERATED FILE. Do not hand-edit.
  Produced by `pnpm generate:reports` from `stroq coverage`'s own output.
  Refresh it with `pnpm generate:reports`; `pnpm check:reports` fails CI if
  this file and the command's live output disagree.
-->

# Stroq coverage

Stroq's control mapping against MITRE ATLAS 2026.08 and OWASP ASI 2026: which in-scope techniques the attack corpus's scenarios evidence, and which do not.

This is a control mapping with evidence, not a compliance claim. `covered` means at least one scenario in `stroq attack` exercises the technique end to end with no stated limitation; `partial` means a scenario exercises it but a recorded limitation narrows what that evidence proves; `not covered` means no scenario tags it yet, whatever the scope declaration below says about the surface — a stated limitation on an untagged technique is a claim about the surface, not evidence the corpus proves it.

Which techniques are in scope for a local, hook-based action firewall at all, and why the rest of the vendored ATLAS denominator is not, is declared in [`packages/cli/src/coverage/scope.json`](../packages/cli/src/coverage/scope.json), with its method documented in [`packages/cli/src/coverage/SCOPE.md`](../packages/cli/src/coverage/SCOPE.md).

Reproduce this table with `stroq coverage`, or load the same mapping into MITRE ATT&CK Navigator with `stroq coverage --format=navigator`.

```text
stroq coverage — 20 scenarios (12 documented, 8 synthetic) · ATLAS 2026.08 · OWASP ASI 2026

AML.T0010        not covered AI Supply Chain Compromise (-)
    limitation: Stroq sees the agent’s own install or load of a supply-chain artifact (a package, model, container image, or tool); compromise introduced before the agent ever touches the artifact (e.g. at the origin registry) is addressed under supply-chain staging, not here.
AML.T0010.001    partial     AI Software (04-s1ngularity-public-repo, 19-dependency-postinstall-persistence)
    limitation: Covers the package-install and load commands the agent runs; a compromised dependency pulled in transitively by another tool without the agent’s own visible install step is not separately detected.
AML.T0010.003    not covered Model (-)
    limitation: Covers the agent’s own download and load of a model file; whether the loaded weights are themselves poisoned is a model-attack-surface question this file cannot answer, only that the load and any embedded executable payload are visible.
AML.T0010.004    not covered Container Registry (-)
    limitation: Covers a `docker pull` or equivalent the agent runs; an image pulled by a CI/CD pipeline outside the agent’s own tool calls is invisible.
AML.T0010.005    not covered AI Agent Tool (-)
    limitation: Covers installing or connecting a poisoned tool through the agent’s own tool calls; a tool added directly through an IDE or platform UI outside those calls is not seen.
AML.T0011        not covered User Execution (-)
    limitation: Covers execution the agent itself triggers via a tool call; execution a human user triggers directly, outside the agent, is not this product’s surface.
AML.T0011.000    not covered Unsafe AI Artifacts (-)
    limitation: Covers the agent loading or executing the artifact via a tool call; a runtime that deserializes the artifact internally, with no distinct tool call for the load, is invisible.
AML.T0011.001    partial     Malicious Package (02-sentry-agentjacking)
    limitation: Covers the install and any immediate execution the agent’s tool calls perform; a package that behaves maliciously only long after install, with no further agent-visible action, is not caught at install time.
AML.T0011.002    not covered Poisoned AI Agent Tool (-)
    limitation: Covers invocation of the poisoned tool through the agent’s own tool-call channel; a tool that behaves normally when called but corrupts state elsewhere with no reflected content is not distinguishable from a benign one.
AML.T0050        partial     Command and Scripting Interpreter (01-readme-pipe-to-shell, 10-skill-base64-installer, 15-issue-title-pipe-to-shell, 17-ci-log-instruction, 18-filename-instruction, 20-pdf-text-exec)
    limitation: Covers commands submitted through the agent’s own shell or interpreter tool call; a command an interpreter runs internally, without a distinct tool-call boundary, is invisible.
AML.T0051        not covered LLM Prompt Injection (-)
    limitation: Covers injected instructions in content the agent reads back through a tool call; instructions injected purely in a user’s own conversational turn, never touching a tool, are not this surface.
AML.T0051.000    not covered Direct (-)
    limitation: Direct injection happens in the user’s own prompt to the model, a channel Stroq’s hooks do not see; Stroq can only act once the injected instruction drives a subsequent tool call.
AML.T0051.001    covered     Indirect (01-readme-pipe-to-shell, 02-sentry-agentjacking, 04-s1ngularity-public-repo, 06-env-dump-exfil, 07-settings-hook-removal, 10-skill-base64-installer, 11-fetched-page-ssh-key-upload, 14-agents-md-invisible-hook-disable, 15-issue-title-pipe-to-shell, 16-issue-body-html-comment-exfil, 17-ci-log-instruction, 18-filename-instruction, 19-dependency-postinstall-persistence, 20-pdf-text-exec)
AML.T0051.002    not covered Triggered (-)
    limitation: Covers the triggering event when it arrives as tool-call content (a file change, an incoming message ingested via a tool); an event source entirely outside any tool call is invisible.
AML.T0068        partial     LLM Prompt Obfuscation (10-skill-base64-installer, 14-agents-md-invisible-hook-disable)
    limitation: Stroq’s normalization pipeline targets the known obfuscation classes (hidden text, encoding, confusables); its own mutation fuzzer has already demonstrated encodings that evade it, so this is a claim of intent to detect, not of catching every encoding.
AML.T0078        not covered Drive-by Compromise (-)
    limitation: Covers the case where the malicious page is fetched by the agent as ordinary web content and its prompt injection is evaluated like any other; a browser exploit unrelated to AI content, or a page visited by the human directly, is outside this product’s surface.
AML.T0093        not covered Prompt Infiltration via Public-Facing Application (-)
    limitation: Covers the moment the planted content is later read back by the agent through a tool call; the initial planting on the public-facing application itself is not something a developer’s local hook observes.
AML.T0094        not covered Delay Execution of LLM Instructions (-)
    limitation: Stroq evaluates each tool call independently and does not track that a delayed instruction seen earlier in a session is about to fire; a rule that would catch the instruction immediately can still miss it once its execution is deferred past the point of first exposure.
AML.T0123        not covered Obfuscated Files or Information (-)
    limitation: Same limitation as prompt obfuscation: Stroq’s normalization and decode-and-rescan logic targets known encodings, and its own fuzzer has shown specific encodings that currently evade it.
AML.T0053        not covered AI Agent Tool Invocation (-)
AML.T0086        covered     Exfiltration via AI Agent Tool Invocation (03-token-in-mcp-comment, 05-roguepilot-schema-url, 06-env-dump-exfil, 11-fetched-page-ssh-key-upload, 13-padded-secret-exfil, 16-issue-body-html-comment-exfil)
AML.T0101        covered     Data Destruction via AI Agent Tool Invocation (08-rm-rf-home, 09-drizzle-force-push, 12-parent-dir-wipe)
AML.T0108        not covered AI Agent (-)
    limitation: Stroq evaluates each tool call the compromised agent makes on its own merits (a fetch, then a destructive or exfiltrating action); it does not itself recognize a fetch-and-execute loop as a C2 beacon pattern across a session.
AML.T0080        not covered AI Agent Context Poisoning (-)
    limitation: Covers poisoning delivered through content the agent reads via a tool call; poisoning injected purely through direct conversation with no tool-call boundary is not this surface.
AML.T0080.000    not covered Memory (-)
    limitation: Covers a memory write that flows through a tool call Stroq can inspect; a memory feature implemented as an opaque internal model state with no corresponding tool call is invisible.
AML.T0080.001    not covered Thread (-)
    limitation: Covers thread content the agent reads back through a tool call; instructions injected purely as user conversation turns are not visible to a hook that only sees tool calls.
AML.T0081        partial     Modify AI Agent Configuration (07-settings-hook-removal, 14-agents-md-invisible-hook-disable, 19-dependency-postinstall-persistence)
    limitation: Covers the one configuration surface the corpus currently exercises — the `hooks` block of `.claude/settings.json`, overwritten via a `Write` tool call; the technique's own description also spans the system prompt, knowledge sources, and other connected-tool settings, none of which any scenario in the suite currently drives through this technique.
AML.T0083        not covered Credentials from AI Agent Configuration (-)
    limitation: Covers the agent’s own read of its configuration file through a tool call; credentials extracted by a process outside the agent’s tool-call surface (e.g. a separate script reading the same file) are invisible.
AML.T0084        not covered Discover AI Agent Configuration (-)
    limitation: Covers configuration discovered by reading a file through a tool call; configuration details volunteered by the model when a user simply asks it questions, with no tool call involved, are not visible.
AML.T0084.000    not covered Embedded Knowledge (-)
    limitation: Same limitation as the parent: visible only when discovery happens via a file or tool-call read, not via conversational questioning of the model.
AML.T0084.001    not covered Tool Definitions (-)
    limitation: Visible when tool definitions are read from a configuration file via a tool call; definitions the model recites from its own loaded context, with no corresponding file read, are not visible.
AML.T0084.002    not covered Activation Triggers (-)
    limitation: Visible when trigger configuration is read via a tool call; triggers inferred purely by observing agent behavior over time are not something a per-call hook reconstructs.
AML.T0084.003    not covered Call Chains (-)
    limitation: Visible when call-chain information is read from configuration or source files via a tool call; chains inferred by static analysis of code never read through the agent’s own tools are not covered.
AML.T0070        not covered RAG Poisoning (-)
    limitation: Covers the poisoned content once the agent’s tool retrieves and surfaces it for the model to read; the initial placement of that content into the RAG store is a separate action outside the developer’s machine.
AML.T0071        not covered False RAG Entry Injection (-)
    limitation: Same limitation as RAG Poisoning: Stroq sees the retrieved content when a tool surfaces it, not the injection into the RAG store itself.
AML.T0082        not covered RAG Credential Harvesting (-)
    limitation: Covers the retrieval tool call and the credential-shaped content it returns; credentials mixed into a huge, unremarkable-looking retrieval result may not be distinguishable from ordinary document content by a content rule alone.
AML.T0085        not covered Data from AI Services (-)
    limitation: Covers data movement visible through the agent’s own tool calls to connected services; data the AI service itself discloses through a channel outside any tool call is not visible.
AML.T0085.000    not covered RAG Databases (-)
    limitation: Same limitation as the parent: visible through the retrieval tool call and its returned content, not through any other access path to the RAG store.
AML.T0085.001    not covered AI Agent Tools (-)
    limitation: Same limitation as the parent: visible through the tool invocation itself, not through any access path outside the agent’s own tool calls.
AML.T0098        not covered AI Agent Tool Credential Harvesting (-)
    limitation: Covers credential-shaped content returned by a tool call Stroq inspects; credentials embedded in a format or encoding a content rule does not recognize may pass unflagged.
AML.T0099        not covered AI Agent Tool Data Poisoning (-)
    limitation: Covers the poisoned content once an agent tool retrieves it; the poisoning of the underlying data source itself happens outside the developer’s machine and is not directly observed.
AML.T0110        not covered AI Agent Tool Poisoning (-)
    limitation: Covers a poisoned tool’s effects once it is invoked or its response is read through a tool call; a tool’s static, model-visible description that is never reflected back through a hook-observed call may not be inspected at all.
AML.T0110.000    not covered Definition and Instructions (-)
    limitation: Stroq observes a tool’s invocation and its response, not necessarily the static tool definition or schema loaded into the model’s context at session start; a poisoned description that never causes an anomalous call or response can be invisible.
AML.T0110.001    not covered Implementation (-)
    limitation: Covers the tool’s actual invocation and response as Stroq sees them; hidden side effects that do not alter the visible request or response content (e.g. a silent blind-copy on an email send that never appears in the response) may not be distinguishable from normal use.
AML.T0110.002    not covered Runtime Response (-)
AML.T0037        not covered Data from Local System (-)
AML.T0055        not covered Unsecured Credentials (-)
    limitation: Covers credentials Stroq’s rules recognize by pattern (keys, tokens, known formats) in content a tool call returns; a credential in a format or location the rule set does not recognize will not be flagged.
AML.T0090        partial     OS Credential Dumping (06-env-dump-exfil)
    limitation: Covers credential material read through the agent’s own tool calls (files, command output); dumping performed by a separate process outside the agent, with no reflected content, is invisible.
AML.T0035        not covered AI Artifact Collection (-)
    limitation: Covers artifact collection performed through the agent’s own file and tool operations; Stroq cannot distinguish routine, legitimate bulk file handling from adversarial collection except by the content and destination involved.
AML.T0126        not covered Automated Collection (-)
    limitation: Same limitation as artifact collection: visible as a sequence of ordinary-looking tool calls, which a per-call hook does not aggregate into a pattern of automated collection on its own.
AML.T0025        partial     Exfiltration via Cyber Means (04-s1ngularity-public-repo)
    limitation: Covers the one channel the corpus currently exercises — a shell-invoked `gh repo create --push` publishing harvested data to a public repository; 'traditional cyber means' also spans exfiltration by direct HTTP request, DNS, email, or cloud-storage upload, none of which any scenario in the suite currently drives through this technique.
AML.T0034.002    not covered Agentic Resource Consumption (-)
    limitation: Stroq can flag an individual costly tool call but does not implement session-level rate-limiting or a budget; a large number of individually unremarkable calls induced across a long session is not aggregated into a single verdict.
AML.T0125        not covered Create Account (-)
    limitation: Covers account creation performed through the agent’s own tools (an IAM or platform API call); account creation through a channel outside the agent, such as a compromised admin console, is invisible.
AML.T0056        not covered Extract LLM System Prompt (-)
    limitation: Covers the case where the system prompt is extracted by reading a configuration file through a tool call; extraction induced through prompt injection that the model reveals only in its own conversational response is not visible.
AML.T0069        not covered Discover LLM System Information (-)
    limitation: Covers system information discovered by reading a file through a tool call; information volunteered by the model when a user simply asks it questions, with no tool call involved, is not visible.
AML.T0069.000    not covered Special Character Sets (-)
    limitation: Same limitation as the parent: visible only when discovered via a file or tool-call read, not via conversational probing of the model.
AML.T0069.001    not covered System Instruction Keywords (-)
    limitation: Same limitation as the parent: visible only when discovered via a file or tool-call read, not via conversational probing of the model.
AML.T0069.002    not covered System Prompt (-)
    limitation: Same limitation as the parent: visible only when the system prompt is read from a configuration file via a tool call, not when extracted through conversation with the model.
AML.T0074        not covered Masquerading (-)
    limitation: Covers file-metadata and type-masquerading content a tool call returns, the same surface as prompt obfuscation; reclaiming a stale, previously-trusted package or model namespace after it is deleted or renamed is adversary-side registry activity outside the developer’s machine and is not covered.

in scope: 59 techniques — 3 covered, 7 partial, 49 not covered

OWASP ASI 2026:
ASI01  Agent Goal Hijack — scenarios: 01-readme-pipe-to-shell, 02-sentry-agentjacking, 04-s1ngularity-public-repo, 06-env-dump-exfil, 07-settings-hook-removal, 11-fetched-page-ssh-key-upload, 14-agents-md-invisible-hook-disable, 15-issue-title-pipe-to-shell, 16-issue-body-html-comment-exfil, 17-ci-log-instruction, 18-filename-instruction, 20-pdf-text-exec
ASI02  Tool Misuse — scenarios: 03-token-in-mcp-comment, 05-roguepilot-schema-url, 08-rm-rf-home, 09-drizzle-force-push, 12-parent-dir-wipe, 13-padded-secret-exfil
ASI03  Identity & Privilege Abuse — scenarios: 03-token-in-mcp-comment, 04-s1ngularity-public-repo, 05-roguepilot-schema-url, 06-env-dump-exfil, 11-fetched-page-ssh-key-upload, 13-padded-secret-exfil, 16-issue-body-html-comment-exfil
ASI04  Agentic Supply Chain Compromise — scenarios: 01-readme-pipe-to-shell, 02-sentry-agentjacking, 04-s1ngularity-public-repo, 10-skill-base64-installer, 19-dependency-postinstall-persistence
ASI05  Unexpected Code Execution — scenarios: 01-readme-pipe-to-shell, 02-sentry-agentjacking, 10-skill-base64-installer, 15-issue-title-pipe-to-shell, 17-ci-log-instruction, 18-filename-instruction, 20-pdf-text-exec
ASI06  Memory & Context Poisoning — scenarios: 19-dependency-postinstall-persistence
ASI07  Insecure Inter-Agent Communication — not claimed by any scenario (structurally out of reach: needs a multi-agent system, and Stroq sits on one agent's tool calls)
ASI08  Cascading Agent Failures — not claimed by any scenario (structurally out of reach: needs a multi-agent system, and Stroq sits on one agent's tool calls)
ASI09  Human-Agent Trust Exploitation — not claimed by any scenario (out of observation: the attack suite replays hook events and never models a human approval step, so no scenario can honestly exercise it)
ASI10  Rogue Agents — not claimed by any scenario (not yet exercised: a gap in the corpus, not a statement about what Stroq can see)
```
