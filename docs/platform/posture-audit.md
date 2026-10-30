# Settings check

**Settings check** (`/posture/`) lists settings in your agents' own files that switch off or loosen
an agent's own checks: Claude Code hooks turned off, "run without asking" modes, allow rules for any shell
command, a repository that points your prompts at another server, and similar. It reads files. It
changes nothing, starts nothing and never shows a value from a file.

It exists because an agent's checks can be switched off by a setting, with no attack on Stroq at all.
A cloned repository can carry `disableAllHooks` in `.claude/settings.json`; a "just let it run" mode
can be left on for months. Stroq's other screens show what happened. This one shows what is
configured. A finding is a setting found in a file; whether it applies depends on the vendor's
precedence and trust rules, which this page does not work out.

## What it reads

A fixed list of 14 places. Nothing the browser sends picks a path.

| Agent       | Your own file                                                               | In this repository                                                     |
| ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Claude Code | `~/.claude/settings.json`                                                   | `.claude/settings.json`, `.claude/settings.local.json`                 |
| Codex       | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml` when that is absolute) | `.codex/config.toml`                                                   |
| Cursor      | `~/.cursor/cli-config.json`, `sandbox.json`, `permissions.json`             | `.cursor/cli.json`, `.cursor/sandbox.json`, `.cursor/permissions.json` |
| Windsurf    | `~/.config/devin/config.json`                                               | `.devin/config.json`, `.devin/config.local.json`                       |

The workspace is the folder the console was started for. Files may hold comments and trailing commas
(JSONC); Codex's file is TOML.

## What a finding is

Each finding is an **id**, the agent, where it was found (your file, a file in the repository, or your
local file in the repository) and, for allow lists, how many rules matched. Every word on screen comes
from a fixed catalog in `console/lib/posture.ts`: a title, why it matters, the setting to look for and
how to change it. So no command, path, URL, token or rule text from a settings file can reach the
page: a test plants such text in files and checks it is nowhere in the reply, and the page renders only
catalog text and counts. No automated test renders the page.

Severities: **Critical** (hooks off; no approvals and no sandbox), **High**, **Medium**, **Note**. They
order the list; repository-shipped settings come before the same kind in your own file, because a
repository you cloned can change them without you opening the file.

The 26 findings and the vendor key behind each are in the catalog. The keys and where each one is
honored were read from each vendor's public documentation on 2026-10-27; they were not tested against
the products, and vendors change them:

- Claude Code: `disableAllHooks`; `permissions.defaultMode` (`bypassPermissions`);
  `skipDangerousModePermissionPrompt`; broad `permissions.allow` (`Bash`, `Bash(*)`, interpreter and
  shell prefixes, `WebFetch`); `enableAllProjectMcpServers`; the helper commands (`apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`) and `env.ANTHROPIC_*` in a repository
  file; `sandbox.enabled`.
- Codex: `features.hooks`; `approval_policy`; `sandbox_mode` and `default_permissions`;
  `sandbox_workspace_write.network_access`; `projects."<path>".trust_level` on the home folder or a
  parent of it; the retired `approval_policy = "untrusted"`.
- Cursor: `approvalMode`; `permissions.allow` (`Shell(*)`, shells and interpreters, `WebFetch(*)`,
  `Mcp(*:*)`); `sandbox.json` `type` and `networkPolicy.default`; `terminalAllowlist` and
  `mcpAllowlist`.
- Windsurf (Devin local agent): `Exec(*)` style allow rules.

Rules that depend on where a setting sits are applied the way the vendor documents them. Claude Code's
settings reference says current versions ignore `bypassPermissions` from a project or local file, and
that versions before 2.1.257 honored it. So it is a high finding in your own file and a medium one,
with that caveat in its text, in a project or local file; the one-time bypass warning flag counts from
your own and local files. The sandbox
note is worked out from the file that wins (local, then project, then your own): if it turns the
sandbox on there is no note, and if a local or project file turns it off, the note names that file. Cursor's CLI only takes permissions at the project level, so
`approvalMode` in `.cursor/cli.json` is not reported. Codex trust is read only from your own file,
because a repository cannot trust itself.

## What it cannot see

Said on the page, so a clean result is not read as a clean bill:

- **Cursor's Run Mode** and **Windsurf's auto-execution level** live inside the apps, not in a file.
- **Flags for one run** (`--dangerously-skip-permissions`, `--yolo`, `--force`) leave nothing to read.
- **Settings pushed by an organization** (managed settings, requirements files) are not read.
- It does not work out which setting wins when files disagree, and it does not know whether a
  repository has been trusted. A setting in a repository file may have no effect until you trust the
  folder; the page still lists it, because it will take effect the moment you do.
- No findings means none of the checked settings were found. It does not mean an agent is configured
  well.

## How it reads files

`GET /api/posture`, no query, no body. The server opens only the 14 fixed paths, read-only:

- At most 256 KiB per file; a larger file is reported as _too large_, not cut.
- A regular file only. A named pipe, a device or a folder is refused without waiting on it.
- **A link anywhere in the path of a repository file refuses it.** The resolved path must equal the one
  built from the repository's own folder, so a link to somewhere else, or to another folder inside the
  repository, is refused. After opening, the name is resolved again and must still lead to the open
  file (same device and inode), which closes the gap where a folder is swapped for a link while the
  file is being opened. A link in your own home folder is followed, because dotfile managers do that.
  A repository file with a second name (a hard link, more than one link to it) is refused too; git
  cannot ship one, so one there was made on this machine.
- **A file that cannot be used is never a clean result.** A file that is too large, a link, not
  understood or not readable is named on the page, in its own block above the findings, and the
  Protection line says "N settings files could not be checked" instead of "no critical or high
  settings". Only a file that is not there is silent.
- When the workspace is your home folder, its files are your own and the repository places are
  skipped, so your own settings are not shown as a repository's.
- A parse error says only that the file could not be understood. The error text, which can quote the
  file, is dropped.
- Allow lists are bounded to 10,000 rules and 512 characters a rule, and rules are read with linear
  scans, so a hostile file costs a bounded, small amount of work and the reply stays small. A value
  that is not the expected type is ignored. Inherited properties are not settings.
- An allow rule counts as "open" only when a program that runs anything is allowed with any
  arguments (`python *`, `node:*`, `curl*`, `timeout 10 bash *`, `docker exec *`, `npm exec *`). A rule
  that names its arguments, such as `node scripts/build.js`, is narrow and is not counted. Cursor
  and Devin lists are prefixes by nature, so a program alone counts there.
- The reply is validated against a closed schema on the server and again in the browser.
- Requests that arrive while a read is under way share it; nothing is stored, and nothing is written
  under your home folder or the repository (a test lists both folders before and after).

## Where it lives

- Page: `console/components/platform/posture-check.tsx`, hook `use-posture.ts`; the catalog, wording,
  schema, ordering and fixed location labels in `console/lib/posture.ts`.
- Server: `console/scripts/posture-analyzers.ts` (pure checks, one function per file kind),
  `posture-reader.ts` (the safe bounded read), `posture-service.ts`, `posture-http.ts`, loaded through
  `workspace-monitor-bridge.mjs` with a fail-closed 503 fallback.
- Tests: `lib/posture.test.ts` (catalog wording, schema), `scripts/posture-analyzers.test.mjs`
  (positive and negative fixtures per agent, odd input), `posture-service.test.mjs` (links, pipes,
  oversize, nothing leaks, nothing is written) and `posture-http.test.mjs` (the real server).

## Not built yet

Reading the hook files themselves (`hooks.json`, `.cursor/hooks.json`) for hooks a repository adds, and
the MCP server files (`.mcp.json`, `.cursor/mcp.json`). Those are a different question: what runs, not
what is loosened.
