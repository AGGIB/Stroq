<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo.svg" alt="Stroq" width="340">
</picture>

### See what your agent already sent to the model

[![CI](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml/badge.svg)](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml)
[![stroq attack: all stopped](https://img.shields.io/badge/stroq%20attack-all%20stopped-1f9d55)](docs/GUIDE.md#replay-twenty-real-and-synthetic-attacks)
[![npm version](https://img.shields.io/npm/v/%40stroq%2Fcli?logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/@stroq/cli)
[![npm downloads](https://img.shields.io/npm/d18m/%40stroq%2Fcli?label=downloads&color=0b7285)](https://www.npmjs.com/package/@stroq/cli)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

</div>

Coding agents read files and run commands all day, and every tool result goes to the model provider. Stroq tells you which of your credentials went with it, then guards the next session.

```bash
npx @stroq/cli sent --last   # which of your credentials already reached the model, no install
npx @stroq/cli init          # hook into your agent and guard the next session
```

<img src="docs/assets/case-study.gif" alt="An agent fixing a bug runs a helper package named in a GitHub issue, reads .env, and POSTs an AWS secret key to an unknown collector. stroq replay --last traces both commands back to that issue, and with Stroq installed the request is denied by deny-secret-egress, naming the variable, the file and the issue it came from." width="820">

<img src="docs/assets/demo.gif" alt="stroq replay --last on a recorded session: a poisoned README scores SUSPECT and the curl | sh it dictated is denied 12 seconds later; an npx command copied from an MCP result is asked about and traced back to it; an unrelated pnpm test is allowed" width="800">

- **Looks back.** `stroq sent` reads the sessions Claude Code, Codex CLI and Cursor already keep on disk, including ones from before Stroq was installed, and prints names and files, never values.
- **Guards what's next.** Native hooks for Claude Code, Cursor, Codex, Copilot CLI, Windsurf and Antigravity, a plugin for OpenClaw, a proxy for any MCP client. A known secret can't leave in an outbound command or MCP call, and a command copied from something the agent just read is asked about or denied, with the source named.
- **Local.** No network calls from the hooks, no telemetry. Apache-2.0.

## Docs

- **[Guide](docs/GUIDE.md)**: everything, section by section. [Install](docs/GUIDE.md#install) · [Commands](docs/GUIDE.md#commands) · [How it works](docs/GUIDE.md#how-it-works) · [Guarantees and limits](docs/GUIDE.md#guarantees-and-limits)
- [Per-agent details](docs/AGENTS.md): what each agent's hooks allow, and every documented limit
- [False positives](docs/BENCH.md) · [Attack coverage](docs/COVERAGE.md) · [Cloak vs AgentCloak](docs/CLOAK-COMPARISON.md)
- [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

[stroq.dev](https://stroq.dev)
