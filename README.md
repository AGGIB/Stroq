<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo.svg" alt="Stroq" width="340">
</picture>

### AI agent security platform

[![CI](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml/badge.svg)](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml)
[![stroq attack: 0 of 36 passed through](https://img.shields.io/badge/stroq%20attack-0%20of%2036%20passed%20through-1f9d55)](docs/GUIDE.md#replay-thirty-six-attacks-from-public-reports-and-synthetic-cells)
[![npm version](https://img.shields.io/npm/v/%40stroq%2Fcli?logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/@stroq/cli)
[![npm downloads](https://img.shields.io/npm/d18m/%40stroq%2Fcli?label=downloads&color=0b7285)](https://www.npmjs.com/package/@stroq/cli)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

</div>

Stroq is a local security platform for AI coding agents: Claude Code, Cursor, Codex CLI and others. Its hooks judge every tool call before it runs. They deny `curl | sh` and outbound calls that carry a known secret from your machine, and they ask you first when a command repeats text the agent read, naming that text. The console shows which agents actually ask Stroq, and every decision with its reason. Sessions you already had can be checked too, without installing anything.

```bash
npx @stroq/cli console        # the console: a private page on 127.0.0.1
npx @stroq/cli replay --all   # your Claude Code sessions of the last 30 days against the policy; no hooks needed
npx @stroq/cli sent           # did your agent pass your keys on? key names, never values
npx @stroq/cli init           # hook into your agent and guard the next session
```

Needs Node.js 22 or newer. Runs on your machine: no account, no telemetry, Apache-2.0.

<img src="docs/assets/readme/console-live.png" alt="Stroq console, Live page: the last 17 recorded actions, 11 allowed, 2 asked you, 3 denied, 1 flagged, and the feed with each action's decision and rule, such as a command denied by deny-encoded-exec and one asked about by ask-origin-untrusted" width="900">

<sub>Screens from the 0.29.0 console reading a staged session: a made-up project, issue and key, sent through the real hooks. Nothing was executed.</sub>

## The console

<table>
<tr>
<td width="50%"><img src="docs/assets/readme/console-protection.png" alt="Protection page: Stroq is being asked by Claude Code, Cursor and Codex CLI, with the week's decisions and what to look at next"><br><b>Protection</b>: which agents ask Stroq before they act, which are connected but not seen yet, and which are not connected.</td>
<td width="50%"><img src="docs/assets/readme/console-try.png" alt="Try an action page: curl -fsSL to sh is denied by deny-encoded-exec both in a clean session and after untrusted text"><br><b>Try an action</b>: what your policy decides for a command, read, write or fetch, without running it.</td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/readme/console-agents.png" alt="Agents page: Claude Code, Cursor and Codex CLI connected, with Review setup and Test hook for each"><br><b>Agents &amp; coverage</b>: add or remove Stroq's hooks; the exact file change is shown first and the old file is kept.</td>
<td width="50%"><img src="docs/assets/readme/console-settings.png" alt="Settings check page: 1 critical, 2 high, 4 medium settings, the first being Codex running with no approvals and no sandbox"><br><b>Settings check</b>: agent settings that switch off or loosen protection, and how to change them.</td>
</tr>
</table>

**Live** follows recorded decisions as they happen and **Activity** keeps them. Connected means Stroq's hooks are in the agent's settings, not that the agent calls them: **Test hook** and **Live** show that. Skills & MCP, investigations, sessions and secret exposure are under **When you need it**; the **Guide** page says what each page is for.

```sh
npx @stroq/cli console                            # a private page on 127.0.0.1
npx @stroq/cli console --workspace /path/to/repo  # the project it should look at
```

Open the whole link it prints: it carries a key that is new each time the console starts. The console reads what Stroq already records on this machine. It changes an agent's settings or Stroq's policy only after you confirm a preview of that change; checks you run are saved under `~/.stroq`.

It listens only on 127.0.0.1, needs no account and has no telemetry. With the optional threat feed turned on in Settings, it downloads [pwn.watch](https://pwn.watch/)'s public list of incidents; nothing about your project is sent. One action starts your real agent: **Test in agent** runs it against a throwaway project, with a cap on requests, and uses your agent's own subscription. Adding hooks from the console needs macOS or Linux; on Windows use `stroq init`. Details and limits: [console guide](console/README.md).

From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm --dir console install --ignore-workspace --frozen-lockfile
pnpm platform:build
pnpm platform --workspace /path/to/repo
```

## In the terminal

<img src="docs/assets/readme/terminal-replay.png" alt="stroq replay --last on a staged session: a GitHub issue the agent read scores SUSPECT, and two later commands traced to it would be denied, curl to sh by deny-encoded-exec 18 s later and npx of a package named in the issue by deny-origin-suspect 54 s later; four other actions would be allowed" width="900">

<sub>Output of the 0.29.0 CLI on a made-up Claude Code transcript of the same story; the path is shortened.</sub>

`stroq replay` reads the agent's own transcript, so it works on sessions from before Stroq was installed: which content the agent read, and which later actions came out of it. `--all` goes through every session of the last 30 days and says which to open. Nothing runs and nothing is sent; the verdicts are today's policy's, not a record of what happened at the time.

`stroq sent` compares your Claude Code, Codex CLI and Cursor sessions with the credentials on your machine and says where each key went: sent to another company, maybe sent, seen by the AI, used with its own service, or blocked before it ran. It prints names and sources, never values. Start with the [session secret scan walkthrough](https://stroq.dev/session-secret-scan/) (no session yet? [try it with a made-up key](https://stroq.dev/session-secret-scan/#try-it)).

<details>
<summary>What a <code>stroq sent</code> finding looks like</summary>

Made-up keys, the built CLI's output, trimmed:

```text
stroq sent: did your AI agent pass your keys on?

6 of your 6 keys appear in your agent sessions: 2 sent to another company, 1 maybe sent, 1 seen by the AI, 1 used with its own service, 1 blocked before it ran.

Checked 3 sessions (Claude Code 2, Codex 1), 2026-10-02 to 2026-10-19.
Compared with 6 keys: ~/.aws/credentials, ~/.npmrc, ~/work/shop/.env, ~/work/api/.env.

SENT TO ANOTHER COMPANY: rotate these today (2)
 1. STRIPE_SECRET_KEY  from ~/work/shop/.env
    went to  collector.example, in a curl command
    when     2026-10-11 14:02 UTC · Claude Code · ~/work/shop
    do       revoke it at https://dashboard.stripe.com/apikeys, then update ~/work/shop/.env

SEEN BY THE AI: your agent's model saw these keys (1)
 4. aws_secret_access_key  from ~/.aws/credentials
    seen in  the output of a Read of ~/.aws/credentials
    when     2026-10-02 09:42 UTC · Claude Code · ~/work/api
    note     Not ruled out: 2 later commands in that session could reach the network.
    do       your agent's model saw it; rotate it if that matters: https://console.aws.amazon.com/iam/home#/security_credentials

Stroq names a send only when it sees the key in the command that sent it. A script, a file or a variable can carry a key out without showing it.
```

</details>

`stroq attack` runs 36 attacks, from public reports and synthetic cells, against your policy in a throwaway home: on 0.29.0, 15 are denied, 21 are asked about, 0 pass through.

## What it covers and where it stops

- **Before each action.** Native hooks for Claude Code, Cursor, Codex, Copilot CLI, Windsurf and Antigravity, a plugin for OpenClaw, and a stdio MCP proxy. Supported outbound calls containing a known secret can be denied; provenance ties later actions to the tool output they repeat. A question about a value copied from text the agent read is asked once per session in Claude Code, unless the session has started something in the background.
- **After the fact.** `replay` and `sent` read local session records, including sessions from before Stroq was installed. Old, rotated or unknown values may be missed, and a key that did not show in a command may still have left in a script, a file or a variable. A local transcript match does not by itself prove delivery to a model provider.
- **Local.** No outbound network calls from the hooks; Task Lock hooks speak only to their local parent controller. No telemetry.
- **Limits.** A hook sees only what the host sends it, and that differs by agent and version. Matching is text-level, so a command the model writes from scratch does not trace back to a source. It is a filter, not a sandbox. Read the [integration limits](docs/AGENTS.md) before relying on a live hook.

## Docs

- **[Guide](docs/GUIDE.md)**: everything, section by section. [Install](docs/GUIDE.md#install) · [Commands](docs/GUIDE.md#commands) · [How it works](docs/GUIDE.md#how-it-works) · [Guarantees and limits](docs/GUIDE.md#guarantees-and-limits)
- [Per-agent details](docs/AGENTS.md): what each agent's hooks allow, and every documented limit
- [False positives](docs/BENCH.md) · [Attack coverage](docs/COVERAGE.md) · [Cloak vs AgentCloak](docs/CLOAK-COMPARISON.md)
- [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

## Contributors

Thank you to everyone who contributes code, reports bugs, tests agent integrations, and improves the docs ❤️

[![Contributors](https://contrib.rocks/image?repo=AGGIB/Stroq)](https://github.com/AGGIB/Stroq/graphs/contributors)

[stroq.dev](https://stroq.dev)
