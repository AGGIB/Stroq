# Skills & MCP

**Skills & MCP** (`/skills/`) is one screen for every skill and MCP server your agents can load.

## The list

By agent (Claude Code, Claude Desktop, Cursor, Codex, Windsurf and Devin, and sources shared between
agents): what it is, where it came from (the fixed source and scope), what the bundled rules matched in
it ("rule hits"), and what changed since you last looked (new, changed, missing, unchanged). The list is
read when the screen opens and when you press **Check again**. Nothing watches it: the five-minute
watch of earlier versions is gone from the page, and the server no longer creates or starts it, so no
timer reads these sources while the console runs.

## Changes

A row opens the item. What can be done to it, when the agent and the source support it:

- **Route an MCP server through Stroq** (strict stdio proxy, optionally with tool review), and remove
  one registration from its source.
- **Pause or resume** new tool calls of a server routed through Stroq.
- **Move a skill out of discovery** (quarantine) for a complete, isolated skill folder.
- **Mark a version reviewed**, which records a baseline for later comparison and grants no trust.

Every change goes the same way, and the item says so before any of them: **preview** (nothing is
written), **apply** (exactly the preview that was shown, and only that) and **undo** (from the part
below that keeps the record of that kind of change). An action that cannot be made honestly for a given
item says why instead of offering a button.

## Parts under the list

Closed until asked for, and reading nothing until then. The address names the part
(`/skills/?part=<name>`), because the deep-link values of the parts share names and only one part reads
them:

| Part | `part=` | What it holds |
|---|---|---|
| Undo: skills moved aside | `quarantine` | Retained skill versions, recheck of their folders, restore |
| Undo: MCP changes, and pause or resume | `registrations` | Registration history, recovery copies, restore, the paused and running servers |
| Approve MCP tool versions | `tools` | The tool versions a server announced, approve or revoke each exact version |
| Check a skill's text | `check` | Paste or open a text and see whether it reads like an instruction to the agent. Nothing is run. `stroq vet` checks a folder from a terminal |

The older addresses `/skills/quarantine/`, `/skills/mcp/`, `/skills/mcp/contracts/` and `/skills/scan/`
lead to their part, and carry the record or tool version they named when it is still a value that part
reads back.
