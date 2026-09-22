# AgentCloak and the Stroq MCP cloak, side by side

This compares **AgentCloak Desktop** (InCountry — free, closed source) with **`stroq mcp --cloak`**, shipped in this repository. They solve the same-shaped problem — do not let a third party's LLM see data it does not need — in two different places, and each is better than the other at things the other cannot do at all.

This document is written to be useful to someone deciding which one they need, not to sell either. Where AgentCloak is ahead it says so.

## The short version

- **AgentCloak protects a person talking to a chatbot.** It sits between you and ChatGPT Desktop, so everything you type and everything the model says back goes through it.
- **The Stroq cloak protects an agent talking to an MCP server.** It sits between the agent's MCP client and one stdio MCP server, so everything that server returns and everything the agent sends it goes through it.

If your problem is "I paste customer records into ChatGPT", AgentCloak is the answer and this is not. If your problem is "my coding agent queries a production database over MCP and every row lands in a model provider's logs", this is the answer and AgentCloak is not.

## Side by side

| | AgentCloak Desktop | `stroq mcp --cloak` |
| --- | --- | --- |
| **Channel** | Person ↔ ChatGPT Desktop, the whole conversation | Agent's MCP client ↔ one stdio MCP server |
| **What it protects from** | The model provider seeing what you typed or what it echoes back | The model provider seeing what a third-party server returned, and — for credentials — the third-party server receiving what it should not |
| **Who has to cooperate** | Nobody. It wraps the app you already use | The MCP client must launch stdio servers, which it already does |
| **Names (`Peter Parker`)** | **Yes**, anywhere | **In a labelled field, and anywhere in the same result once a field has named that person** — `{"first_name":"Peter","note":"call Peter"}` claims both. A name that NO field in the result names is not detected. See "Where AgentCloak is ahead" |
| **Street addresses** | **Yes** | **No** |
| **Email** | Yes | Yes |
| **Phone** | Yes | Yes, with an E.164 7–15 digit check; a bare unformatted digit run is deliberately not treated as a phone number |
| **URLs** | Yes | **No** — a URL carries action classification in Stroq (`origin.*` provenance, `shell.network`), so cloaking one would blind the firewall the cloak is bolted onto |
| **SSN / TIN** | Yes | SSN and ITIN, validated against the SSA allocation rules. **EIN (`NN-NNNNNNN`) is not detected** |
| **Bank accounts** | Yes | IBAN, validated with ISO 13616 mod-97 |
| **Payment cards** | Yes (as bank data) | Yes, Luhn-validated |
| **Exact credential values on this machine** | **No** — it has no index of your `.env`, `~/.aws/credentials`, `~/.npmrc`, `~/.netrc`, `~/.docker/config.json` or credential-shaped environment variables | **Yes** — `FileSecretIndex` already knows them, which is a stronger claim than any pattern can make. An `AKIA…` with no vendor prefix, a random 40-character password, a `.env` value with no recognisable shape: all detected because Stroq read the file |
| **Detection method** | Local model (NER) + deterministic rules | Deterministic only: exact-value lookup + regex with real validators (Luhn, mod-97, SSA rules, E.164) |
| **Languages** | EN + 6 others | Language-independent: what it detects in prose is a name the server itself spelled out in a field, matched literally, so a Kazakh or Japanese name works exactly as an English one does. That is not a feature, it is what "no NER" means |
| **Reversibility** | Local dictionary; originals substituted back into the reply | Local dictionary per (session, server), `0600`, **12 idle hours** then forgotten, 2000-entry LRU cap. `rm -rf ~/.stroq/cloak` removes every one |
| **Placeholder style** | Synthetic "digital twins" — `Peter Parker → Julio Schmidt` | Bracketed tokens — `[STROQ_EMAIL_1]`. See "Twins vs tokens" |
| **Audit trail** | Not documented | Every substitution appended to the hash-chained audit log (`stroq log`, `stroq verify`), **kind and placeholder only, never the value** |
| **Credential placeholder sent back out** | n/a — it has no notion of a credential | **Denied** (`mcp-cloak-secret-restore`). The value is never restored, because the model only ever saw the placeholder and restoring it would be an exfiltration Stroq itself performed |
| **Source** | Closed | Apache-2.0, in this repository |
| **Price** | Free | Free |
| **Interface** | Desktop app | A CLI flag on a proxy an installer writes for you |
| **Platforms** | Desktop app (Windows/macOS) | Anywhere Node 22 runs. Windows is untested for the proxy, as elsewhere in this project |

## Where AgentCloak is ahead

**An unlabelled name.** AgentCloak detects the two categories most people actually mean by "PII" wherever they appear, from the characters alone. Stroq needs the server to have **named the person somewhere in the same result**: an MCP result is JSON, so `{"first_name":"Peter"}` is claimed from the key rather than guessed — schema is a stronger claim than a model reading the same string, it costs no dependency, and it holds for names an English-trained model has never seen. A second pass then looks for that same person in the leaves nobody labelled, so `{"note":"call Peter about the invoice"}` in that result is claimed too.

What is left is the record that names a person only in free text — a support ticket whose body says "spoke to Peter Parker" with no `first_name` anywhere. AgentCloak gets that one; Stroq does not.

The second pass pays for itself with one narrow miss, and it is stated rather than hidden. A name that is also an ordinary English word — `Mark`, `Will`, `June` — is left alone **where a sentence begins**, because capitalisation cannot separate a person from a verb in the one position where every word is capitalised. `Mark the invoice as paid.` stays readable; `ask Mark about it` is cloaked. The field that named Mark is cloaked either way, so what is lost is a mention, not the record.

Why no NER: the credible offline option (GLiNER-PII through ONNX Runtime) would add this project's **first native runtime dependency** and break `npx @stroq/cli`, which is how most people meet this tool. That is the same call that made `stroq run --sandbox` shell out to `srt` rather than link it. It is also a call nobody here can currently make on evidence: two independent corpora on the machine this was built on — Cursor's 65 recorded MCP results and 299 more across 631 Claude Code transcripts — contain **zero** fields naming a person, so there is nothing local to measure a model's accuracy against, and a model evaluated only on fixtures its own author wrote is not evaluated. The detector interface (`CloakDetector`) exists so an NER pass slots in without touching anything else, but the dependency is not being added on spec.

**A consumer-grade desktop UI.** AgentCloak is an application a non-technical person installs and uses. This is a flag on a proxy in a JSON config that an installer edits, and the only way to see what it did is `stroq log`. If the person who needs protecting is not a developer, this is not for them.

**Breadth of channel.** AgentCloak covers an entire conversation, including everything the human types. Stroq's cloak covers exactly one MCP server's `tools/call` traffic. Anything the agent reads from a file, fetches from the web, or gets out of a shell command reaches the model in the clear — Stroq *scans* all of those and taints the session on what it finds, but it does not, and structurally cannot, redact them (see below).

**More languages.** Seven against a different thing entirely: Stroq reads prose only for names a field already spelled out, so it is language-independent where it works and blind where no field named anyone, in every language equally.

## Where the Stroq cloak is ahead

**It knows your actual secrets, not secret-shaped strings.** The secret index has already read this machine's credential files to hash their values. So a `.env` password that looks like nothing in particular is detected on sight, where a pattern-based detector has no way to know it from any other 32-character string. This also produces a protection AgentCloak has no analogue for: a `[STROQ_SECRET_n]` placeholder is **never** restored, and a call carrying one is blocked with the credential named and its value absent.

**It is the same guard the agent already has.** The cloak runs inside a firewall that is already classifying the call, checking provenance, tainting the session and enforcing a policy. A cloaked result is still scanned for prompt injection first — cloaking runs after, so `stroq log` records what the server actually sent rather than what Stroq made of it.

**Cross-agent by construction.** It is not tied to one product. Any MCP client that launches stdio servers — Claude Desktop, Claude Code, Cursor, Windsurf — gets it from the same install, because it wraps the server rather than the client.

**Every substitution is auditable, and the audit cannot hold a value.** `CloakEvent` has four fields and none of them can carry one. The entries are inside the same hash chain `stroq verify` checks.

**Open source.** You can read exactly which regex fired and where the dictionary lives, and the failure modes below are written down rather than discovered.

**Bounded, forgetful storage.** The dictionary expires after 12 idle hours, caps at 2000 entries, and is one file per server so a placeholder from server A can never resolve inside a call to server B. AgentCloak documents "keeps a local dictionary" and not much more.

## Twins vs tokens

AgentCloak replaces `Peter Parker` with `Julio Schmidt`. We replace `peter@bugle.example` with `[STROQ_EMAIL_1]`. Both are defensible and they are optimising for different readers.

A **twin** keeps the text natural, which matters when a human is reading the model's reply and when the model's reasoning depends on the value looking like what it is. Its cost is that nothing in the text says a substitution happened: a model told `Julio Schmidt` has no way to know, and if the mapping is lost the text silently means something false.

A **token** is unmistakable. The model can be told, in the same result, that a substitution happened and that echoing the placeholder verbatim is how to act on the value — which is exactly what the cloak's notice block does. For an agent that will feed the value back into a tool call, that round trip is the whole point, and it needs the model to treat the placeholder as an opaque handle rather than as data. A token also fails loudly: a placeholder that cannot be resolved arrives at the server as `[STROQ_EMAIL_9]`, which is visibly wrong, where an unresolved twin would arrive as a plausible wrong name.

Twins are the better choice for a person reading a chat. Tokens are the better choice for an agent driving a tool.

## What neither of them does

**Hook adapters cannot do this, and we are not going to pretend otherwise.** Stroq protects seven coding agents through hooks, and none of those integrations can redact anything. On Claude Code, `PostToolUse` is read-only — there is no field that replaces a tool result. The obvious workaround, rewriting the `Read` through `PreToolUse.updatedInput` and handing the agent a redacted copy, **corrupts user data**: the agent reads `.env`, receives `[EMAIL_1]`, edits the file, and writes the placeholder into the real `.env`. AgentCloak never faces this because it owns the whole human→LLM→human channel. A coding agent runs arbitrary model behaviour between the read and the write.

So: a file your agent reads, a page it fetches and a command's output all reach the model in the clear, under both products. Stroq scans them and taints the session on what it finds; it does not redact them.

## How to turn it on

```bash
npx @stroq/cli init --agent mcp --client claude-desktop --cloak
```

Restart the client. `stroq log` then shows a `cloak(cloak)` line for every result it rewrote and a `cloak(uncloak)` line for every call it restored, naming placeholders and never values. Re-run the same command without `--cloak` to switch it off; `rm -rf ~/.stroq/cloak` removes every dictionary.

Full design, including every limit: [`superpowers/specs/2026-09-21-mcp-cloak.md`](superpowers/specs/2026-09-21-mcp-cloak.md).
