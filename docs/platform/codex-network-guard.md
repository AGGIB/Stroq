# Codex Network Guard

Open **Agents & coverage → Codex → Network guard → Manage**. The Default tab starts with passive history. **Inspect settings** captures the selected Codex base user configuration and its source layers; it does not start Codex. **Preview network off** explains the exact change. Apply requires acknowledgement that the configuration is shared across projects and that recovery copies are retained locally.

The control has four bounded transformations:

| Existing configuration                                                | Guard change                                                   | Filesystem effect                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Explicit user default selects a user-defined named permission profile | Set that same profile's `network.enabled` to `false`           | Preserve the profile identity, selector, inheritance and filesystem rules                                     |
| Explicit `:danger-full-access` default                                | Create a network-off child of `:workspace`, then select it     | Strengthen to the workspace policy; refuse when compatibility with managed requirements cannot be established |
| Legacy `workspace-write` with `network_access=true`                   | Change that boolean to `false`                                 | Preserve roots, temporary-directory settings and filesystem policy                                            |
| Legacy `danger-full-access`                                           | Select legacy `workspace-write` and set `network_access=false` | Strengthen to the workspace policy, preserving its configured writable roots and temporary-directory settings |

Workspace policy can allow temporary directories and configured additional roots. It does not mean only the current project is writable. Already-off configurations can be checked without taking ownership or creating a Guard record. Mixed legacy/profile settings, winning project overrides, unresolved parents and unsupported native versions are refused. A named profile defined only in a system layer is currently inspectable but cannot be modified through this control.

## Configuration and measured enforcement

A confirmed Apply establishes an exact configuration write and readback. It does not prove adoption by an existing conversation. Named CLI profiles, session flags, project or managed settings can select different permissions. The interface keeps this distinction visible.

**Preview native check → Run check** is separate explicit authorization for a fixed local test. The server copies the inspected, already-network-off permission graph into an empty temporary Codex home and workspace. It runs a literal Node canary through the pinned native `codex sandbox` command, with no chat, prompt, model or provider request. The browser cannot supply executable paths, commands, profile names, endpoint addresses or CLI flags.

The test starts inert loopback TCP and Unix-socket listeners. An unsandboxed positive control must reach each listener exactly once. The sandboxed canary must attempt both connections and produce `EPERM` or `EACCES`, with zero accepted connections, before the report can pass. A bootstrap failure, timeout, missing control or incomplete evidence is inconclusive or failed. A connection that succeeds requires attention. Cancellation waits for bounded process termination and cleanup; a cleanup failure cannot become a passing or cancelled report.

Reports are historical evidence for the **isolated permission copy**, bound to configuration, source graph, native executable, Stroq runtime, copied profile and canary-suite fingerprints. They do not certify the current workspace, a running chat, MCP servers, connectors, browser/cloud tools, approved escalation or all possible local transports. The current suite measures TCP and Unix sockets only. Profiles needing unsupported proxy/operational fields are refused rather than copied incompletely. Managed policy outside observable files remains an explicit uncertainty.

Initial native compatibility is pinned to macOS `codex-cli 0.164.0-alpha.11.1`, SHA-256 `a04752e4d46a4d89e53e6f61c59c5349a638c8ce172ffbf391fd482b4d902a4e`, at the fixed official installed path. Passive inspection hashes the executable and pins its parents; it never invokes `--version` or searches PATH. Other builds receive a finite unsupported result until independently measured.

## Restore and recovery

History retains exact changes after a restart. **Preview restore** changes only the owned TOML fragment and requires separate acknowledgement of weakening network protection. Later unrelated settings and comments survive. A child-profile Restore keeps its inactive profile and owner marker, because other configuration may reference it.

An older operation cannot restore over a newer overlapping operation, even when boolean values cycle back or the newer operation was subsequently restored. Such records are permanently superseded. Unrelated profile targets retain independent ownership.

Every preview lasts at most 120 seconds and is one-use. A recognized Apply or Start consumes it before later consent, context, expiry or busy refusals. Unknown outcomes require **Recheck exact change/attempt**; there is no automatic write or test retry. Reads do not repair raw recovery records. Skill controls and Network Guard share the same user-wide writer lease and refuse outstanding recovery intent from either vault before another native-config write.

Native checks also hold exclusive workspace ownership through cleanup and durable terminal publication. Another console can inspect the retained attempt, but cannot cancel it or overwrite its status. Opening a console, reading history or preparing a preview never declares a retained worker stopped. A retained running job without verified ownership is state-unverified; only a new explicit Start under the exclusive lease may record an interrupted earlier attempt before admitting new work. A definite busy, stale or expired Start refusal consumes its preview without creating an unknown-outcome notice. Lost or malformed responses still require an exact recheck.

Protection reads configuration and check history passively. Changed or unavailable settings appear separately from the latest historical copied-policy result. **Inspect change** selects the exact retained record; **Inspect check** selects the exact workspace-bound attempt. Neither link starts a check or changes configuration. A passing historical report cannot hide later configuration drift or resolve an unknown write.

## Local retention and bounds

`USERHOME/.stroq/codex-network-guard` retains complete original/candidate user configuration, including any unrelated credentials it contains, plus transaction metadata. These copies are unencrypted, directories are mode 0700, and files are mode 0600. They have no automatic expiry or eviction. Limits are 32 records / 17 MiB including reservations and staging; reaching a limit refuses another change without discarding recovery evidence.

Private preview memory is bounded to eight plans / 8 MiB per action service. Native-check history stores only derived, validated results and fingerprints in its own workspace-bound private namespace, up to 32 jobs / 8 MiB. New checks may rotate terminal derived reports; they never evict raw Guard recovery records. Restart preserves unowned running evidence until explicit admission can establish exclusive ownership. Corrupt, replaced or unsafe history refuses new execution and is never overwritten for recovery.

The implementation is offline and local. Its intended adoption model follows the official [Codex permissions](https://learn.chatgpt.com/docs/permissions), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [CLI reference](https://learn.chatgpt.com/docs/cli/reference), with the stricter scope of the separately measured installed binary documented above.
