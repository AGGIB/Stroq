# Recorded installation diagnostics

**Protection → Check installation** explicitly runs the real offline `stroq doctor --json --all` against the selected workspace and user profile. It does not start an agent, use a model subscription, run an MCP server, rebuild the secret index or change hook settings. Its derived history is separate from authoritative current inspection in Agents & coverage.

The CLI's legacy `ok` means its installation-wide check passed. In particular, an absent agent can have `ok:true` when another agent is configured. It never established that the absent agent has hooks. The interface therefore shows **checks recorded**, not a count implying every named agent is protected.

When no agent registration was recorded, the result shows one compact setup gap with a current-settings chooser. Absent peers remain quiet when another agent carries the installation check; the per-scope rows stay available in details.

New reports attach finite typed facts at the producer, without parsing the human-readable `detail`:

- Agent hooks retain workspace/user scope and distinguish missing registration, missing events, changed or unrecorded registration, unreadable configuration, missing runtime, host approval, unsupported launch and shadowing. An absent agent remains **Not configured** even when its legacy aggregate check is OK.
- MCP facts distinguish unwrapped servers, missing wrapper runtime, inherited environment and unreadable configuration. Pinned launch, skill integrity and retained revision checks have fixed family labels instead of leaking dynamic server/skill names. Unknown individual source scope remains unspecified. Opening home as a workspace retains shared user scope where the MCP paths coincide.
- The sandbox compatibility note reports a conflict between pinned server launch and the sandbox's write restrictions. This is an inferred configuration limitation, not a measured OS result or proof that a sandbox is running.
- Secret-index facts describe existing stored statistics: not built, corrupt, incomplete or unavailable remain distinct. Checking these statistics does not scan credential sources or repair the index. Node compatibility is a runtime-version result, separate from an agent's platform-specific launch limitation.

Supported hook problems link to **Review current settings** for the relevant agent/scope. MCP and skill problems link to the corresponding current inventory. These destinations read current evidence; no fix is applied on navigation. Unsupported agents and index/runtime issues retain fixed terminal guidance in collapsed details rather than a fictitious repair button.

Navigation requires the selected run's workspace/policy/runtime provenance to match the current control context and its platform workspace identity to match the local connection. These are different identity schemes: diagnostic provenance binds canonical path and inode, while the platform's opaque workspace ID names its selected canonical path. Neither is inferred from the other by truncating a hash. Matching run context still does not cover every diagnostic input or prove today's configuration; the report stays recorded evidence with its timestamp and rerun action.

The CLI keeps report `version:1`, `ok`, `detail` and exit semantics, adding `diagnosticsVersion:1` and `check.diagnostic`. The console accepts only known kind/code/scope/agent/client combinations with bounded unique observations. A declared typed report must contain valid metadata for every check; invalid or partial metadata cannot silently downgrade to legacy success. Old derived reports remain readable without migration or invented reasons. Their rows show **Recorded OK** or **Recorded issue** and disclose that reason/scope was not captured.

The public projection retains only fixed labels, finite facts, booleans, counts and existing run provenance. Raw CLI detail, file paths, commands, key material, server/skill names and source values are excluded. It uses the existing private, unencrypted 32-run / 8 MiB workspace history without automatic expiry, not a second store. Missing engine schema adapters do not prevent console startup: legacy projection stays available, while new typed reports are refused until the adapter is built. No new configuration writer or provider operation is exposed.

Tests use fixtures and render the page with mocked components. They do not establish browser layout, keyboard behavior or native-host enforcement.
