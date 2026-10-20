# Stroq plugin for Claude Code

Stroq checks each Claude Code tool call before it runs. It blocks a command that would send one of your keys out. It asks before the agent runs a package or a script it copied from something it just read, and it names that source. After a call, Stroq reads the output, so it can tell later where a command came from.

## What the plugin runs

Claude Code runs `hooks/stroq-hook.sh` (a bash script) before and after tool calls. The script starts Stroq in this order:

1. A `stroq` command already on your PATH.
2. Otherwise, a copy of the pinned version (`STROQ_PIN` in the script). The script installs it once into `~/.stroq/plugin-cli/<version>` with `npm install --ignore-scripts`.
3. Otherwise, the same pinned version through `npx`.

If npm does not have the pinned version yet (the hours after a release), the script runs the release before it (`STROQ_FALLBACK_PIN`). It never runs an unpinned version.

## What it downloads, sends and writes

- **Downloads:** the pinned `@stroq/cli` package and its two dependencies (`zod`, `yaml`) from registry.npmjs.org, once per version.
- **Sends:** nothing. The hook makes no network requests. There is no telemetry.
- **Writes:** only under `~/.stroq` (or `$STROQ_HOME`): the installed copy, a scratch folder (`plugin-tmp`), Stroq's audit log, per-session state, and an index of your keys. The index keeps salted hashes, never the key values.

## If Stroq cannot start

A call that has not run yet is blocked, so a broken install does not leave the agent unguarded. A call that already ran is let through, because there is nothing left to stop.

## More

- What a finding means and how to undo a block: [docs/GUIDE.md](https://github.com/AGGIB/Stroq/blob/main/docs/GUIDE.md)
- Check past sessions for your keys: `npx @stroq/cli sent --last`
- Source and license (Apache-2.0): [github.com/AGGIB/Stroq](https://github.com/AGGIB/Stroq)
