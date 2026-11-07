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

**What Stroq does not do:** isolate anything. It does not limit a program's files, network or processes, and a command it allowed can do whatever your user can do.
