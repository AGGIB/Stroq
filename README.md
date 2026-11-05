<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo.svg" alt="Stroq" width="340">
</picture>

### Who is really in charge of your agent?

[![CI](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml/badge.svg)](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml)
[![stroq attack: 0 of 36 passed through](https://img.shields.io/badge/stroq%20attack-0%20of%2036%20passed%20through-1f9d55)](docs/GUIDE.md#replay-thirty-six-attacks-from-public-reports-and-synthetic-cells)
[![npm version](https://img.shields.io/npm/v/%40stroq%2Fcli?logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/@stroq/cli)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

</div>

Stroq reads your own Claude Code and Codex sessions and shows how many commands came from text your agent read, and which keys left your machine.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/card-dark.png">
  <img src="docs/assets/readme/card.png" alt="The Stroq card in a terminal, on an example machine: Hoo, an orange pixel owl, beside the counts for 30 days of agent sessions (105 commands your agent ran, 1 that came from text it read, 1 key that left the machine, 1 repo that runs code as soon as an agent opens it) and three moments worth a look, each with a stroq show line" width="800">
</picture>

<sub>An example: a made-up machine with made-up sessions, keys and hosts. Hoo is Stroq's owl. Your card shows your own sessions.</sub>

```bash
npx @stroq/cli
```

It reads your last 30 days of sessions, your key files and the folders your agent worked in; prints key names, never values; writes nothing but a small cache under `~/.stroq`; and sends nothing. No account, no telemetry.

```text
npx @stroq/cli            a card of your own sessions, like the one above
npx @stroq/cli init       stop it next time: guard your agent
npx @stroq/cli why        why an action was stopped
npx @stroq/cli attack     watch Stroq stop 36 known attacks, in a sandbox
npx @stroq/cli uninstall  remove Stroq
```

Every moment on the card has a `stroq show` line that prints the evidence behind it (`npx @stroq/cli show 1`). `stroq help --all` lists the other commands. Needs Node.js 22 or newer. Apache-2.0.

## Beyond the card

Stroq is a local security platform for AI coding agents: Claude Code, Cursor, Codex CLI and others. Its hooks judge every tool call before it runs. They deny `curl | sh` and outbound calls that carry a known secret from your machine, and they ask you first when a command repeats text the agent read, naming that text. The console shows which agents actually ask Stroq, and every decision with its reason. Sessions you already had can be checked too, without installing anything.

```bash
npx @stroq/cli console        # the console: a private page on 127.0.0.1
npx @stroq/cli replay --all   # your Claude Code sessions of the last 30 days against the policy; no hooks needed
npx @stroq/cli sent           # did your agent pass your keys on? key names, never values
npx @stroq/cli init           # hook into your agent and guard the next session
```

<img src="docs/assets/readme/console-live.png" alt="Stroq console, Live screen: the last 8 recorded actions, 4 allowed, 1 asked you, 2 denied, 1 flagged, and a denied action opened into what the agent read, what it did, the decision and the rule" width="900">

<sub>A made-up machine: made-up sessions, keys and hosts. Nothing was executed.</sub>

## The console

<table>
<tr>
<td width="50%"><img src="docs/assets/readme/console-check.png" alt="Check screen: Hoo beside the card for 30 days of agent sessions, with the counts and the moments worth a look, each with its evidence"><br><b>Check</b>: the card of <code>stroq</code>, made by the same code. Each moment opens with its evidence, under it one line for each agent.</td>
<td width="50%"><img src="docs/assets/readme/console-live.png" alt="Live screen: the last 8 recorded actions, 4 allowed, 1 asked you, 2 denied, 1 flagged, and a denied action opened into what the agent read, what it did, the decision and the rule"><br><b>Live</b>: recorded decisions as they happen. A row opens into its chain: what the agent read, what it did, the decision, the rule.</td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/readme/console-agents.png" alt="Agents screen: Claude Code, Cursor and Codex CLI, each with Configure and Test hook, and the settings that weaken the agent, such as hooks switched off"><br><b>Agents</b>: add or remove Stroq's hooks, with the exact file change shown first. When Stroq was last asked, and which of an agent's settings weaken it.</td>
<td width="50%"><img src="docs/assets/readme/console-skills.png" alt="Skills and MCP screen: every skill and MCP server by agent, where it came from, what the rules matched in it and what changed since you last looked"><br><b>Skills &amp; MCP</b>: every skill and MCP server by agent: where it came from, what the rules matched in it, what changed since you last looked.</td>
</tr>
</table>

The fifth screen is **Rules**: try an action without running it, turn rules on with a preview and a test, the history with an undo, and the rules reference. Connected means Stroq's hooks are in the agent's settings, not that the agent calls them: **Test hook** and **Live** show that.

<sub>Screens from a build just before 0.30.0, reading a made-up machine: made-up sessions, keys and hosts. Nothing was executed.</sub>

```sh
npx @stroq/cli console                            # a private page on 127.0.0.1
npx @stroq/cli console --workspace /path/to/repo  # the project it should look at
```

Open the whole link it prints: it carries a key that is new each time the console starts. The console reads what Stroq already records on this machine. It changes an agent's settings or Stroq's policy only after you confirm a preview of that change; checks you run are saved under `~/.stroq`.

It listens only on 127.0.0.1, needs no account and has no telemetry. Nothing in it starts your agent: **Test hook** runs the hook once, offline. Adding hooks from the console needs macOS or Linux; on Windows use `stroq init`. Details and limits: [console guide](console/README.md).

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

`stroq attack` runs 36 attacks, from public reports and synthetic cells, against your policy in a throwaway home: on 0.30.0, 15 are denied, 21 are asked about, 0 pass through.

## What it covers and where it stops

- **Before each action.** Native hooks for Claude Code, Cursor, Codex, Copilot CLI, Windsurf and Antigravity, a plugin for OpenClaw, and a stdio MCP proxy. Supported outbound calls containing a known secret can be denied; provenance ties later actions to the tool output they repeat. A question about a value copied from text the agent read is asked once per session in Claude Code, unless the session has started something in the background.
- **After the fact.** `replay` and `sent` read local session records, including sessions from before Stroq was installed. Old, rotated or unknown values may be missed, and a key that did not show in a command may still have left in a script, a file or a variable. A local transcript match does not by itself prove delivery to a model provider.
- **Local.** No outbound network calls from the hooks; the hook of an older Task Lock run speaks only to its local parent controller. No telemetry.
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
