# Stroq and a sandbox

Stroq is a filter, not a sandbox. The two do different jobs, and they do not get in each other's way.

| | A hook (Stroq) | Isolation (a separate user, a container, a VM, an agent's own sandbox) |
| --- | --- | --- |
| Where it stands | Between the agent and each tool call, reading what the agent is about to do | Around the agent and everything it starts |
| What it sees | The tool call as the host sends it: the command, the file, the URL | Whatever the operating system lets it see or stop |
| What a program started by the agent does | Not seen. `npm test` is `npm test` to a hook, whatever the tests do | Limited by the walls, whatever it does |
| What it knows | Why: which text the agent read before it, and which of your keys are in the command | What was reached, not why |
| What it costs you | One question when something looks wrong | Setting up the walls, and opening them when real work needs more |

**Use both when the risk is real.** A hook tells you the agent is about to send a key out because of something it read, and it can ask you first. Walls limit what a program does when nobody read what it runs. If you run code you did not write, such as a repository someone sent you, run it behind walls: a hook does not stop what that code does once it is running.

**Before you run a folder from someone else,** `stroq inspect` reads it and points at what runs by itself, what runs text it fetched, and what hides what it does. This is a reading of the files, not a run, so it can miss what is well hidden. See [Before you open a repository](GUIDE.md#before-you-open-a-repository).

## Stroq inside a sandbox around the agent

The host starts Stroq's hook, so a sandbox around the agent (Agent Safehouse, a `sandbox-exec` profile of your own, a container) holds the hook too. The hook needs its own folder, `~/.stroq`, to read and to write: the copy of the CLI that `stroq init` put there, the policy, the audit log and what it keeps for each session. A sandbox that leaves that folder out leaves Stroq unable to work.

[Agent Safehouse](https://agent-safehouse.dev)'s default policy for Claude Code grants `~/.claude` and not `~/.stroq`. This is what Stroq does when `~/.stroq` is closed as such a sandbox closes it, measured with `sandbox-exec` profiles of our own that close only that folder, not with Safehouse itself:

| `~/.stroq` in the sandbox | Installed with `npx @stroq/cli init`, or the plugin | Installed with `npm install -g @stroq/cli` |
| --- | --- | --- |
| Not granted | The hook cannot start: its code is in `~/.stroq`. With the line `stroq init` writes since this version, Claude Code blocks every call the hook is set for (shell commands, reads, edits, fetches, MCP calls) and shows "Stroq could not run". With a line an older version wrote, Claude Code takes the failure for a non-blocking error and runs the call, so Stroq is off: run `stroq init` again. | Every shell command, edit, fetch and MCP call is refused (reads pass), and the reason names the folder to grant. |
| Read only | Every shell command, edit, fetch and MCP call is refused: Stroq cannot keep its state. | The same. |
| Read and write | The hook works as it does without a sandbox. | The same. |

**So grant it read and write.** With Safehouse: `safehouse --add-dirs="$HOME/.stroq" claude`. The folder is then as open to the agent as it is without a sandbox, and the hook refuses an agent's own commands that change it, as it does outside one. To see that the hook runs, run `stroq doctor` in a terminal outside the sandbox after the agent has made a call: it says when each agent last called the hook.

**What Stroq does not do:** isolate anything. It does not limit a program's files, network or processes, and a command it allowed can do whatever your user can do.
