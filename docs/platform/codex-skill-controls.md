# Codex skill path controls

Open **Skills & MCP → Codex sources**, inspect an entrypoint, then choose **Disable this path**. Preview identifies the captured skill and configuration fingerprints. Applying requires separate acknowledgement of shared user settings and retained configuration copies. **Saved changes** remains available after the source disappears or the browser/server restarts; **Preview restore** removes Stroq's own declaration and requires separate weakening consent.

This writes one exact absolute `SKILL.md` path rule to the selected Codex data directory's **base user `config.toml`**. It also affects future versions at that path. Other same-name copies remain separate. Already-disabled paths are not taken over. Restore preserves later unrelated comments/settings and never invents an unconditional enable rule over an existing disable.

## Evidence and scope

The interface separates historical write confirmation, current base declaration and native adoption. A successful write is read back; it does not establish that an existing conversation forgot instructions. Start a new chat or restart Codex. Named profiles and session flags can override the base declaration. Direct file reads, copied instructions, alternative copies, managed/plugin/system skills and universal host blocking are outside this control.

Compatibility was measured offline against the official installed `codex-cli 0.164.0-alpha.11.1`. An exact document rule omitted only the selected copy from fresh discovery and locally assembled skill metadata; a containing-folder rule did not. This compatibility evidence applies to that binary and platform only. Normal page reads, preview and Apply never launch Codex.

## Guarded changes and recovery

Selection binds opaque context/source/candidate IDs and entrypoint/config/runtime digests. Fresh server capture and physical file/parent checks precede a write. TOML is strictly parsed before and after a token-aware insertion. Unknown, malformed, linked, unsafe, over-bound or contradictory input is refused. The browser cannot supply a path, command, configuration body or environment map.

Previews are one-use, last 120 seconds and are bounded to eight / 8 MiB private memory. A recognized Apply consumes its preview even when the request is subsequently refused. User-wide locking is independent of project and STROQ_HOME. Durable intent and staged identity precede publication; exact readback confirms the result.

A timeout or lost response can leave an unknown outcome. Use **Recheck exact change**; do not repeat Apply. GET never retries, repairs or clears unknown completion from absence. Interrupted restoration to an originally absent config remains unknown if later evidence cannot establish the historical removal. Unexpected moved bytes are preserved in a private holder, never silently deleted. Unfinished or orphan staging can block further writes across this user's control vault; reconnect the original data-directory context for recovery or inspect the retained local files. Context links never silently select a different profile.

## Local retention

The private vault is `USERHOME/.stroq/codex-skill-controls`, separate from the selected Stroq policy home. It retains complete original/candidate configuration bytes, which may include unrelated settings or credentials, plus guarded transaction metadata. Copies are **unencrypted**, without automatic eviction or expiry. Directories use mode 0700 and retained files 0600; linked and hardlinked files are refused. A private removal holder can also exist beside the selected Codex config during uncertain Restore.

Limits remain **32 records / 17 MiB physical storage and reservations**, including bounded staging. The byte limit can stop large records before the count limit. Configuration is bounded to 256 KiB and 512 skill rules. Reaching a bound refuses a new operation while retaining earlier recovery data.
